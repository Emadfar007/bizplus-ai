import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import type { LiveTarget } from '@bizplus/shared';
import { Store } from '../src/database/store.js';
import { createErrorReporter } from '../src/incidents/reporting.js';
import { LiveMonitor } from '../src/live/monitor.js';
import { registerObservability, type observerConnection } from '../src/observability.js';

const target: LiveTarget = {id:'owned-contract',name:'Owned contract',url:'https://shop.example.com/shop',expectedStatus:200,containsText:'ready'};

test('HTTP 200 live assertion failures appear in Investigation and require a new matching passing check to resolve', async () => {
  const store = new Store(':memory:'); const reporter = createErrorReporter(store);
  const session = randomUUID(); const other = randomUUID(); let healthy = false;
  const monitor = new LiveMonitor(store,[target],async url => ({httpStatus:200,body:healthy ? 'ready' : 'private-provider-payload',responseBytes:24,finalUrl:url,contentType:'text/plain'}),{errorReporter:reporter});
  try {
    const original = await monitor.start(session,target.id); await monitor.drain();
    const failed = await store.getLiveRun(original.id,session); assert.equal(failed?.status,'failed'); assert.equal(failed?.httpStatus,200);
    let incidents = (await store.listIncidents(session)).incidents;
    assert.equal(incidents.length,1); const incidentId = incidents[0]!.id;
    assert.equal(incidents[0]?.application?.source,'live'); assert.equal(incidents[0]?.application?.liveRunId,original.id);
    assert.equal(JSON.stringify(incidents).includes('private-provider-payload'),false);
    await monitor.syncKnownFailures(session); await monitor.syncKnownFailures(session);
    assert.equal((await store.listIncidents(session)).incidents[0]?.application?.occurrenceCount,1);
    assert.equal((await store.listIncidents(other)).incidents.length,0);
    assert.equal((await monitor.recover(session,original.id,false)).status,'failed');
    assert.equal((await store.getIncident(incidentId,session))?.status,'open');
    healthy = true;
    const recovered = await monitor.recover(session,original.id,false); assert.equal(recovered.status,'verified');
    incidents = (await store.listIncidents(session)).incidents;
    assert.equal(incidents.length,1); assert.equal(incidents[0]?.status,'resolved');
    assert.equal(incidents[0]?.application?.liveRunId,original.id,'The first failed live run remains linked.');
    assert.equal(incidents[0]?.application?.verification?.verificationRunId,recovered.verificationRunId);
    assert.equal((await store.getLiveRun(original.id,session))?.status,'failed','Recovery preserves original measured failure.');
    assert.equal((await store.getLiveRun(original.id,session))?.assertions.find(item=>item.code==='EXPECTED_CONTENT')?.passed,false);
  } finally { await monitor.drain(); await reporter.drain(); store.close(); }
});

test('a successful page GET cannot automatically recover a live authentication incident', async () => {
  const store = new Store(':memory:'); const reporter = createErrorReporter(store); const session = randomUUID(); let status = 401;
  const monitor = new LiveMonitor(store,[target],async url => ({httpStatus:status,body:'ready',responseBytes:5,finalUrl:url,contentType:'text/plain'}),{errorReporter:reporter});
  try {
    const original = await monitor.start(session,target.id); await monitor.drain();
    const incident = (await store.listIncidents(session)).incidents[0]!;
    assert.equal(incident.application?.requiresManualLogin,true);
    status = 200; const availability = await monitor.start(session,target.id); await monitor.drain();
    assert.equal((await store.getLiveRun(availability.id,session))?.status,'passed');
    await assert.rejects(monitor.recover(session,original.id,false),{code:'MANUAL_LOGIN_REQUIRED'});
    assert.equal(await reporter.resolve(session,incident.id,{source:'live',verificationRunId:availability.id}),false);
    assert.equal((await store.getIncident(incident.id,session))?.status,'open');
  } finally { await monitor.drain(); await reporter.drain(); store.close(); }
});

