import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Assertion } from '@bizplus/shared';
import type { DataStore } from './database/types.js';
import type { CommerceOptions } from './commerce/routes.js';
import { razorpayTransport } from './commerce/razorpay.js';
import { publicHttpsUrl } from './live/network.js';

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

export function registerObservability(app: Express, store: DataStore, commerce: CommerceOptions, observer: ReturnType<typeof observerConnection>) {
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
  return function registerObserverProxy() {
    app.get('/api/live/observer', async (_request,response) => {
      if (!observer) { response.json({ enabled:false, available:false, message:'An independent observer has not been connected.' }); return; }
      try { response.json({ ...(await observer.request('/api/status')), enabled:true, available:true, url:observer.url }); }
      catch { response.json({ enabled:true, available:false, url:observer.url, message:'The independent observer is unavailable or waking. Open its direct dashboard to inspect its status.' }); }
    });
  };
}
