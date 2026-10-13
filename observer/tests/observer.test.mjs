import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { startObserver } from '../src/server.mjs';
import { BrowserProbes } from '../src/browser.mjs';
import { configuration } from '../src/config.mjs';
import { chromium } from 'playwright';
import { httpCheck, syntheticCheck } from '../src/checks.mjs';

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => { server.listen(port, '127.0.0.1', resolve); server.once('error', reject); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) { await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }); }
const assertionsPassed = [{ code: 'BROWSER', expected: 'Pass', actual: 'Pass', passed: true }];
const fakeProbes = () => ({ busy: false, health: { available: true, lastError: null }, storefront: async () => ({ assertions: assertionsPassed, evidence: [] }), probe: async () => ({ assertions: assertionsPassed, evidence: [] }) });

test('fixed-origin validation requires deliberate loopback opt-in and rejects unsafe origin inputs', () => {
  for (const origin of ['http://127.0.0.1:3001', 'http://example.com', 'https://example.com/a', 'https://user:secret@example.com', 'https://example.com?q=x']) assert.throws(() => configuration({ BIZPLUS_ORIGIN: origin }));
  assert.equal(configuration({ BIZPLUS_ORIGIN: 'http://127.0.0.1:3001', OBSERVER_ALLOW_LOCAL: 'true' }).origin, 'http://127.0.0.1:3001');
});

test('independent observer survives target shutdown, opens incident, and resolves after target restart', async () => {
  const handler = (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/shop') return res.end('<html><title>BizPlus</title><div id="root"></div></html>');
    if (req.url === '/api/runs' && req.method === 'POST') { res.statusCode = 202; return res.end(JSON.stringify({ runId: 'fe494342-c90b-45ea-9dd9-0510b965edbc' })); }
    if (req.url.startsWith('/api/runs/')) return res.end(JSON.stringify({ status: 'passed', paymentCount: 1, steps: ['login', 'inventory', 'cart', 'checkout', 'confirmation'].map(id => ({ id, status: 'passed' })) }));
    res.end(JSON.stringify({ status: 'ok', app: 'BizPlus AI' }));
  };
  let target = createServer(handler); const origin = await listen(target); const port = target.address().port;
  const observer = await startObserver({ schedule: false, config: { origin, port: 0, databasePath: ':memory:', requestTimeoutMs: 500 }, probes: fakeProbes() });
  try {
    await observer.cycle();
    const identity = observer.snapshot().instanceId;
    assert.equal(observer.snapshot().checks.find(item => item.key === 'availability').status, 'passed');
    await close(target);
    await observer.cycle();
    const health = await (await fetch(`${observer.baseUrl}/health`)).json();
    assert.equal(health.status, 'ok'); assert.equal(health.instanceId, identity);
    assert.equal(observer.snapshot().checks.find(item => item.key === 'availability').status, 'failed');
    const incident = observer.snapshot().incidents.find(item => item.key === 'availability');
    assert.equal(incident.status, 'open'); assert.equal(incident.diagnosis.certainty, 'unconfirmed');
    target = createServer(handler); await listen(target, port);
    await observer.cycle();
    assert.equal(observer.snapshot().checks.find(item => item.key === 'availability').status, 'passed');
    assert.equal(observer.snapshot().incidents.find(item => item.id === incident.id).status, 'resolved');
    assert.equal(observer.snapshot().instanceId, identity);
  } finally { await observer.close(); await close(target); }
});

test('observer mutations require server token and reject arbitrary browser target URLs', async () => {
  const observer = await startObserver({ schedule: false, config: { origin: 'https://bizplus.example', port: 0, databasePath: ':memory:', token: 'only-server-knows-this' }, probes: fakeProbes() });
  try {
    const id = randomUUID();
    const denied = await fetch(`${observer.baseUrl}/api/browser-probe`, { method: 'POST', body: JSON.stringify({ sessionId: id }) });
    assert.equal(denied.status, 403);
    const extra = await fetch(`${observer.baseUrl}/api/browser-probe`, { method: 'POST', headers: { 'X-Observer-Token': 'only-server-knows-this' }, body: JSON.stringify({ sessionId: id, url: 'http://localhost' }) });
    assert.equal(extra.status, 400);
    const valid = await fetch(`${observer.baseUrl}/api/browser-probe`, { method: 'POST', headers: { 'X-Observer-Token': 'only-server-knows-this' }, body: JSON.stringify({ sessionId: id }) });
    assert.equal(valid.status, 200); assert.equal((await valid.json()).assertions[0].passed, true);
  } finally { await observer.close(); }
});

test('unavailable Chromium is a monitor error and never a website pass', async () => {
  const probes = new BrowserProbes('https://bizplus.example', async () => { throw new Error('Executable missing'); });
  const result = await probes.probe(randomUUID());
  assert.equal(result.monitorError, true); assert.equal(result.assertions[0].code, 'BROWSER_RUNNER_AVAILABLE');
  assert.equal(result.assertions[0].passed, false); assert.equal(probes.health.available, false);
});

