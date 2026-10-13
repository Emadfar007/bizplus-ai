import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startServer } from '../src/app.js';
import { isPublicAddress, publicHttpsUrl } from '../src/live/network.js';
import { parseTargets } from '../src/live/monitor.js';
import type { LiveRun, LiveTarget } from '@bizplus/shared';
import { Store } from '../src/database/store.js';
import type { DataStore } from '../src/database/types.js';

const target: LiveTarget = { id: 'owned-store', name: 'Owned store', url: 'https://shop.example.com/', expectedStatus: 200, containsText: 'In stock' };
test('Live target restrictions reject credentials, local networks, reserved IPs and arbitrary protocols', () => {
  for (const ip of ['127.0.0.1','10.0.0.2','172.16.1.1','192.168.1.1','169.254.169.254','100.64.0.1','192.0.2.1','198.18.0.1','203.0.113.1','::1','::ffff:127.0.0.1','2001:db8::1','fc00::1','fe80::1']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['1.1.1.1','8.8.8.8','2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
  for (const url of ['http://example.com/','https://localhost/','https://127.1/','https://2130706433/','https://user:secret@example.com/','https://example.com:8443/','https://example.com/?api_key=secret','https://site.internal/']) assert.throws(() => publicHttpsUrl(url), undefined, url);
  assert.equal(publicHttpsUrl('https://example.com/status').hostname, 'example.com');
  assert.throws(() => parseTargets(JSON.stringify([{ ...target, url: 'http://localhost/' }])));
  assert.throws(() => parseTargets(JSON.stringify([target,target])));
  assert.throws(() => parseTargets(JSON.stringify([{ ...target, method: 'POST' }])));
});
test('A transient running-state write failure becomes a terminal live failure and releases the session', async () => {
  const stored = new Store(':memory:'); let writes = 0;
  const store = new Proxy(stored, { get(target, property) {
    if (property === 'saveLiveRun') return async (session: string, run: LiveRun) => { if (++writes === 2) throw new Error('Transient database interruption'); stored.saveLiveRun(session,run); };
    const value = Reflect.get(target,property); return typeof value === 'function' ? value.bind(target) : value;
  } }) as DataStore;
  const runtime = await startServer({ port: 0, store, live: { targets:[target], fetcher: async url => ({ httpStatus:200,body:'In stock',responseBytes:8,finalUrl:url,contentType:'text/plain' }) } });
  const session = randomUUID();
  const headers = { 'X-Demo-Session':session, 'Content-Type':'application/json' };
  try {
    const first = await fetch(`${runtime.baseUrl}/api/live/runs`,{ method:'POST',headers,body:JSON.stringify({targetId:target.id}) }); assert.equal(first.status,202);
    const {runId} = await first.json() as {runId:string}; await runtime.liveMonitor.drain();
    const failed = await store.getLiveRun(runId,session); assert.equal(failed?.status,'failed'); assert.match(failed?.error ?? '',/Transient/);
    const second = await fetch(`${runtime.baseUrl}/api/live/runs`,{ method:'POST',headers,body:JSON.stringify({targetId:target.id}) }); assert.equal(second.status,202);
    await runtime.liveMonitor.drain();
  } finally { await runtime.close(); }
});
test('Live HTTPS checks retain measured assertions, fingerprint failures, isolate sessions and reject arbitrary URL requests', async () => {
  let fail = false; let release: (() => void) | undefined; let gated = false;
  const runtime = await startServer({ port: 0, databasePath: ':memory:', sandboxLatencyMs: 0, live: { targets: [target], fetcher: async url => {
    assert.equal(url,target.url);
    if (gated) await new Promise<void>(resolve => { release = resolve; });
    return { httpStatus: 200, body: fail ? '<title>Store</title>Unavailable' : '<title>Store</title>In stock', responseBytes: 40, finalUrl: url, contentType: 'text/html' };
  } } });
  const session = randomUUID(); const other = randomUUID();
  async function call(path: string, body?: unknown, demoSession = session) {
    const response = await fetch(`${runtime.baseUrl}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Demo-Session': demoSession, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  async function run(): Promise<LiveRun> {
    const result = await call('/api/live/runs',{ targetId: target.id }); assert.equal(result.status,202);
    for (let i=0;i<60;i++) { const current = await call(`/api/live/runs/${result.data.runId}`); if (['passed','failed'].includes(current.data.status)) return current.data as LiveRun; await new Promise(resolve => setTimeout(resolve,10)); }
    throw new Error('Live run did not complete');
  }
  try {
    const passed = await run(); assert.equal(passed.status,'passed'); assert.equal(passed.httpStatus,200); assert.equal(passed.evidence.title,'Store'); assert.equal(passed.assertions.length,3);
    assert.equal((await call(`/api/live/runs/${passed.id}`,undefined,other)).status,404);
    assert.equal((await call('/api/live/runs',undefined,other)).data.runs.length,0);
    fail = true; const failed = await run(); const recurring = await run(); assert.equal(failed.status,'failed'); assert.equal(failed.fingerprint,recurring.fingerprint); assert.equal(failed.assertions.find(item=>item.code==='EXPECTED_CONTENT')?.passed,false);
    assert.equal((await call('/api/live/runs',{url:'https://example.com/'})).status,400);
    assert.equal((await call('/api/live/runs',{targetId:'not-owned'})).status,400);
    gated = true; const first = await call('/api/live/runs',{targetId:target.id}); assert.equal(first.status,202);
    const second = await call('/api/live/runs',{targetId:target.id}); assert.equal(second.status,409);
    for (let i=0;i<50&&!release;i++) await new Promise(resolve=>setTimeout(resolve,5)); release?.();
    await runtime.liveMonitor.drain();
    assert.equal((await call('/api/live/runs')).data.runs.length,4);
  } finally { release?.(); await runtime.close(); }
});