test('saved live incident pointers keep more than 128 failures idempotent across Investigation refreshes', async () => {
  const store=new Store(':memory:'); const reporter=createErrorReporter(store); const session=randomUUID();
  const monitor=new LiveMonitor(store,[target],async url=>({httpStatus:500,body:'Unavailable',responseBytes:11,finalUrl:url,contentType:'text/plain'}),{errorReporter:reporter});
  try {
    for (let index=0;index<135;index++) {await monitor.start(session,target.id);await monitor.drain();}
    assert.equal((await store.listIncidents(session)).incidents[0]?.application?.occurrenceCount,135);
    assert.ok((await store.listLiveRuns(session)).every(run=>run.investigationIncidentId));
    await monitor.syncKnownFailures(session);await monitor.syncKnownFailures(session);
    const incidents=(await store.listIncidents(session)).incidents;
    assert.equal(incidents.length,1);assert.equal(incidents[0]?.application?.occurrenceCount,135);
  } finally {await monitor.drain();await reporter.drain();store.close();}
});

function check(key: string, status: 'passed'|'failed'|'monitor_error', completedAt: string, code = 'HTTP_STATUS') {
  return {id:randomUUID(),key,status,completedAt,assertions:[{code,expected:'Passing contract',actual:'private-observer-message',passed:status==='passed'}],label:'private-observer-label',diagnosis:{summary:'private-observer-details'},evidence:['private-observer-evidence']};
}
async function observerHarness(initial: Record<string,unknown> = {checks:[],incidents:[]}, cacheMs = 0) {
  const store = new Store(':memory:'); const reporter = createErrorReporter(store); const app = express();
  let snapshot = initial; let unavailable = false; let reads = 0;
  const observer = {url:'https://observer.example.com',request:async () => { reads++; if (unavailable) throw new Error('private-observer-token'); return snapshot; },probe:async () => ({assertions:[],evidence:[]})} as unknown as NonNullable<ReturnType<typeof observerConnection>>;
  app.use((_req,res,next)=>{res.locals.session=_req.header('X-Demo-Session');next();});
  const register = registerObservability(app,store,{},observer,{errorReporter:reporter,observerCacheMs:cacheMs}); register();
  const server: Server = await new Promise(resolve => { const listening = app.listen(0,'127.0.0.1',()=>resolve(listening)); });
  const address = server.address(); assert.ok(address && typeof address!=='string'); const url=`http://127.0.0.1:${address.port}`;
  const session = randomUUID();
  return {store,reporter,register,session,setSnapshot(value:Record<string,unknown>){snapshot=value;},setUnavailable(value:boolean){unavailable=value;},reads:()=>reads,
    async poll(asSession=session){return (await fetch(`${url}/api/live/observer`,{headers:{'X-Demo-Session':asSession}})).json();},
    async close(){await reporter.drain();await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeIdleConnections();});store.close();}};
}

test('observer failures deduplicate per check and session; stale, different, or broken monitor checks cannot prove recovery', async () => {
  const before = new Date(Date.now()-20_000).toISOString(); const failed = check('availability','failed',before);
  const h = await observerHarness({checks:[failed],incidents:[]});
  try {
    assert.equal((await h.poll()).available,true); await h.poll(); await h.register.syncKnownFailures(h.session);
    let incidents = (await h.store.listIncidents(h.session)).incidents;
    assert.equal(incidents.length,1); assert.equal(incidents[0]?.application?.occurrenceCount,1);
    assert.equal(incidents[0]?.application?.observerCheckKey,'availability'); assert.equal(JSON.stringify(incidents).includes('private-'),false);
    const id=incidents[0]!.id; const other=randomUUID(); await h.poll(other);
    assert.equal((await h.store.listIncidents(other)).incidents.length,1); assert.equal(await h.store.getIncident(id,other),null);
    h.setSnapshot({checks:[check('storefront','passed',new Date().toISOString())],incidents:[]}); await h.poll();
    assert.equal((await h.store.getIncident(id,h.session))?.status,'open');
    h.setSnapshot({checks:[check('availability','passed',new Date(Date.now()-30_000).toISOString())],incidents:[]}); await h.poll();
    assert.equal((await h.store.getIncident(id,h.session))?.status,'open');
    h.setSnapshot({checks:[check('availability','monitor_error',new Date(Date.now()-1000).toISOString(),'OBSERVER_INSPECTION')],incidents:[]}); await h.poll();
    assert.equal((await h.store.getIncident(id,h.session))?.status,'open');
    h.setSnapshot({checks:[check('availability','passed',new Date().toISOString())],incidents:[]}); await h.poll();
    assert.equal((await h.store.getIncident(id,h.session))?.status,'resolved');
    assert.equal((await h.store.getIncident(id,h.session))?.application?.verification?.source,'observer');
  } finally {await h.close();}
});

