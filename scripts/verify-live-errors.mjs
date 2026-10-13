import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';

const origin = (process.env.VERIFY_ORIGIN ?? 'http://127.0.0.1:3012').replace(/\/$/,'');
const output = process.env.VERIFY_OUTPUT ?? 'artifacts/verification/live-errors-local.json';
const faults = ['http_500','http_503','not_found','missing_content','empty_body','timeout','javascript_error','button_broken','login_401','payment_unavailable','database_unavailable'];
async function api(path, session, body) {
  const response = await fetch(`${origin}${path}`, { method:body ? 'POST':'GET', headers:{'X-Demo-Session':session,'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {}), signal:AbortSignal.timeout(45000) });
  const result = await response.json();
  assert.equal(response.ok,true,`${path}: ${response.status} ${JSON.stringify(result)}`); return result;
}
async function run(session) {
  const {runId} = await api('/api/live/runs',session,{targetId:'bizplus-fault-lab'});
  const deadline = Date.now()+45000;
  while (Date.now()<deadline) {
    const result = await api(`/api/live/runs/${runId}`,session);
    if (['passed','failed'].includes(result.status)) return result;
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  throw new Error('Live test did not finish');
}
const report = {origin,startedAt:new Date().toISOString(),baseline:null,faults:[],sessionIsolation:null,healthPreserved:null};
const baselineSession=randomUUID();
report.baseline=await run(baselineSession); assert.equal(report.baseline.status,'passed');
for (const fault of faults) {
  const session=randomUUID();
  const state=await api('/api/live/lab',session,{fault,approved:true});
  assert.equal(state.fault,fault); assert.equal(state.safety.isolated,true);
  const failure=await run(session);
  assert.equal(failure.status,'failed',fault);
  assert.equal(failure.incidentStatus,'open',fault);
  assert.ok(failure.diagnosis?.confirmedCause,`${fault} lacks an evidence-confirmed controlled cause`);
  assert.ok(failure.diagnosis.solutions.length>0);
  if (fault==='timeout') assert.ok(failure.durationMs>=12000,`Timeout finished too early: ${failure.durationMs}`);
  const recovery=await api(`/api/live/runs/${failure.id}/recover`,session,{approved:true});
  assert.equal(recovery.status,'verified',fault);
  const verification=await api(`/api/live/runs/${recovery.verificationRunId}`,session);
  assert.equal(verification.status,'passed',fault);
  const retained=await api(`/api/live/runs/${failure.id}`,session);
  assert.equal(retained.status,'failed'); assert.equal(retained.incidentStatus,'resolved');
  assert.equal(retained.recovery.verificationRunId,verification.id);
  report.faults.push({fault,state,failure,recovery,verification});
  console.log(`${fault}: detected -> diagnosed -> restored -> verified`);
}
const isolated=await api('/api/live/lab',randomUUID()); assert.equal(isolated.fault,'healthy'); report.sessionIsolation=true;
const health=await fetch(`${origin}/health`); assert.equal(health.status,200); report.healthPreserved=await health.json();
report.completedAt=new Date().toISOString();
await mkdir('artifacts/verification',{recursive:true}); await writeFile(output,JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:report.faults.length,total:faults.length,output,baseline:report.baseline.status}));
