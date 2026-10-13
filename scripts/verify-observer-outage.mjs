import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

// Only dedicated local processes created by this script are interrupted.
const token=randomBytes(32).toString('hex');
const target='http://127.0.0.1:3014', observer='http://127.0.0.1:3015';
const children=[];
function start(file,env) { const child=spawn(process.execPath,[file],{windowsHide:true,stdio:'ignore',env:{...process.env,...env}}); children.push(child); return child; }
async function until(operation,message) {
  const deadline=Date.now()+45000;
  while(Date.now()<deadline) { try {const result=await operation();if(result)return result;}catch{} await new Promise(resolve=>setTimeout(resolve,250)); }
  throw Error(message);
}
const apiEnv={LOCAL_ERRORS_PORT:'3014',LOCAL_ERRORS_DATABASE:'.local/live-outage-api.sqlite',LOCAL_OBSERVER_URL:observer};
const report={startedAt:new Date().toISOString(),target,observer};
let api;
try {
  api=start('scripts/local-monitor-fixture.mjs',apiEnv);
  start('observer/src/server.mjs',{BIZPLUS_ORIGIN:target,OBSERVER_ALLOW_LOCAL:'true',PORT:'3015',OBSERVER_TOKEN:token,OBSERVER_INTERVAL_MS:'1000',OBSERVER_JOURNEY_INTERVAL_MS:'86400000',OBSERVER_DATABASE_PATH:'.local/live-outage-observer.sqlite',OBSERVER_HISTORY_POLICY:'local'});
  await until(async()=>{const r=await fetch(`${target}/health`);return r.ok;},'Dedicated target did not start');
  const snapshot=async()=>await(await fetch(`${observer}/api/status`)).json();
  report.before=await until(async()=>{const s=await snapshot();return s.checks.some(c=>c.key==='availability'&&c.status==='passed')&&s;},'Observer did not observe initial availability');
  const identity=report.before.instanceId;
  api.kill(); await until(async()=>api.exitCode!==null||api.signalCode!==null,'Dedicated target process did not stop');
  report.during=await until(async()=>{const s=await snapshot();return s.checks.some(c=>c.key==='availability'&&c.status==='failed')&&s;},'Observer did not detect target outage');
  assert.equal(report.during.instanceId,identity);
  assert.equal((await fetch(`${observer}/health`)).status,200);
  const incident=report.during.incidents.find(i=>i.key==='availability'&&i.status==='open');assert.ok(incident);
  api=start('scripts/local-monitor-fixture.mjs',apiEnv);
  report.after=await until(async()=>{const s=await snapshot();return s.checks.some(c=>c.key==='availability'&&c.status==='passed')&&s.incidents.some(i=>i.id===incident.id&&i.status==='resolved')&&s;},'Observer did not verify target recovery');
  assert.equal(report.after.instanceId,identity);report.completedAt=new Date().toISOString();report.passed=true;
  await writeFile('artifacts/verification/observer-process-outage-local.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:true,observerSurvived:true,incidentOpened:true,recoveryVerified:true}));
} finally { for(const child of children) if(child.exitCode===null&&child.signalCode===null)child.kill(); }