test('observer history imports an outage from app downtime, with fresh same-key proof preserved in Investigation', async () => {
  const openedAt=new Date(Date.now()-30_000).toISOString(); const id=randomUUID();
  const snapshot={checks:[check('availability','passed',new Date().toISOString())],incidents:[{id,key:'availability',status:'resolved',openedAt,lastSeenAt:openedAt,failureKind:'failed'}]};
  const h=await observerHarness(snapshot);
  try {
    await h.register.syncKnownFailures(h.session); await h.poll();
    const incidents=(await h.store.listIncidents(h.session)).incidents;
    assert.equal(incidents.length,1); assert.equal(incidents[0]?.status,'resolved'); assert.equal(incidents[0]?.application?.occurrenceCount,1);
    assert.equal(incidents[0]?.createdAt,openedAt); assert.ok(incidents[0]?.evidence.some(item=>item.kind==='recovery'));
  } finally {await h.close();}
});

test('observer login assertions remain manual and observer loss is distinct from a website failure', async () => {
  const h=await observerHarness();
  try {
    h.setUnavailable(true); assert.equal((await h.poll()).available,false); await h.poll();
    let incidents=(await h.store.listIncidents(h.session)).incidents;
    assert.equal(incidents.length,1); const unavailableId=incidents[0]!.id;
    assert.equal(incidents[0]?.application?.code,'OBSERVER_UNAVAILABLE'); assert.equal(incidents[0]?.application?.occurrenceCount,1);
    assert.equal(incidents[0]?.application?.observerCheckKey,undefined);
    h.setUnavailable(false); const login=check('synthetic_workflow','failed',new Date(Date.now()-10_000).toISOString(),'SYNTHETIC_LOGIN');
    h.setSnapshot({checks:[login],incidents:[]}); await h.poll();
    incidents=(await h.store.listIncidents(h.session)).incidents;
    assert.equal((await h.store.getIncident(unavailableId,h.session))?.status,'resolved');
    const manual=incidents.find(item=>item.application?.observerCheckKey==='synthetic_workflow')!;
    assert.equal(manual.application?.requiresManualLogin,true);
    h.setSnapshot({checks:[check('synthetic_workflow','passed',new Date().toISOString(),'SYNTHETIC_LOGIN')],incidents:[]}); await h.poll();
    assert.equal((await h.store.getIncident(manual.id,h.session))?.status,'open');
  } finally {await h.close();}
});

test('Investigation and observer proxy share one bounded fixed-origin status read', async () => {
  const h=await observerHarness({checks:[check('availability','failed',new Date(Date.now()-10_000).toISOString())],incidents:[]},15_000);
  try {
    await Promise.all([h.register.syncKnownFailures(h.session),h.poll(),h.register.syncKnownFailures(h.session)]);
    assert.equal(h.reads(),1); assert.equal((await h.store.listIncidents(h.session)).incidents.length,1);
    assert.equal((await h.store.listIncidents(h.session)).incidents[0]?.application?.occurrenceCount,1);
  } finally {await h.close();}
});
