import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startServer, type AppOptions } from '../src/app.js';
import { LAB_TARGET_ID, LAB_EXPECTED_CONTENT } from '../src/live/lab.js';
import { diagnoseLiveRun } from '../src/live/diagnosis.js';
import type { LiveFault, LiveLabState, LiveRun, LiveTarget } from '@bizplus/shared';

async function harness(options: AppOptions = {}) {
  const runtime = await startServer({ port: 0, databasePath: ':memory:', sandboxLatencyMs: 0, rateLimits: { reads: 10000, mutationsPerSession: 1000, mutationsPerIp: 10000 }, ...options, live: { targets: [], ...options.live } });
  const session = randomUUID();
  async function call(path: string, body?: unknown, useSession = session) {
    const response = await fetch(`${runtime.baseUrl}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Demo-Session': useSession, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  async function run(useSession = session): Promise<LiveRun> {
    const queued = await call('/api/live/runs', { targetId: LAB_TARGET_ID }, useSession); assert.equal(queued.status, 202);
    await runtime.liveMonitor.drain();
    const result = await call(`/api/live/runs/${queued.data.runId}`, undefined, useSession); assert.equal(result.status, 200);
    return result.data as LiveRun;
  }
  const inject = async (fault: LiveFault, useSession = session) => { const result = await call('/api/live/lab', { fault, approved: true }, useSession); assert.equal(result.status, 200); return result.data as LiveLabState; };
  return { runtime, session, call, run, inject };
}

test('Controlled HTTP faults create evidence-backed incidents and resolve only after a real clean recheck, preserving real endpoints', async () => {
  const h = await harness();
  try {
    const beforeHealth = await (await fetch(`${h.runtime.baseUrl}/health`)).json();
    const beforeOrders = await h.runtime.store.listCommerceOrders(h.session);
    const baseline = await h.run(); assert.equal(baseline.status, 'passed'); assert.equal(baseline.diagnosis, undefined);
    for (const [fault, status, failedCode] of [['http_500',500,'HTTP_STATUS'],['http_503',503,'HTTP_STATUS'],['not_found',404,'HTTP_STATUS'],['missing_content',200,'EXPECTED_CONTENT'],['empty_body',200,'RESPONSE_PRESENT']] as const) {
      const introduced = await h.inject(fault);
      const failed = await h.run(); assert.equal(failed.status, 'failed', fault); assert.equal(failed.httpStatus, status); assert.equal(failed.incidentStatus, 'open');
      assert.equal(failed.labRevision, introduced.revision); assert.equal(failed.assertions.find(item => item.code === failedCode)?.passed, false);
      assert.ok(failed.diagnosis?.confirmedCause, fault); assert.ok(failed.diagnosis?.solutions.length); assert.ok(failed.diagnosis!.evidenceIds.length);
      assert.ok(failed.evidence.events?.some(event => event.data?.observed === true && event.data?.fault === fault));
      assert.equal((await h.call(`/api/live/runs/${failed.id}/recover`, { approved: false })).status, 400);
      const recovery = await h.call(`/api/live/runs/${failed.id}/recover`, { approved: true }); assert.equal(recovery.status, 200); assert.equal(recovery.data.status, 'verified');
      const original = (await h.call(`/api/live/runs/${failed.id}`)).data as LiveRun; assert.equal(original.status, 'failed'); assert.equal(original.incidentStatus, 'resolved');
      assert.equal(original.recovery?.verificationRunId, recovery.data.verificationRunId);
      const verification = (await h.call(`/api/live/runs/${recovery.data.verificationRunId}`)).data as LiveRun; assert.equal(verification.status, 'passed');
      const duplicate = await h.call(`/api/live/runs/${failed.id}/recover`, { approved: true }); assert.equal(duplicate.data.verificationRunId, verification.id);
    }
    assert.deepEqual(await (await fetch(`${h.runtime.baseUrl}/health`)).json(), beforeHealth);
    assert.deepEqual(await h.runtime.store.listCommerceOrders(h.session), beforeOrders);
    const confirmation = await fetch(`${h.runtime.baseUrl}/test-site/${h.session}/api/confirmation`); assert.deepEqual(await confirmation.json(), { confirmed:true,synthetic:true,paymentCount:0 });
  } finally { await h.runtime.close(); }
});

test('A deliberately delayed real response exceeds twelve seconds and recovers without a fabricated timeout', { timeout: 20000 }, async () => {
  const h = await harness();
  try {
    await h.inject('timeout'); const started = performance.now(); const failed = await h.run();
    assert.equal(failed.status, 'failed'); assert.equal(failed.httpStatus, null); assert.match(failed.error ?? '', /timed out after 12 seconds/);
    assert.ok(performance.now() - started >= 11900); assert.ok(failed.durationMs >= 11900); assert.equal(failed.diagnosis?.category, 'timeout');
    assert.ok(failed.diagnosis?.confirmedCause); assert.equal(failed.assertions.find(item => item.code === 'REQUEST_COMPLETED')?.passed, false);
    const restored = await h.call(`/api/live/runs/${failed.id}/recover`, { approved:true }); assert.equal(restored.data.status, 'verified');
  } finally { await h.runtime.close(); }
});

test('Faults are isolated by session, strictly bounded by TTL and recovery cannot clear a newer fault', async () => {
  let now = Date.now();
  const h = await harness({ live: { targets: [], lab: { now: () => now, ttlMs: 1200000 } } });
  try {
    const other = randomUUID(); const state = await h.inject('http_500'); assert.equal(state.maxDurationSeconds, 120);
    assert.equal(Date.parse(state.expiresAt!) - now, 120000);
    assert.equal((await h.run(other)).status, 'passed');
    const failed = await h.run(); assert.equal((await h.call(`/api/live/runs/${failed.id}`, undefined, other)).status, 404);
    assert.equal((await h.call(`/api/live/runs/${failed.id}/recover`, {approved:true}, other)).status, 404);
    await h.inject('http_503'); const blocked = await h.call(`/api/live/runs/${failed.id}/recover`, {approved:true}); assert.equal(blocked.status,409); assert.equal(blocked.data.code,'LAB_FAULT_CHANGED');
    const newer = (await h.call('/api/live/lab')).data as LiveLabState; assert.equal(newer.fault,'http_503'); now += 120001;
    const expired = (await h.call('/api/live/lab')).data as LiveLabState; assert.equal(expired.fault,'healthy'); assert.equal(expired.expiresAt,null); assert.equal(expired.revision,newer.revision);
    assert.equal((await h.run()).status,'passed');
    assert.equal((await h.call('/api/live/lab',{fault:'http_500',approved:true,url:'https://example.com/'})).status,400);
    assert.equal((await h.call('/api/live/lab',{fault:'database_delete',approved:true})).status,400);
  } finally { await h.runtime.close(); }
});

test('Changing faults, starting another run and concurrent recovery are blocked while a session is being checked', async () => {
  let release: (() => void) | undefined; let block = false;
  const h = await harness({ live: { targets: [], browserProbe: async () => { if (block) await new Promise<void>(resolve => { release = resolve; }); return { assertions:[{code:'BROWSER_LOGIN',expected:'Signed in',actual:'Signed in',passed:true}],evidence:[] }; } } });
  try {
    await h.inject('http_500'); const failed = await h.run(); block = true;
    const recovery = h.call(`/api/live/runs/${failed.id}/recover`,{approved:true});
    for (let i=0;i<50&&!release;i++) await new Promise(resolve => setTimeout(resolve,10)); assert.ok(release);
    assert.equal((await h.call('/api/live/lab',{fault:'http_503',approved:true})).status,409);
    assert.equal((await h.call('/api/live/runs',{targetId:LAB_TARGET_ID})).status,409);
    assert.equal((await h.call(`/api/live/runs/${failed.id}/recover`,{approved:true})).status,409);
    release(); assert.equal((await recovery).data.status,'verified');
  } finally { release?.(); await h.runtime.close(); }
});

test('Browser monitor absence never passes an interaction fault or claims its cause was observed', async () => {
  const h = await harness();
  try {
    for (const fault of ['javascript_error','button_broken','login_401','database_unavailable','payment_unavailable'] as const) {
      await h.inject(fault); const run = await h.run(); assert.equal(run.status,'failed'); assert.equal(run.diagnosis?.category,'browser_monitor_unavailable'); assert.equal(run.diagnosis?.confirmedCause,null);
      assert.equal(run.assertions.find(item=>item.code==='BROWSER_JOURNEY_AVAILABLE')?.passed,false);
    }
  } finally { await h.runtime.close(); }
});

test('Browser assertion contracts and correlated dependency responses explain each controlled business failure; failed rechecks stay open', async () => {
  let baseUrl = ''; let observerUnavailable = false;
  // This is a contract test: actual Chromium verification is exercised separately by the independent observer suite.
  const h = await harness({ live: { targets: [], browserProbe: async session => {
    if (observerUnavailable) throw new Error('Independent observer offline.');
    const body = await (await fetch(`${baseUrl}/test-site/${session}`)).text();
    const assertions = [];
    if (body.includes("throw Error('Controlled JavaScript initialization error')")) return { assertions:[{code:'BROWSER_JAVASCRIPT',expected:'No errors',actual:'Controlled JavaScript initialization error',passed:false}], evidence:[] };
    if (!body.includes(".onclick=")) return { assertions:[{code:'BROWSER_LOGIN',expected:'Signed in',actual:'Signed out',passed:false}],evidence:[] };
    for (const [endpoint,code] of [['login','BROWSER_LOGIN'],['catalog','BROWSER_CART'],['confirmation','BROWSER_CONFIRMATION']]) {
      const response = await fetch(`${baseUrl}/test-site/${session}/api/${endpoint}`); const data = await response.json();
      assertions.push({code:code!,expected:'HTTP 200',actual:`HTTP ${response.status}`,passed:response.status===200});
      if (!response.ok) assert.equal(data.synthetic,true);
    }
    return {assertions,evidence:[]};
  } } }); baseUrl = h.runtime.baseUrl;
  try {
    assert.equal((await h.run()).status,'passed');
    for (const fault of ['javascript_error','button_broken','login_401','database_unavailable','payment_unavailable'] as const) {
      await h.inject(fault); const run = await h.run(); assert.equal(run.status,'failed'); assert.ok(run.diagnosis?.confirmedCause,fault);
      const recovery = await h.call(`/api/live/runs/${run.id}/recover`,{approved:true}); assert.equal(recovery.data.status,'verified');
    }
    await h.inject('http_500'); const failed = await h.run(); observerUnavailable = true;
    const recovery = await h.call(`/api/live/runs/${failed.id}/recover`,{approved:true}); assert.equal(recovery.data.status,'failed');
    const original = (await h.call(`/api/live/runs/${failed.id}`)).data as LiveRun; assert.equal(original.incidentStatus,'open');
    const verification = (await h.call(`/api/live/runs/${recovery.data.verificationRunId}`)).data as LiveRun; assert.equal(verification.diagnosis?.confirmedCause,null);
    observerUnavailable = false; const verified = await h.call(`/api/live/runs/${failed.id}/verify`,{approved:true}); assert.equal(verified.data.status,'verified');
  } finally { await h.runtime.close(); }
});

test('External website errors remain hypotheses, cannot be automatically mutated and are resolved by a fresh allowed GET only', async () => {
  const target: LiveTarget = {id:'owned-site',name:'Owned site',url:'https://example.com/status',expectedStatus:200,containsText:'ready'};
  let healthy = false; let calls = 0;
  const h = await harness({ live: { targets:[target],fetcher:async url => { assert.equal(url,target.url); calls++; const body = healthy ? 'ready' : 'unavailable'; return {httpStatus:healthy?200:503,body,responseBytes:body.length,finalUrl:url,contentType:'text/plain'}; } } });
  try {
    const queued = await h.call('/api/live/runs',{targetId:target.id}); await h.runtime.liveMonitor.drain(); const failed = (await h.call(`/api/live/runs/${queued.data.runId}`)).data as LiveRun;
    assert.equal(failed.diagnosis?.confirmedCause,null); assert.ok(failed.diagnosis?.possibleCauses.length); assert.ok(failed.diagnosis?.solutions.length);
    assert.equal((await h.call(`/api/live/runs/${failed.id}/recover`,{approved:true})).status,400); assert.equal(calls,1);
    assert.equal((await h.call(`/api/live/runs/${failed.id}/verify`,{approved:true})).data.status,'failed'); healthy = true;
    assert.equal((await h.call(`/api/live/runs/${failed.id}/verify`,{approved:true})).data.status,'verified'); assert.equal(calls,3);
    assert.equal((await h.call('/api/live/runs',{url:'http://127.0.0.1/admin'})).status,400);
  } finally { await h.runtime.close(); }
});

test('Empty response and unavailable browser categories do not falsely attribute arbitrary injected causes', () => {
  const run: LiveRun = { id:randomUUID(),targetId:LAB_TARGET_ID,url:'https://example.com/',status:'failed',httpStatus:200,durationMs:1,startedAt:new Date().toISOString(),completedAt:new Date().toISOString(),error:null,message:'failed',assertions:[{code:'RESPONSE_PRESENT',expected:'body',actual:'0',passed:false}],evidence:{responseBytes:0},fingerprint:null };
  assert.equal(diagnoseLiveRun(run).category,'empty_response'); assert.equal(diagnoseLiveRun(run,'http_500').confirmedCause,null);
  assert.ok(LAB_EXPECTED_CONTENT);
});

test('Restart evidence diagnoses a monitoring interruption rather than falsely asserting that the target website failed', () => {
  const timestamp = new Date().toISOString();
  const run: LiveRun = { id:randomUUID(),targetId:'owned-site',url:'https://example.com/',status:'failed',httpStatus:null,durationMs:1,startedAt:timestamp,completedAt:timestamp,error:'Interrupted by backend restart',message:'Interrupted',assertions:[{code:'REQUEST_COMPLETED',expected:'Check completed',actual:'Interrupted by backend restart',passed:false}],evidence:{responseBytes:0,events:[{id:randomUUID(),kind:'log',timestamp,message:'Recorded monitoring restart',data:{monitorRestarted:true}}]},fingerprint:null };
  const diagnosis = diagnoseLiveRun(run); assert.equal(diagnosis.category,'monitor_interrupted'); assert.ok(diagnosis.confirmedCause); assert.match(diagnosis.summary,/does not establish a website outage/);
  run.evidence.events = []; assert.equal(diagnoseLiveRun(run).confirmedCause,null);
  run.assertions = [{code:'REQUEST_COMPLETED',expected:'Response',actual:'request failed',passed:false}]; run.error = 'getaddrinfo ENOTFOUND example.com'; assert.equal(diagnoseLiveRun(run).category,'dns_error');
  run.error = 'CERT_HAS_EXPIRED'; assert.equal(diagnoseLiveRun(run).category,'tls_error');
});

test('Public test URLs require a session minted by the API and bound both request rate and delayed concurrency', async () => {
  const h = await harness();
  const controllers: AbortController[] = []; const pending: Promise<unknown>[] = [];
  try {
    // Unknown public GETs must never allocate the 200 available session slots.
    for (let i=0;i<205;i++) {
      const response = await fetch(`${h.runtime.baseUrl}/test-site/${randomUUID()}`); assert.equal(response.status,404); await response.body?.cancel();
    }
    const minted = await h.call('/api/live/lab'); assert.equal(minted.status,200);
    const healthy = await fetch(`${h.runtime.baseUrl}/test-site/${h.session}`); assert.equal(healthy.status,200); await healthy.body?.cancel();
    await h.inject('timeout');
    for (let i=0;i<5;i++) { const controller = new AbortController(); controllers.push(controller); pending.push(fetch(`${h.runtime.baseUrl}/test-site/${h.session}`,{signal:controller.signal}).catch(()=>null)); }
    await new Promise(resolve=>setTimeout(resolve,75));
    const blocked = await fetch(`${h.runtime.baseUrl}/test-site/${h.session}`); assert.equal(blocked.status,429); assert.equal((await blocked.json()).code,'LAB_REQUESTS_ACTIVE');
    controllers.forEach(controller=>controller.abort()); await Promise.all(pending); await new Promise(resolve=>setTimeout(resolve,25));
    await h.inject('healthy');
    let rateLimited = false;
    for (let i=0;i<50;i++) { const response = await fetch(`${h.runtime.baseUrl}/test-site/${h.session}`); if (response.status===429) { assert.equal((await response.json()).code,'LAB_RATE_LIMITED'); rateLimited=true;break; } await response.body?.cancel(); }
    assert.equal(rateLimited,true);
    assert.equal((await fetch(`${h.runtime.baseUrl}/health`)).status,200);
  } finally { controllers.forEach(controller=>controller.abort()); await Promise.allSettled(pending); await h.runtime.close(); }
});

test('Expired or restarted browser incidents cannot resolve through an HTTP-only verification', async () => {
  let now = Date.now(); const h = await harness({ live:{ targets:[],lab:{now:()=>now,ttlMs:1000} } });
  try {
    const state = await h.inject('button_broken'); const original = await h.run(); assert.equal(original.incidentStatus,'open');
    now += 1001; assert.equal((await h.call('/api/live/lab')).data.fault,'healthy');
    const expiredVerification = await h.call(`/api/live/runs/${original.id}/verify`,{approved:true}); assert.equal(expiredVerification.data.status,'failed');
    let incident = (await h.call(`/api/live/runs/${original.id}`)).data as LiveRun; assert.equal(incident.incidentStatus,'open');
    const verification = (await h.call(`/api/live/runs/${expiredVerification.data.verificationRunId}`)).data as LiveRun; assert.equal(verification.diagnosis?.category,'browser_monitor_unavailable');
    // A fresh process re-mints a new lab revision; simulate the persisted old revision against that fresh healthy state.
    await h.inject('healthy'); assert.notEqual((await h.call('/api/live/lab')).data.revision,state.revision);
    const staleRestore = await h.call(`/api/live/runs/${original.id}/recover`,{approved:true}); assert.equal(staleRestore.status,409);
    const restartVerification = await h.call(`/api/live/runs/${original.id}/verify`,{approved:true}); assert.equal(restartVerification.data.status,'failed');
    incident = (await h.call(`/api/live/runs/${original.id}`)).data as LiveRun; assert.equal(incident.incidentStatus,'open');
    const baseline = await h.run(); assert.equal(baseline.status,'passed'); assert.match(baseline.message,/HTTP baseline/);
  } finally { await h.runtime.close(); }
});