test('readiness identifies observed dependency failures without inventing their underlying cause', async () => {
  const target = createServer((_req, res) => { res.statusCode = 503; res.end(JSON.stringify({ status: 'degraded', components: [{ name: 'database', status: 'failed', code: 'DATABASE_UNAVAILABLE', message: 'Database probe did not complete.' }] })); });
  const origin = await listen(target);
  try {
    const result = await httpCheck(origin, 'readiness', '/ready');
    assert.equal(result.status, 'failed');
    assert.equal(result.assertions.find(item => item.code === 'READINESS_DATABASE').passed, false);
    assert.match(result.diagnosis.causes[0], /DATABASE_UNAVAILABLE/);
    assert.equal(result.diagnosis.certainty, 'unconfirmed');
  } finally { await close(target); }
});

test('HTTP 200 proxy HTML never passes application availability', async () => {
  const target = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html><h1>The hosting service is starting</h1></html>'); });
  const origin = await listen(target);
  try {
    const result = await httpCheck(origin, 'availability', '/health');
    assert.equal(result.assertions.find(item => item.code === 'HTTP_STATUS').passed, true);
    assert.equal(result.assertions.find(item => item.code === 'APPLICATION_HEALTH').passed, false);
    assert.equal(result.status, 'failed');
  } finally { await close(target); }
});

test('synthetic success requires exactly all five canonical steps', async () => {
  let ids = [];
  const target = createServer((req, res) => {
    if (req.method === 'POST') { res.statusCode = 202; return res.end(JSON.stringify({ runId: 'fe494342-c90b-45ea-9dd9-0510b965edbc' })); }
    res.end(JSON.stringify({ status: 'passed', paymentCount: 1, steps: ids.map(id => ({ id, status: 'passed' })) }));
  });
  const origin = await listen(target);
  try {
    for (const invalid of [[], ['login', 'inventory', 'cart', 'checkout', 'checkout'], ['login', 'inventory', 'cart', 'checkout', 'confirmation', 'extra']]) {
      ids = invalid;
      const result = await syntheticCheck(origin, randomUUID());
      assert.equal(result.status, 'failed');
      assert.equal(result.assertions.find(item => item.code === 'SYNTHETIC_STEP_CONTRACT').passed, false);
    }
    ids = ['login', 'inventory', 'cart', 'checkout', 'confirmation'];
    assert.equal((await syntheticCheck(origin, randomUUID())).status, 'passed');
  } finally { await close(target); }
});

test('bounded inspection restrictions are observer failures rather than invented website outages', async () => {
  const target = createServer((req, res) => {
    if (req.url === '/health') { res.statusCode = 302; res.setHeader('Location', 'https://unconfigured.example'); return res.end(); }
    return res.end('x'.repeat(520000));
  });
  const origin = await listen(target);
  try {
    const redirect = await httpCheck(origin, 'availability', '/health');
    assert.equal(redirect.status, 'monitor_error');
    assert.equal(redirect.assertions[0].code, 'OBSERVER_INSPECTION');
    const oversized = await httpCheck(origin, 'storefront', '/shop');
    assert.equal(oversized.status, 'monitor_error');
    assert.match(oversized.diagnosis.summary, /website failure is not established/);
  } finally { await close(target); }
});

