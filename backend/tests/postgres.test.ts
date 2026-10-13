import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { mkdtemp,readFile,rm,mkdir,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename,dirname,join,resolve } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import EmbeddedPostgres from 'embedded-postgres';
import { Client } from 'pg';
import { PostgresStore } from '../src/database/postgres.js';
import { Store } from '../src/database/store.js';
import { startServer } from '../src/app.js';
import { copySnapshot,readSnapshot } from '../scripts/sqlite-snapshot.js';
import type { CommerceOrder,LiveRun,Run,Scenario } from '@bizplus/shared';

async function freePort(): Promise<number> {
  const server = createServer(); await new Promise<void>(resolveListen=>server.listen(0,'127.0.0.1',resolveListen));
  const address=server.address(); assert.ok(address&&typeof address!=='string'); const port=address.port;
  await new Promise<void>(resolveClose=>server.close(()=>resolveClose())); return port;
}
type Runtime=Awaited<ReturnType<typeof startServer>>;
async function request(runtime:Runtime,session:string,path:string,body?:unknown){
  return fetch(`${runtime.baseUrl}${path}`,{method:body===undefined?'GET':'POST',headers:{'X-Demo-Session':session,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
async function runScenario(runtime:Runtime,session:string,scenario:Scenario):Promise<Run>{
  const response=await request(runtime,session,'/api/runs',{scenario}); assert.equal(response.status,202);
  const {runId}=await response.json();
  for(let attempt=0;attempt<300;attempt++){
    const result=await(await request(runtime,session,`/api/runs/${runId}`)).json() as Run;
    if(['passed','failed'].includes(result.status))return result;
    await delay(10);
  }
  throw new Error('PostgreSQL-backed workflow did not finish');
}

test('actual PostgreSQL primary persistence, migrations, concurrency, isolation, and restart',{skip:process.platform!=='win32',timeout:120_000},async()=>{
  const folder=await mkdtemp(join(tmpdir(),'bizplus-postgres-'));
  const port=await freePort(); const password=randomUUID();
  const embedded=new EmbeddedPostgres({databaseDir:join(folder,'cluster'),port,user:'postgres',password,persistent:true,authMethod:'scram-sha-256',initdbFlags:['--encoding=UTF8','--locale=C'],onLog:()=>{},onError:()=>{}});
  const connection=`postgresql://postgres:${password}@127.0.0.1:${port}/bizplus_test`;
  let runtime:Runtime|undefined; let activeStore:PostgresStore|undefined;
  const checks:string[]=[]; const started=performance.now();
  try{
    await embedded.initialise(); await embedded.start(); await embedded.createDatabase('bizplus_test');
    activeStore=new PostgresStore(connection,{ssl:false});
    await activeStore.pool.query('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;');
    runtime=await startServer({port:0,store:activeStore,sandboxLatencyMs:0,live:{targets:[]}});
    assert.equal(runtime.engine.health.historyPolicy,'cloud'); assert.equal(runtime.store.driver,'postgres'); checks.push('PostgreSQL primary selected and reports cloud history');
    const privileges=(await activeStore.pool.query("SELECT has_schema_privilege('anon','bizplus','USAGE') AS anon_schema,has_table_privilege('anon','bizplus.runs','SELECT') AS anon_table,has_schema_privilege('authenticated','bizplus','USAGE') AS authenticated_schema")).rows[0];
    assert.equal(privileges.anon_schema,false);assert.equal(privileges.anon_table,false);assert.equal(privileges.authenticated_schema,false);
    const tables=(await activeStore.pool.query("SELECT relname,relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='bizplus' AND relkind='r'")).rows;
    assert.equal(tables.length,9);assert.ok(tables.every(row=>row.relrowsecurity));checks.push('Nine private tables deny Data API roles and enable RLS');
    const session=randomUUID();const other=randomUUID();
    const healthy=await runScenario(runtime,session,'healthy');assert.equal(healthy.status,'passed');assert.equal(healthy.paymentCount,1);
    const missing=await runScenario(runtime,session,'receipt_order_missing');assert.equal(missing.status,'failed');assert.equal(missing.steps[4]?.httpStatus,200);assert.equal(missing.paymentCount,1);
    const error=await runScenario(runtime,session,'checkout_500');assert.equal(error.paymentCount,0);assert.equal(error.steps[4]?.status,'skipped');checks.push('All three actual HTTP scenarios satisfy expected payment and outcome assertions');
    const repeated=await Promise.all(Array.from({length:5},()=>activeStore!.checkout(healthy.id,false)));
    assert.ok(repeated.every(row=>row.order_id===healthy.orderId));assert.equal(await activeStore.paymentCount(healthy.id),1);checks.push('Concurrent checkout retries return one original payment');
    const approved={action:'resume_receipt_worker',approved:true};
    const recoveries=await Promise.all([request(runtime,session,`/api/incidents/${missing.incidentId}/recover`,approved),request(runtime,session,`/api/incidents/${missing.incidentId}/recover`,approved)]);
    const recovered=await Promise.all(recoveries.map(r=>r.json()));assert.ok(recovered.every(r=>r.status==='verified'&&r.paymentCountAfter===1));assert.equal(recovered[0].id,recovered[1].id);checks.push('Concurrent approved recovery is idempotent with one payment');
    assert.equal((await request(runtime,other,`/api/runs/${healthy.id}`)).status,404);assert.equal((await request(runtime,other,`/api/incidents/${missing.incidentId}`)).status,404);checks.push('Cloud monitoring reads remain session isolated');
    const now=new Date().toISOString();const commerce:CommerceOrder={id:randomUUID(),checkoutKey:randomUUID(),status:'paid',items:[{productId:'fixture-product',name:'Fixture product',quantity:1,unitAmountMinor:1000,lineAmountMinor:1000}],amountMinor:1000,currency:'INR',razorpayOrderId:'order_PgFixtureOnly',razorpayPaymentId:'pay_PgFixtureOnly',createdAt:now,updatedAt:now,paidAt:now};
    await activeStore.saveCommerceOrder(session,commerce);assert.deepEqual(await activeStore.getCommerceOrder(commerce.id,session),commerce);assert.equal(await activeStore.getCommerceOrder(commerce.id,other),null);assert.equal((await activeStore.getCommerceOrderByCheckoutKey(session,commerce.checkoutKey))?.id,commerce.id);assert.equal((await activeStore.getCommerceOrderByProviderId(commerce.razorpayOrderId!))?.session,session);
    await assert.rejects(activeStore.saveCommerceOrder(session,{...commerce,id:randomUUID(),razorpayOrderId:'order_PgOtherFixture',razorpayPaymentId:null}));
    await assert.rejects(activeStore.saveCommerceOrder(other,{...commerce,id:randomUUID(),checkoutKey:randomUUID()}));checks.push('Commerce order keys/provider IDs are unique and lookups preserve ownership');
    const live:LiveRun={id:randomUUID(),targetId:'fixture-target',url:'https://example.com/',status:'running',httpStatus:null,durationMs:0,startedAt:now,completedAt:null,error:null,message:'Fixture in-progress website check',assertions:[],evidence:{responseBytes:0},fingerprint:null};await activeStore.saveLiveRun(session,live);
    const instance=runtime.engine.health.instanceId;await runtime.close();runtime=undefined;activeStore=new PostgresStore(connection,{ssl:false});runtime=await startServer({port:0,store:activeStore,sandboxLatencyMs:0,live:{targets:[]}});
    assert.notEqual(runtime.engine.health.instanceId,instance);assert.equal((await activeStore.getIncident(missing.incidentId!,session))?.status,'resolved');assert.deepEqual(await activeStore.getCommerceOrder(commerce.id,session),commerce);assert.equal((await activeStore.getLiveRun(live.id,session))?.status,'failed');assert.equal(await activeStore.paymentCount(missing.id),1);checks.push('API restart retains cloud data and finalizes interrupted live checks');
    const sourcePath=join(folder,'source.sqlite');const source=await startServer({port:0,databasePath:sourcePath,sandboxLatencyMs:0,live:{targets:[]}});
    const migratedSession=randomUUID();const sourceRun=await runScenario(source,migratedSession,'receipt_order_missing');await source.store.saveCommerceOrder(migratedSession,{...commerce,id:randomUUID(),checkoutKey:randomUUID(),razorpayOrderId:'order_MigrationFixture',razorpayPaymentId:'pay_MigrationFixture'});await source.close();
    const originalHash=createHash('sha256').update(await readFile(sourcePath)).digest('hex');const snapshot=readSnapshot(sourcePath);const first=await copySnapshot(activeStore.pool,snapshot);const second=await copySnapshot(activeStore.pool,snapshot);
    assert.equal(first.runs,1);assert.equal(first.payments,1);assert.ok(Object.values(second).every(count=>count===0));assert.equal((await activeStore.getRun(sourceRun.id,migratedSession))?.orderId,sourceRun.orderId);assert.equal(await activeStore.paymentCount(sourceRun.id),1);assert.equal((await activeStore.listCommerceOrders(migratedSession)).length,1);assert.equal(createHash('sha256').update(await readFile(sourcePath)).digest('hex'),originalHash);checks.push('Read-only SQLite import retains ledger/order IDs, is repeatable, and preserves source file hash');
    const bad=new PostgresStore(`postgresql://postgres:fixture@127.0.0.1:${await freePort()}/unreachable`,{ssl:false});await assert.rejects(startServer({port:0,store:bad,live:{targets:[]}}));checks.push('Configured PostgreSQL failure stops startup without SQLite failover');
    const evidencePath=fileURLToPath(new URL('../../artifacts/verification/postgres-local.json',import.meta.url));await mkdir(dirname(evidencePath),{recursive:true});await writeFile(evidencePath,JSON.stringify({status:'passed',scope:'Actual temporary Windows PostgreSQL 18 instance, not hosted Supabase verification',checks,durationMs:Math.round(performance.now()-started),completedAt:new Date().toISOString()},null,2));
  }finally{
    if(runtime)await runtime.close();else if(activeStore)await activeStore.close().catch(()=>{});
    await embedded.stop().catch(()=>{});
    assert.equal(dirname(resolve(folder)),resolve(tmpdir()));assert.ok(basename(folder).startsWith('bizplus-postgres-'));await rm(folder,{recursive:true,force:true});
  }
});

test('TLS connection options cannot disable remote certificate verification',async()=>{
  assert.throws(()=>new PostgresStore('postgresql://fixture:fixture@database.example/test',{ssl:false}),/loopback/);
  assert.throws(()=>new PostgresStore('postgresql://fixture:fixture@database.example/test',{caCert:'invalid certificate'}),/PEM/);
  assert.throws(()=>new PostgresStore('https://database.example/test'),/PostgreSQL/);
  assert.throws(()=>new PostgresStore('postgresql://fixture:fixture@localhost/test?host=database.example',{ssl:false}),/loopback/);
  for(const query of ['ssl=no-verify','ssl=0','sslmode=no-verify','sslnegotiation=direct','sslmode=require&uselibpqcompat=true']){
    const store=new PostgresStore(`postgresql://fixture:fixture@database.example/test?${query}`);
    const client=new Client(store.pool.options);
    assert.deepEqual((client as unknown as {connectionParameters:{ssl:unknown}}).connectionParameters.ssl,{rejectUnauthorized:true});
    await store.close();
  }
});
