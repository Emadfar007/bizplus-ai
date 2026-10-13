import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import type { Incident, Run, StepResult } from '@bizplus/shared';
import type { DataStore } from '../src/database/types.js';
import { Store } from '../src/database/store.js';
import { PostgresStore } from '../src/database/postgres.js';
import { Engine } from '../src/engine/workflow.js';
import { LiveMonitor } from '../src/live/monitor.js';
import { createErrorReporter } from '../src/incidents/reporting.js';

function journey(workflowId: string, status: 'passed'|'failed', durationMs: number): Run {
  const now=new Date().toISOString();
  return {id:randomUUID(),workflowId,scenario:workflowId==='manual-login'?'manual_login':'receipt_order_missing',status,createdAt:now,completedAt:now,durationMs,steps:[],incidentId:null,orderId:null,transactionId:null,amountMinor:0,paymentCount:0};
}
function recoveredIncident(run: Run, durationMs: number, manual: boolean): Incident {
  const now=new Date().toISOString();
  const step:StepResult={id:'verification',name:'Outcome verification',method:'GET',path:'/controlled-fixture',status:'passed',expected:'Verified original outcome',actual:'Verified original outcome',durationMs,httpStatus:200,startedAt:now,completedAt:now,assertions:[{code:'OUTCOME',expected:'Verified',actual:'Verified',passed:true}],evidence:[]};
  const incident:Incident={id:randomUUID(),runId:run.id,workflowId:run.workflowId,title:'Controlled metric fixture',status:'resolved',createdAt:now,resolvedAt:now,failedStepId:'original-failure',fingerprint:randomUUID(),diagnosis:{source:'rules',summary:'Measured recovery',observedFacts:[],possibleCauses:[],evidenceIds:[],recommendedAction:null,guidance:'Verified fixture'},evidence:[],recovery:null,relatedIncidentIds:[]};
  if(manual) {
    incident.login={source:'login',manualOnly:true};
    incident.manualRecovery={id:randomUUID(),status:'verified',actor:'human',attemptedAt:now,completedAt:now,durationMs,verification:step,evidence:[]};
  } else incident.recovery={id:randomUUID(),action:'resume_receipt_worker',status:'verified',approvedAt:now,completedAt:now,durationMs,originalOrderId:null,paymentCountBefore:0,paymentCountAfter:0,verification:step,evidence:[]};
  return incident;
}
async function verifyMixedMetrics(store:DataStore) {
  await store.initialize(); const session=randomUUID(); const other=randomUUID();
  const engine=new Engine(store,'controlled-metric-fixture',{stepTimeoutMs:5000},store.driver==='postgres'?'cloud':'local');
  const reporter=createErrorReporter(store);
  const native=[journey('commerce-checkout','passed',100),journey('commerce-checkout','failed',300),journey('manual-login','failed',200)];
  for(const run of native) await store.saveRun(session,run);
  await store.saveIncident(session,recoveredIncident(native[1]!,120,false));
  await store.saveIncident(session,recoveredIncident(native[2]!,80,true));
  await reporter.report(session,{source:'browser',code:'BROWSER_VALIDATION_ERROR',path:'/login',eventId:randomUUID()});
  await reporter.report(session,{source:'api',code:'INTERNAL_ERROR',path:'/api/shop/orders',httpStatus:500,eventId:randomUUID()});
  let healthy=false;
  const target={id:'metrics-website',name:'Metrics controlled website',url:'https://example.com/health',expectedStatus:200};
  const monitor=new LiveMonitor(store,[target],async url=>({httpStatus:healthy?200:503,body:'Measured response',responseBytes:17,finalUrl:url,contentType:'text/plain'}),{errorReporter:reporter});
  try {
    const live=await monitor.start(session,target.id);await monitor.drain();
    let metrics=await engine.metrics(session);
    assert.equal(metrics.totalRuns,3);assert.equal(metrics.passedRuns,1);assert.equal(metrics.failedRuns,2);
    assert.equal(metrics.averageDurationMs,200);assert.equal(metrics.successRate,33.3);
    assert.equal(metrics.openIncidents,3,'Open browser, API and live errors count even though they are not journeys.');
    assert.equal(metrics.verifiedRecoveries,2);assert.equal(metrics.averageRecoveryMs,100);
    assert.equal(metrics.recentRuns.filter(run=>run.workflowId==='application-errors').length,3);
    assert.equal(metrics.chart.length,3);assert.deepEqual(new Set(metrics.chart.map(point=>point.runId)),new Set(native.map(run=>run.id)));
    healthy=true;assert.equal((await monitor.recover(session,live.id,false)).status,'verified');
    metrics=await engine.metrics(session);
    assert.equal(metrics.verifiedRecoveries,3,'A resolved application error with monitor proof counts as verified.');
    assert.equal(metrics.openIncidents,2);assert.equal(metrics.averageRecoveryMs,100,'Untimed application verification cannot dilute measured recovery durations.');
    assert.equal(metrics.totalRuns,3);assert.equal(metrics.averageDurationMs,200);assert.equal(metrics.chart.length,3);
    const isolated=await engine.metrics(other);assert.equal(isolated.totalRuns,0);assert.equal(isolated.openIncidents,0);assert.equal(isolated.verifiedRecoveries,0);
    const onlyErrors=randomUUID();
    const result=await reporter.report(onlyErrors,{source:'observer',code:'OBSERVER_CHECK_FAILED',path:'/health',observerCheckKey:'availability',observerCheckId:randomUUID(),eventId:randomUUID()});
    assert.equal(await reporter.resolve(onlyErrors,result.incidentId,{source:'observer',observerCheckId:randomUUID()}),true);
    const appOnly=await engine.metrics(onlyErrors);
    assert.equal(appOnly.totalRuns,0);assert.equal(appOnly.passedRuns,0);assert.equal(appOnly.failedRuns,0);assert.equal(appOnly.averageDurationMs,0);
    assert.equal(appOnly.verifiedRecoveries,1);assert.equal(appOnly.averageRecoveryMs,0);assert.equal(appOnly.recentRuns.length,1);assert.deepEqual(appOnly.chart,[]);
  } finally {await monitor.drain();await reporter.drain();}
}