test('independent dashboard displays observed history safely while target remains unavailable', async () => {
  const observer = await startObserver({ schedule: false, config: { origin: 'https://bizplus.example', port: 0, databasePath: ':memory:' }, probes: fakeProbes() });
  observer.store.save({ id: randomUUID(), key: 'availability', label: 'Independent availability', status: 'failed', completedAt: new Date().toISOString(), durationMs: 12, assertions: [{ code: 'REQUEST_COMPLETED', expected: 'Response', actual: 'Offline', passed: false }], evidence: ['Connection refused'], diagnosis: { summary: '<script>window.invalidMarkupExecuted=true</script>', certainty: 'unconfirmed', causes: ['The target may be offline.'], solutions: ['Restore service and verify a passing check.'] } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(observer.baseUrl);
    await page.getByRole('heading', { name: 'Independent availability' }).first().waitFor();
    assert.match(await page.locator('#checks').innerText(), /<script>window.invalidMarkupExecuted=true<\/script>/);
    assert.equal(await page.evaluate(() => window.invalidMarkupExecuted), undefined);
    assert.deepEqual(errors, []);
    assert.match(await page.locator('#incidents').innerText(), /open/i);
  } finally { await browser.close(); await observer.close(); }
});

test('storefront waits for delayed hydration within its total budget and still checks actual controls', { timeout: 20000 }, async () => {
  const target = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<p>Storefront is loading</p><script>setTimeout(()=>{
      const add=document.createElement('button');add.setAttribute('aria-label','Add Demo item to cart');add.textContent='Add';document.body.append(add);
      const count=document.createElement('span');count.className='cart-count';count.textContent='0';document.body.append(count);
      const control=document.createElement('div');control.className='quantity-control';const minus=document.createElement('button');minus.setAttribute('aria-label','Remove one Demo item');const quantity=document.createElement('span');quantity.textContent='0';const plus=document.createElement('button');plus.setAttribute('aria-label','Add one Demo item');control.append(minus,quantity,plus);document.body.append(control);
      const checkout=document.createElement('button');checkout.className='checkout-button';checkout.textContent='Test checkout';document.body.append(checkout);
      add.onclick=()=>{count.textContent='1';quantity.textContent='1'};plus.onclick=()=>quantity.textContent='2';minus.onclick=()=>quantity.textContent='1';
    },3400)</script>`);
  });
  const origin = await listen(target); const probes = new BrowserProbes(origin);
  try {
    const result = await probes.storefront();
    assert.equal(result.assertions.every(item => item.passed), true);
    assert.equal(result.assertions.some(item => item.code === 'STOREFRONT_QUANTITY'), true);
  } finally { await close(target); }
});

test('actual Chromium detects JavaScript, button, login, database, and confirmation faults then verifies restored journey', { timeout: 60000 }, async () => {
  let fault = 'healthy';
  const target = createServer((req, res) => {
    if (req.url.includes('/api/')) {
      const stage = req.url.split('/').pop();
      res.setHeader('Content-Type', 'application/json');
      const failed = fault === 'login' && stage === 'login' || fault === 'database' && stage === 'catalog' || fault === 'confirmation' && stage === 'confirmation';
      if (failed) res.statusCode = fault === 'login' ? 401 : 503;
      return res.end(JSON.stringify(failed ? { error: 'controlled failure' } : { authenticated: true, items: [{}], confirmed: true }));
    }
    res.setHeader('Content-Type', 'text/html');
    const script = fault === 'javascript' ? "throw new Error('Controlled laboratory JavaScript exception');" : `
      async function call(stage) {const r=await fetch(location.pathname+'/api/'+stage);if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}
      login.onclick=async()=>{try{await call('login');document.querySelector('[data-testid="login-status"]').textContent='Signed in'}catch{}};
      add.onclick=async()=>{try{await call('catalog');document.querySelector('[data-testid="cart-count"]').textContent='1'}catch{}};
      checkout.onclick=async()=>{try{await call('confirmation');document.querySelector('[data-testid="confirmation"]').textContent='Order confirmed'}catch{}};`;
    res.end(`<button id="login" data-testid="login">Login</button><p data-testid="login-status">Signed out</p><button id="add" data-testid="add-product">Add</button><p data-testid="cart-count">0</p><button id="checkout" data-testid="checkout">Checkout</button><p data-testid="confirmation">No confirmation</p><script>${fault === 'button' ? '' : script}</script>`);
  });
  const origin = await listen(target); const probes = new BrowserProbes(origin);
  try {
    const initial = await probes.probe(randomUUID());
    assert.equal(initial.monitorError, undefined, 'Chromium must actually be available for this integration test.');
    assert.equal(initial.assertions.every(item => item.passed), true);
    for (const selected of ['javascript', 'button', 'login', 'database', 'confirmation']) {
      fault = selected;
      const result = await probes.probe(randomUUID());
      assert.equal(result.assertions.some(item => !item.passed), true, `${selected} must fail the actual browser flow`);
      assert.equal(result.evidence.some(item => item.startsWith('Actual browser failure at ')), true, 'Failed action must retain its actual browser error.');
      if (selected === 'javascript') {
        assert.equal(result.assertions.find(item => item.code === 'BROWSER_JAVASCRIPT').passed, false);
        assert.match(result.evidence.join(' '), /Controlled laboratory JavaScript exception/);
      }
      if (selected === 'login') assert.match(result.evidence.join(' '), /HTTP 401/);
      if (selected === 'database' || selected === 'confirmation') assert.match(result.evidence.join(' '), /HTTP 503/);
    }
    fault = 'healthy';
    const restored = await probes.probe(randomUUID());
    assert.equal(restored.assertions.every(item => item.passed), true);
  } finally { await close(target); }
});

test('observer inspects human login controls without entering credentials or submitting login', async () => {
  let loginRequests = 0;
  const target = createServer((req, res) => {
    if (req.url.includes('/api/login')) { loginRequests++; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ status:'successful',message:'Login successful' })); }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<form data-testid="manual-login-form"><label for="username">Username</label><input id="username" name="username"><label for="password">Password</label><input id="password" name="password" type="password"><button type="submit">Login</button></form><script>
      document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();fetch('/api/login',{method:'POST',body:JSON.stringify({username:username.value,password:password.value})})});
      document.querySelectorAll('input').forEach(input=>input.addEventListener('input',()=>fetch('/api/login?unexpected-input')));
    </script>`);
  });
  const origin = await listen(target); const probes = new BrowserProbes(origin);
  try {
    const result = await probes.probe(randomUUID());
    assert.equal(result.manualVerificationRequired, true);
    assert.equal(result.assertions.find(item => item.code === 'BROWSER_LOGIN_FORM').passed, true);
    assert.equal(result.assertions.some(item => item.code === 'BROWSER_LOGIN'), false, 'Form presence must never be recorded as successful authentication.');
    assert.match(result.evidence.join(' '), /Manual verification required/);
    assert.equal(loginRequests, 0, 'Observer must neither fill nor submit the human login form.');
  } finally { await close(target); }
});
