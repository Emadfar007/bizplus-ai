import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/app.js';
import { Store } from '../src/database/store.js';
import type { DataStore } from '../src/database/types.js';
import { observerConnection } from '../src/observability.js';

test('readiness exercises database and provider reads while health remains independent', async () => {
  const store = new Store(':memory:'); let databaseDown = true;
  const monitored = new Proxy(store, { get(target,property) {
    if (property === 'checkReadiness') return () => { if (databaseDown) throw new Error('private-db-secret'); target.checkReadiness(); };
    const value = Reflect.get(target,property); return typeof value === 'function' ? value.bind(target) : value;
  } }) as DataStore;
  let providerReads = 0;
  const runtime = await startServer({port:0,store:monitored,commerce:{keyId:'rzp_test_readiness',keySecret:'private-key',providerTransport:async(method,path) => { assert.equal(method,'GET'); assert.equal(path,'/orders'); providerReads++; return {items:[]}; }}});
  try {
    assert.equal((await fetch(`${runtime.baseUrl}/health`)).status,200);
    const response = await fetch(`${runtime.baseUrl}/ready`); assert.equal(response.status,503);
    const body = await response.json();
    assert.equal(body.components[0].code,'DATABASE_UNAVAILABLE');
    assert.equal(body.components[1].status,'passed');
    assert.equal(JSON.stringify(body).includes('private-'),false);
    databaseDown = false;
    // One cached dependency check bounds repeated public requests.
    await fetch(`${runtime.baseUrl}/ready`); assert.equal(providerReads,1);
  } finally { await runtime.close(); }
});

test('readiness reports failed test provider without breaking liveness or exposing errors', async () => {
  const runtime = await startServer({port:0,databasePath:':memory:',commerce:{keyId:'rzp_test_readiness',keySecret:'private-key',providerTransport:async() => { throw new Error('secret-provider-response'); }}});
  try {
    const response = await fetch(`${runtime.baseUrl}/ready`); assert.equal(response.status,503);
    const body = await response.json(); assert.equal(body.components[0].status,'passed');
    assert.equal(body.components[1].code,'PROVIDER_UNAVAILABLE');
    assert.equal(JSON.stringify(body).includes('secret-provider-response'),false);
    assert.equal((await fetch(`${runtime.baseUrl}/health`)).status,200);
  } finally { await runtime.close(); }
});

test('observer configuration is an operator-only fixed origin, and absent observer is explicit', async () => {
  for (const url of ['http://example.com','https://user:secret@example.com','https://example.com/api/status','https://example.com/?target=private']) assert.throws(() => observerConnection({url,allowLocal:false}));
  assert.equal(observerConnection({url:'http://127.0.0.1:3333',allowLocal:true})?.url,'http://127.0.0.1:3333');
  const runtime = await startServer({port:0,databasePath:':memory:'});
  try {
    const response = await fetch(`${runtime.baseUrl}/api/live/observer`,{headers:{'X-Demo-Session':crypto.randomUUID()}});
    const body = await response.json(); assert.equal(body.enabled,false); assert.equal(body.available,false);
  } finally { await runtime.close(); }
});
