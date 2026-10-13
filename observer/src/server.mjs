import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { configuration, UUID } from './config.mjs';
import { ObserverStore } from './store.mjs';
import { BrowserProbes } from './browser.mjs';
import { httpCheck, browserCheck, syntheticCheck } from './checks.mjs';
import { dashboard } from './dashboard.mjs';

function authorized(header, token) {
  if (!token) return true;
  const supplied = Buffer.from(typeof header === 'string' ? header : ''); const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
async function body(req) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 1024) throw new Error('Request body exceeds 1 KB.'); }
  return JSON.parse(text || '{}');
}

export async function startObserver(options = {}) {
  const config = { ...configuration(options.env), ...options.config };
  const store = new ObserverStore(config.databasePath);
  const probes = options.probes ?? new BrowserProbes(config.origin);
  const instanceId = randomUUID(); const instanceStartedAt = new Date().toISOString(); const syntheticSession = randomUUID();
  let lastCompletedAt = null, lastJourneyAt = 0, timer, active, closed = false, storageError = null;
  const persist = item => { try { store.save(item); storageError = null; } catch { storageError = 'Observer could not persist check history. Inspect independent observer storage.'; } };
  async function cycle(forceJourney = false) {
    if (active || closed) return active;
    active = (async () => {
      const completed = await Promise.allSettled([
        httpCheck(config.origin, 'availability', '/health', config.requestTimeoutMs),
        httpCheck(config.origin, 'readiness', '/ready', config.requestTimeoutMs),
        httpCheck(config.origin, 'storefront', '/shop', config.requestTimeoutMs),
      ]);
      for (const result of completed) { if (result.status === 'fulfilled') persist(result.value); }
      lastCompletedAt = new Date().toISOString();
      if ((forceJourney || Date.now() - lastJourneyAt >= config.journeyIntervalMs) && !probes.busy) {
        lastJourneyAt = Date.now(); const started = Date.now();
        try { persist(browserCheck(await probes.storefront(), 'storefront_browser', 'Storefront browser journey', started)); }
        catch { /* A concurrent lab probe should not be reported as a site failure. */ }
        persist(await syntheticCheck(config.origin, syntheticSession, config.requestTimeoutMs));
        lastCompletedAt = new Date().toISOString();
      }
    })().catch(() => { storageError = 'Independent observer check cycle failed. Inspect observer logs and resources.'; }).finally(() => { active = undefined; });
    return active;
  }
  function snapshot() {
    return {
      status: storageError ? 'degraded' : 'ok', instanceId, instanceStartedAt,
      origin: config.origin, intervalMs: config.intervalMs, journeyIntervalMs: config.journeyIntervalMs,
      historyPolicy: config.historyPolicy, browser: probes.health, lastCompletedAt,
      checks: store.latest(), incidents: store.incidents(), ...(storageError ? { error: storageError } : {}),
      limitations: [
        'The observer runs separately from BizPlus and continues checking while the monitored app is unavailable.',
        `HTTP checks run every ${config.intervalMs / 1000} seconds while this observer instance is running; brief faults between checks can be missed.`,
        `Storefront browser and synthetic business journeys run every ${config.journeyIntervalMs / 1000} seconds; provider payments are never created.`,
        config.historyPolicy === 'temporary' ? 'This hosted observer uses temporary SQLite storage; redeploys or instance replacement may reset history. A persistent disk and always-on hosting are needed for durable 24/7 monitoring.' : 'SQLite history is local to this observer instance and retained for up to seven days or 1,000 checks.',
        'Free hosting may sleep when idle; independent hosting separates outages but does not guarantee uninterrupted 24/7 scheduling.',
        'External status, timeout, and browser failures identify observed symptoms; server logs or dependency evidence are required to confirm production root causes.',
      ],
    };
  }
  const server = createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };
    try {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
        return res.end(dashboard);
      }
      if (req.method === 'GET' && req.url === '/health') return send(storageError ? 503 : 200, { status: storageError ? 'degraded' : 'ok', app: 'BizPlus independent observer', instanceId, instanceStartedAt, browser: probes.health });
      if (req.method === 'GET' && req.url === '/api/status') return send(200, snapshot());
      if (req.method === 'POST' && ['/api/browser-probe', '/api/check'].includes(req.url)) {
        if (!authorized(req.headers['x-observer-token'], config.token)) return send(403, { code: 'OBSERVER_AUTH_REQUIRED', error: 'Observer authorization is required.' });
        if (req.url === '/api/check') { await cycle(true); return send(200, snapshot()); }
        const input = await body(req);
        if (!input || Array.isArray(input) || Object.keys(input).some(key => key !== 'sessionId') || typeof input.sessionId !== 'string' || !UUID.test(input.sessionId)) return send(400, { code: 'INVALID_SESSION', error: 'Provide only a valid sessionId UUID. Browser targets are fixed by the observer.' });
        try { return send(200, await probes.probe(input.sessionId)); }
        catch (error) { return send(error.code === 'BROWSER_BUSY' ? 409 : 500, { code: error.code || 'OBSERVER_ERROR', error: error.code === 'BROWSER_BUSY' ? error.message : 'The independent browser observer failed.' }); }
      }
      return send(404, { error: 'Endpoint not found.' });
    } catch { return send(400, { code: 'INVALID_REQUEST', error: 'Provide a valid JSON request body of at most 1 KB.' }); }
  });
  await new Promise((resolve, reject) => { server.listen(config.port, '0.0.0.0', resolve); server.once('error', reject); });
  // Scheduling lives in this independent process, independent of a browser tab.
  if (options.schedule !== false) {
    void cycle();
    timer = setInterval(() => { void cycle(); }, config.intervalMs);
  }
  return {
    server, store, probes, cycle, snapshot,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      closed = true; clearInterval(timer); await active;
      await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
      store.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const observer = await startObserver();
  console.log('Independent observer HTTP server and background checks started.');
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await observer.close(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
