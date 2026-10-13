import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const require = createRequire(new URL('../observer/package.json', import.meta.url));
const { chromium } = require('playwright');
const origin = (process.env.VERIFY_ERRORS_ORIGIN || 'http://127.0.0.1:3024').replace(/\/$/, '');
const label = process.env.VERIFY_ERRORS_LABEL || 'local';
const screenshots = resolve(`artifacts/screenshots/investigation-${label}`);
await mkdir(screenshots, { recursive:true });
const browser = await chromium.launch({headless:true});
const report = { origin, startedAt:new Date().toISOString(), checks:[] };
const contexts = [];
async function fixture(path='/incidents') {
  const session = randomUUID();
  const context = await browser.newContext({viewport:{width:1440,height:1000}}); contexts.push(context);
  await context.addInitScript(id => localStorage.setItem('bizplus.demo-session.v1',id),session);
  const page = await context.newPage();
  const headers = {'X-Demo-Session':session,'Content-Type':'application/json'};
  const call = async (route,body) => {
    const response = body === undefined ? await context.request.get(`${origin}${route}`,{headers}) : await context.request.post(`${origin}${route}`,{headers,data:body});
    const data = await response.json();
    return {status:response.status(),data};
  };
  const incidents = async () => (await call('/api/incidents')).data.incidents;
  await page.goto(`${origin}${path}`);
  await page.getByText('Engine online',{exact:true}).waitFor({timeout:120000});
  const screenshot = async name => {
    if (page.viewportSize().width < 980) await page.waitForFunction(()=>document.querySelector('.sidebar').getBoundingClientRect().right <= 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false,'Document must fit the viewport');
    await page.screenshot({path:resolve(screenshots,name),fullPage:true});
  };
  return {session,context,page,call,incidents,screenshot};
}
async function until(read,predicate,description) {
  const end = Date.now()+20000;
  while (Date.now()<end) { const value=await read(); if(predicate(value)) return value; await new Promise(r=>setTimeout(r,300)); }
  throw new Error(`Timed out: ${description}`);
}
try {
  const f = await fixture();
  const rejected=await f.call('/api/runs/private-test-id?password=synthetic-secret');
  assert.equal(rejected.status,404); assert.ok(rejected.data.incidentId);
  const incident=(await f.call(`/api/incidents/${rejected.data.incidentId}`)).data;
  assert.equal(incident.application.code,'NOT_FOUND'); assert.equal(incident.application.path,'/api/runs/:id');
  assert.equal(JSON.stringify(incident).includes('synthetic-secret'),false);
  await f.page.goto(`${origin}/incidents/${incident.id}`);
  await f.page.getByRole('heading',{name:'Application request failed',exact:true}).waitFor();
  await f.page.getByText('Occurrences',{exact:false}).waitFor();
  assert.equal(await f.page.getByRole('button',{name:'Approve recovery',exact:true}).count(),0);
  await f.screenshot('api-error-desktop.png');
  await f.page.setViewportSize({width:390,height:844}); await f.screenshot('api-error-mobile.png');
  report.checks.push({flow:'Actual backend 404 -> safe incident -> desktop and mobile Investigation',passed:true,incidentId:incident.id});
  await f.context.close();

  const b = await fixture();
  await b.page.evaluate(() => { setTimeout(()=>{throw new Error('private-runtime-message-password-719');},0); });
  let list=await until(b.incidents,x=>x.some(i=>i.application?.code==='BROWSER_RUNTIME_ERROR'),'runtime incident');
  const runtime=list.find(i=>i.application?.code==='BROWSER_RUNTIME_ERROR');
  // The incident event refreshes the open Investigation without navigation or reload.
  await b.page.locator('.incident-selector button').filter({hasText:'Browser error detected'}).first().waitFor();
  await b.page.evaluate(() => { setTimeout(()=>{throw new Error('another-private-runtime-message');},0); });
  await b.page.evaluate(() => { void Promise.reject(new Error('private-rejection-token-278')); });
  await b.page.route('**/assets/controlled-error-probe.svg',route=>route.abort());
  await b.page.evaluate(() => { const img=document.createElement('img'); img.src='/assets/controlled-error-probe.svg'; img.hidden=true; document.body.append(img); });
  list=await until(b.incidents,x=>x.some(i=>i.application?.code==='BROWSER_UNHANDLED_REJECTION')&&x.some(i=>i.application?.code==='BROWSER_RESOURCE_ERROR'),'promise and asset failures');
  assert.equal(list.filter(i=>i.application?.code==='BROWSER_RUNTIME_ERROR').length,1,'Repeated runtime errors must group');
  for (const secret of ['private-runtime-message-password-719','private-rejection-token-278','controlled-error-probe']) assert.equal(JSON.stringify(list).includes(secret),false,'Raw error and asset values must not persist');
  await b.page.goto(`${origin}/incidents/${runtime.id}`); await b.screenshot('browser-error.png');
  report.checks.push({flow:'Real JS exception, rejected promise, failed resource -> automatic Investigation refresh; repeats grouped; raw values redacted',passed:true});
  await b.context.close();

  const q = await fixture('/shop');
  await q.page.route('**/api/errors',route=>route.abort());
  await q.page.evaluate(()=> { setTimeout(()=>{throw new Error('private-offline-probe');},0); });
  await q.page.goto(`${origin}/incidents`);
  await q.page.getByRole('heading',{name:/error.*waiting to be saved/}).waitFor();
  await q.screenshot('queued-error.png');
  await q.page.unroute('**/api/errors');
  await q.page.getByRole('button',{name:'Retry saving errors',exact:true}).click();
  const queued = await until(q.incidents,x=>x.some(i=>i.application?.code==='BROWSER_RUNTIME_ERROR'),'queued error saved');
  await q.page.getByRole('heading',{name:/error.*waiting to be saved/}).waitFor({state:'hidden'});
  assert.equal(queued.filter(i=>i.application?.code==='BROWSER_RUNTIME_ERROR').length,1);
  report.checks.push({flow:'Unavailable error-reporting connection -> visible safe queue -> one saved incident after retry',passed:true});
  await q.context.close();

  const l=await fixture('/live-tests');
  const introduced=await l.call('/api/live/lab',{fault:'missing_content',approved:true}); assert.equal(introduced.status,200);
  const started=await l.call('/api/live/runs',{targetId:'bizplus-fault-lab'}); assert.equal(started.status,202);
  const live=await until(async()=>(await l.call(`/api/live/runs/${started.data.runId}`)).data,x=>x.status==='failed','controlled live check');
  assert.equal(live.httpStatus,200); assert.ok(live.investigationIncidentId);
  const original=(await l.call(`/api/incidents/${live.investigationIncidentId}`)).data;
  assert.equal(original.application.source,'live'); assert.equal(original.status,'open');
  await l.page.goto(`${origin}/incidents/${original.id}`);
  await l.page.getByRole('link',{name:/Open live check and verify/}).click();
  await l.page.waitForURL(`**/live-tests?run=${live.id}`);
  await l.page.locator('.live-result').getByText(`RUN ${live.id.slice(0,8)}`,{exact:true}).waitFor();
  assert.equal(await l.page.getByRole('link',{name:/Open Investigation/}).count()>0,true);
  const restored=await l.call(`/api/live/runs/${live.id}/recover`,{approved:true}); assert.equal(restored.data.status,'verified');
  assert.equal((await l.call(`/api/incidents/${original.id}`)).data.status,'resolved');
  assert.ok((await l.call('/api/metrics')).data.verifiedRecoveries >= 1,'Fresh passing live verification counts on the dashboard');
  assert.equal((await l.call(`/api/live/runs/${live.id}`)).data.status,'failed','Original failure is preserved');
  await l.page.goto(`${origin}/incidents/${original.id}`); await l.screenshot('live-error-verified.png');
  report.checks.push({flow:'HTTP 200 missing-content failure -> Investigation -> exact Live run -> actual passing repair verifies resolution',passed:true,incidentId:original.id});
  await l.context.close();

  const p=await fixture('/shop');
  const products=(await p.call('/api/shop/products')).data; const product=products[0];
  const order={id:randomUUID(),checkoutKey:randomUUID(),status:'pending',items:[{productId:product.id,name:product.name,quantity:1,unitAmountMinor:product.priceMinor,lineAmountMinor:product.priceMinor}],amountMinor:product.priceMinor,currency:'INR',razorpayOrderId:'order_controlled_browser_fixture',razorpayPaymentId:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),paidAt:null};
  await p.page.route('**/api/shop/config',route=>route.fulfill({json:{mode:'test',configured:true,keyId:'rzp_test_controlled_browser_fixture',database:'sqlite',message:'Controlled browser payment fixture'}}));
  await p.page.route('**/api/shop/orders',route=>route.fulfill({json:route.request().method()==='POST'?{mode:'test',keyId:'rzp_test_controlled_browser_fixture',order}:{orders:[order]}}));
  await p.page.addInitScript(()=> {
    window.Razorpay=class { on(_event,handler){this.failed=handler;} close(){} open(){setTimeout(()=>this.failed({error:{description:'private-provider-message-signature-926'}}),0);} };
  });
  await p.page.reload(); await p.page.getByText('Engine online',{exact:true}).waitFor();
  await p.page.getByRole('button',{name:/Add.*cart/}).first().click();
  await p.page.locator('.checkout-button').click();
  await p.page.getByText('This test payment failed.',{exact:false}).waitFor();
  const paymentList=await until(p.incidents,x=>x.some(i=>i.application?.code==='PAYMENT_FAILED'),'payment failure');
  const payment=paymentList.find(i=>i.application?.code==='PAYMENT_FAILED');
  assert.equal(JSON.stringify(payment).includes('private-provider'),false);
  await p.page.getByRole('link',{name:'Open Investigation',exact:true}).click();
  await p.page.locator('.incident-selector button').filter({hasText:'Checkout error detected'}).click();
  await p.page.getByRole('heading',{name:'Checkout error detected',exact:true}).waitFor();
  await p.screenshot('payment-error.png');
  report.checks.push({flow:'Controlled browser provider payment.failed callback -> real saved Investigation incident, no raw provider details',passed:true,incidentId:payment.id,providerMode:'mocked browser Test Mode callback; no payment submitted'});
  await p.context.close();

  const v=await fixture('/login');
  await v.page.getByRole('button',{name:'Log in',exact:true}).click();
  await v.page.getByText('Enter your username.',{exact:true}).waitFor();
  const validation=await until(v.incidents,x=>x.some(i=>i.application?.code==='BROWSER_VALIDATION_ERROR'),'required-input validation');
  assert.equal(validation.some(i=>i.login),false,'Empty fields never submit a credential attempt');
  await v.page.goto(`${origin}/`);
  await v.page.getByText('Application error',{exact:true}).first().waitFor();
  assert.equal(await v.page.locator('.journey-steps').getByRole('button').count(),1,'Application error has only its recorded step');
  report.checks.push({flow:'Required login fields -> Investigation validation error without credential submit; application run has one actual step',passed:true});
  await v.context.close();

  const n=await fixture('/shop');
  await n.page.route('**/api/shop/products',route=>route.abort());
  await n.page.reload();
  const network=await until(n.incidents,x=>x.some(i=>i.application?.code==='API_NETWORK_ERROR'),'API network failure');
  assert.equal(network.find(i=>i.application?.code==='API_NETWORK_ERROR').application.path,'/api/shop/products');
  report.checks.push({flow:'Failed storefront fetch -> API network error saved in Investigation',passed:true});
  await n.context.close();

  report.completedAt=new Date().toISOString();
  await mkdir('artifacts/verification',{recursive:true});
  const output=`artifacts/verification/investigation-${label}.json`;
  await writeFile(output,JSON.stringify(report,null,2)); console.log(JSON.stringify({passed:report.checks.length,output,screenshots}));
} finally { for(const context of contexts) await context.close().catch(()=>{}); await browser.close(); }
