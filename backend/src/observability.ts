import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Assertion, ObserverCheckKey } from '@bizplus/shared';
import type { DataStore } from './database/types.js';
import type { CommerceOptions } from './commerce/routes.js';
import { razorpayTransport } from './commerce/razorpay.js';
import { publicHttpsUrl } from './live/network.js';
import type { ErrorReporter } from './incidents/reporting.js';

export interface ObserverOptions { url?: string; token?: string; allowLocal?: boolean }
export function observerConnection(options: ObserverOptions = {}) {
  const input = options.url ?? process.env.OBSERVER_URL;
  if (!input) return null;
  const candidate = new URL(input);
  if (!(options.allowLocal ?? process.env.OBSERVER_ALLOW_LOCAL === 'true') || !['127.0.0.1', 'localhost'].includes(candidate.hostname)) publicHttpsUrl(input);
  else if (candidate.protocol !== 'http:' || candidate.username || candidate.password || candidate.search || candidate.hash) throw new Error('Local observer needs an explicit loopback HTTP origin.');
  if (candidate.pathname !== '/') throw new Error('OBSERVER_URL must be an origin.');
  const url = candidate.origin;
  const token = options.token ?? process.env.OBSERVER_TOKEN;
  return {
    url,
    async request(path: '/api/status' | '/api/browser-probe', session?: string) {
      const response = await fetch(`${url}${path}`, {
        method: session ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(session ? 20000 : 10000),
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Observer-Token': token } : {}) },
        ...(session ? { body: JSON.stringify({ sessionId: session }) } : {}),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Independent observer returned HTTP ${response.status}.`); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Independent observer returned an empty response.');
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        for (;;) {
          const result = await reader.read(); if (result.done) break;
          bytes += result.value.byteLength;
          if (bytes > 256 * 1024) throw new Error('Independent observer response exceeded its inspection limit.');
          chunks.push(result.value);
        }
      } finally { await reader.cancel(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    },
    async probe(session: string) {
      const result = await this.request('/api/browser-probe', session);
      if (!Array.isArray(result.assertions) || !Array.isArray(result.evidence)) throw new Error('Independent observer returned an invalid browser result.');
      const assertions = result.assertions as Assertion[];
      if (assertions.length > 30 || assertions.some(a => typeof a.code !== 'string' || typeof a.passed !== 'boolean' || typeof a.expected !== 'string' || typeof a.actual !== 'string')) throw new Error('Independent observer returned invalid browser assertions.');
      if (!assertions.length) throw new Error('Independent observer returned no browser assertions.');
      return { assertions, ...(result.manualVerificationRequired === true ? { manualVerificationRequired: true } : {}), evidence: result.evidence.slice(0,30).filter((value): value is string => typeof value === 'string').map(message => ({ id: randomUUID(), kind: 'log' as const, timestamp: new Date().toISOString(), message: message.slice(0,1200) })) };
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const observerPaths: Record<string, string> = {
  availability: '/health', readiness: '/ready', storefront: '/shop',
  storefront_browser: '/api/live/observer/storefront-browser', synthetic_workflow: '/api/live/observer/synthetic-workflow',
};
type ObserverCheck = { id: string; key: ObserverCheckKey; status: 'passed' | 'failed' | 'monitor_error'; completedAt: string; assertions: Assertion[] };
function checkedSnapshot(value: Record<string, unknown>): ObserverCheck[] {
  if (!Array.isArray(value.checks) || value.checks.length > 20) throw new Error('Invalid observer check snapshot.');
  return value.checks.map((candidate: unknown) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('Invalid observer check.');
    const item = candidate as Record<string, unknown>;
    if (typeof item.id !== 'string' || !UUID.test(item.id) || typeof item.key !== 'string' || !Object.hasOwn(observerPaths, item.key) || !['passed','failed','monitor_error'].includes(String(item.status)) || typeof item.completedAt !== 'string' || !Number.isFinite(Date.parse(item.completedAt)) || !Array.isArray(item.assertions) || item.assertions.length > 30 || item.assertions.some((assertion: unknown) => !assertion || typeof assertion !== 'object' || Array.isArray(assertion) || typeof (assertion as Assertion).code !== 'string' || !/^[A-Z0-9_]{1,80}$/.test((assertion as Assertion).code) || typeof (assertion as Assertion).passed !== 'boolean')) throw new Error('Invalid observer check.');
    if (item.status === 'passed' && (!item.assertions.length || item.assertions.some((assertion: unknown) => !(assertion as Assertion).passed))) throw new Error('Unverified observer pass.');
    if (item.status === 'failed' && (!item.assertions.length || item.assertions.every((assertion: unknown) => (assertion as Assertion).passed))) throw new Error('Unverified observer failure.');
    return { ...item, completedAt:new Date(item.completedAt).toISOString() } as unknown as ObserverCheck;
  });
}

export interface ObservabilityOptions { errorReporter?: ErrorReporter; observerCacheMs?: number }
export function registerObservability(app: Express, store: DataStore, commerce: CommerceOptions, observer: ReturnType<typeof observerConnection>, options: ObservabilityOptions = {}) {
  const unavailableEvents = new Map<string, string>();
  type ObservedSnapshot = { available:true; snapshot:Record<string,unknown>; checks:ObserverCheck[] } | { available:false };
  let observerCache: { expires:number; result:ObservedSnapshot } | null = null;
  let observerRead: Promise<ObservedSnapshot> | null = null;
  async function readObserver(): Promise<ObservedSnapshot> {
    if (!observer) return {available:false};
    if (observerCache && Date.now() < observerCache.expires) return observerCache.result;
    observerRead ??= (async (): Promise<ObservedSnapshot> => {
      try {
        const snapshot = await observer.request('/api/status');
        return {available:true,snapshot,checks:checkedSnapshot(snapshot)};
      } catch { return {available:false}; }
    })().then(result => { observerCache = {expires:Date.now()+Math.min(60_000,Math.max(0,options.observerCacheMs ?? 15_000)),result}; return result; }).finally(() => { observerRead = null; });
    return observerRead;
  }
  async function importObserverSnapshot(session: string, snapshot: Record<string, unknown>, checks: ObserverCheck[]) {
    const reporter = options.errorReporter;
    if (!reporter) return;
    // Import preserved history before latest checks. A main-app outage can end before
    // the app next reaches the observer, so latest checks alone lose that failure.
    if (Array.isArray(snapshot.incidents)) for (const candidate of snapshot.incidents.slice(0,100).reverse()) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const incident = candidate as Record<string, unknown>;
      if (typeof incident.id !== 'string' || !UUID.test(incident.id) || typeof incident.key !== 'string' || !Object.hasOwn(observerPaths,incident.key) || typeof incident.openedAt !== 'string' || !Number.isFinite(Date.parse(incident.openedAt)) || !['open','resolved'].includes(String(incident.status))) continue;
      const key = incident.key as ObserverCheckKey;
      const latest = checks.find(item => item.key === key);
      const knownFailure = latest?.status !== 'passed' ? latest : undefined;
      // Historical synthetic failures do not retain their failed assertion. Require
      // human review when authentication may have failed instead of inventing proof.
      const requiresManualLogin = knownFailure ? knownFailure.assertions.some(item => !item.passed && /LOGIN|AUTH/.test(item.code)) : key === 'synthetic_workflow';
      await reporter.report(session, {
        source:'observer', code:incident.failureKind === 'monitor_error' ? 'OBSERVER_MONITOR_ERROR' : 'OBSERVER_CHECK_FAILED',
        path:observerPaths[key], eventId:incident.id, observerCheckId:incident.id, observerIncidentId:incident.id, observerCheckKey:key,
        // Resolved history.lastSeenAt is the successful check time, not failure time.
        observedAt:new Date(incident.status === 'open' && typeof incident.lastSeenAt === 'string' && Number.isFinite(Date.parse(incident.lastSeenAt)) ? incident.lastSeenAt : incident.openedAt).toISOString(), ...(requiresManualLogin ? {requiresManualLogin:true} : {}),
      });
    }
    for (const check of checks) if (check.status !== 'passed') {
      await reporter.report(session, {
        source:'observer', code:check.status === 'monitor_error' ? 'OBSERVER_MONITOR_ERROR' : 'OBSERVER_CHECK_FAILED',
        path:observerPaths[check.key], eventId:check.id, observerCheckId:check.id, observerCheckKey:check.key,
        observedAt:check.completedAt,
        ...(check.assertions.some(item => !item.passed && /LOGIN|AUTH/.test(item.code)) ? {requiresManualLogin:true} : {}),
      });
    }
    const now = new Date().toISOString();
    for (const incident of (await store.listIncidents(session)).incidents) {
      const context = incident.application;
      if (incident.status === 'resolved' || context?.source !== 'observer' || context.requiresManualLogin) continue;
      if (context.code === 'OBSERVER_UNAVAILABLE') {
        // The status request just succeeded. This verifies observer connectivity,
        // independently of whether any monitored website check is passing.
        await reporter.resolve(session, incident.id, {source:'observer',observerCheckId:randomUUID()});
        continue;
      }
      const check = checks.find(item => item.key === context.observerCheckKey);
      if (!check || check.status !== 'passed' || check.id === context.observerCheckId || check.completedAt <= context.lastSeenAt || check.completedAt > now || check.assertions.some(item => !item.passed)) continue;
      // An open history record newer than the latest check is contradictory/stale
      // data, even if its UUID has already been imported. Keep the issue open.
      if (Array.isArray(snapshot.incidents) && snapshot.incidents.some(candidate => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
        const historical = candidate as Record<string,unknown>;
        return historical.key === check.key && historical.status === 'open' && typeof historical.lastSeenAt === 'string' && Date.parse(historical.lastSeenAt) >= Date.parse(check.completedAt);
      })) continue;
      await reporter.resolve(session, incident.id, {source:'observer',observerCheckId:check.id});
    }
  }
  // Readiness runs actual dependency reads. Its response never contains provider data or credentials.
  let cached: { expires: number; report: Record<string, unknown>; status: number } | null = null;
  let checking: Promise<{ report: Record<string, unknown>; status: number }> | null = null;
  async function inspect() {
    const components: { name: string; status: 'passed'|'failed'; code: string; message: string }[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.resolve().then(() => store.checkReadiness()), new Promise<never>((_,reject) => { timer = setTimeout(() => reject(new Error('Database readiness deadline exceeded')), 5000); })]);
      components.push({ name:'database', status:'passed', code:'DATABASE_READABLE', message:'The primary order and monitoring tables are readable.' });
    } catch {
      components.push({ name:'database', status:'failed', code:'DATABASE_UNAVAILABLE', message:'The primary database could not complete its readiness reads. Inspect database connection and query logs.' });
    } finally { clearTimeout(timer); }
    const keyId = commerce.keyId ?? process.env.RAZORPAY_KEY_ID ?? '';
    const secret = commerce.keySecret ?? process.env.RAZORPAY_KEY_SECRET ?? '';
    if (keyId.startsWith('rzp_test_') && secret) {
      try {
        await (commerce.providerTransport ?? razorpayTransport(keyId, secret, 5000))('GET','/orders');
        components.push({ name:'test_payment_provider', status:'passed', code:'PROVIDER_READABLE', message:'Razorpay Test Mode authenticated a read-only request. No order or payment was created.' });
      } catch {
        components.push({ name:'test_payment_provider', status:'failed', code:'PROVIDER_UNAVAILABLE', message:'The Test Mode provider rejected or could not complete a read. Check test credentials, connectivity, and provider status.' });
      }
    } else components.push({ name:'test_payment_provider', status:'failed', code:'PROVIDER_NOT_CONFIGURED', message:'Test checkout needs a Razorpay Test Mode key ID and secret.' });
    const status = components.every(component => component.status === 'passed') ? 200 : 503;
    return { status, report:{ status:status === 200 ? 'ready' : 'degraded', checkedAt:new Date().toISOString(), components, scope:'Database and Test Mode provider reads; browser interaction is checked by the independent observer.' } };
  }
  app.get('/ready', async (_request,response) => {
    if (!cached || Date.now() >= cached.expires) {
      checking ??= inspect().then(result => { cached = { ...result, expires:Date.now()+60000 }; return result; }).finally(() => { checking = null; });
      await checking;
    }
    response.setHeader('Cache-Control','no-store'); response.status(cached!.status).json(cached!.report);
  });
  async function synchronize(session: string) {
    if (!observer) return { enabled:false, available:false, message:'An independent observer has not been connected.' };
    const result = await readObserver();
    if (!result.available) {
      if (options.errorReporter) {
        // A lost observer is a monitoring failure. It establishes no website outage.
        if (!unavailableEvents.has(session)) unavailableEvents.set(session,randomUUID());
        await options.errorReporter.report(session, { source:'observer',code:'OBSERVER_UNAVAILABLE',path:'/api/live/observer',eventId:unavailableEvents.get(session) });
        if (unavailableEvents.size > 1000) unavailableEvents.delete(unavailableEvents.keys().next().value!);
      }
      return { enabled:true, available:false, url:observer.url, message:'The independent observer is unavailable or waking. Open its direct dashboard to inspect its status.' };
    }
    if (options.errorReporter) await importObserverSnapshot(session,result.snapshot,result.checks);
    unavailableEvents.delete(session);
    return { ...result.snapshot, enabled:true, available:true, url:observer.url };
  }
  const registerObserverProxy = function () {
    app.get('/api/live/observer', async (_request,response) => {
      response.json(await synchronize(String(response.locals.session)));
    });
  };
  registerObserverProxy.syncKnownFailures = async (session:string): Promise<void> => { await synchronize(session); };
  return registerObserverProxy;
}