test('SQLite journey metrics exclude application errors while all-source verified recoveries retain measured durations',async()=>{
  const store=new Store(':memory:');try{await verifyMixedMetrics(store);}finally{store.close();}
});

async function freePort() {
  const listener=createServer();await new Promise<void>(resolveListen=>listener.listen(0,'127.0.0.1',resolveListen));
  const address=listener.address();assert.ok(address&&typeof address!=='string');
  await new Promise<void>(resolveClose=>listener.close(()=>resolveClose()));return address.port;
}
test('actual PostgreSQL has the same journey and application-recovery metric semantics',{skip:process.platform!=='win32',timeout:120_000},async()=>{
  const folder=await mkdtemp(join(tmpdir(),'bizplus-metrics-postgres-'));const port=await freePort();const password=randomUUID();
  const embedded=new EmbeddedPostgres({databaseDir:join(folder,'cluster'),port,user:'postgres',password,persistent:true,authMethod:'scram-sha-256',initdbFlags:['--encoding=UTF8','--locale=C'],onLog:()=>{},onError:()=>{}});
  let store:PostgresStore|undefined;
  try{
    await embedded.initialise();await embedded.start();await embedded.createDatabase('metrics_test');
    store=new PostgresStore(`postgresql://postgres:${password}@127.0.0.1:${port}/metrics_test`,{ssl:false});
    await verifyMixedMetrics(store);
  }finally{
    if(store)await store.close();await embedded.stop().catch(()=>{});
    assert.equal(dirname(resolve(folder)),resolve(tmpdir()));assert.ok(basename(folder).startsWith('bizplus-metrics-postgres-'));
    await rm(folder,{recursive:true,force:true});
  }
});
