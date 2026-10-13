import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { CommerceCheckout, CommerceConfig, CommerceOrder } from '@bizplus/shared';
import { Store } from '../src/database/store.js';
import { registerCommerce, registerCommerceWebhook, type CommerceOptions } from '../src/commerce/routes.js';
import { ProviderError, type RazorpayTransport } from '../src/commerce/razorpay.js';

const KEY_ID = 'rzp_test_FixtureOnly';
const KEY_SECRET = 'fixture-key-secret-not-a-real-credential';
const WEBHOOK_SECRET = 'fixture-webhook-secret-not-a-real-credential';
type Entity = Record<string, unknown>;
type Provider = Awaited<ReturnType<typeof mockProvider>>;
async function listener(app: ReturnType<typeof express>) {
  const server: Server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { server, url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }) };
}
async function mockProvider() {
  const orders = new Map<string, Entity>();
  const payments = new Map<string, Entity>();
  const calls: { method: string; path: string; body: unknown }[] = [];
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { if (req.header('Authorization') !== `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`) { res.sendStatus(401); return; } calls.push({ method: req.method, path: req.path, body: req.body }); next(); });
  app.post('/v1/orders', (req, res) => {
    const id = `order_fixture${orders.size + 1}`;
    const order = { id, entity: 'order', ...req.body, status: 'created', amount_paid: 0, amount_due: req.body.amount };
    orders.set(id, order); res.status(200).json(order);
  });
  app.get('/v1/orders/:id', (req, res) => { const value = orders.get(String(req.params.id)); if (!value) { res.sendStatus(404); return; } res.json(value); });
  app.get('/v1/payments/:id', (req, res) => { const value = payments.get(String(req.params.id)); if (!value) { res.sendStatus(404); return; } res.json(value); });
  const runtime = await listener(app);
  const transport: RazorpayTransport = async (method, path, body) => {
    const response = await fetch(`${runtime.url}/v1${path}`, { method, headers: { Authorization: `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new ProviderError('Fixture provider rejected the request.', response.status >= 500);
    return response.json();
  };
  function payment(order: CommerceOrder, status = 'captured', overrides: Entity = {}) {
    const id = `pay_fixture${payments.size + 1}`;
    const entity: Entity = { id, entity: 'payment', order_id: order.razorpayOrderId, amount: order.amountMinor, currency: 'INR', status, captured: status === 'captured', amount_refunded: 0, ...overrides };
    payments.set(id, entity);
    const providerOrder = orders.get(order.razorpayOrderId!); assert.ok(providerOrder);
    providerOrder.status = status === 'captured' ? 'paid' : 'attempted';
    providerOrder.amount_paid = status === 'captured' ? order.amountMinor : 0;
    providerOrder.amount_due = status === 'captured' ? 0 : order.amountMinor;
    return entity;
  }
  return { ...runtime, transport, orders, payments, calls, payment };
}
async function withShop(operation: (shop: { url: string; store: Store; provider: Provider; session: string }) => Promise<void>, options: CommerceOptions = {}, wrapTransport?: (transport: RazorpayTransport) => RazorpayTransport) {
  const provider = await mockProvider(); const store = new Store(':memory:');
  const app = express();
  const commerce: CommerceOptions = { keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET, providerTransport: wrapTransport ? wrapTransport(provider.transport) : provider.transport, ...options };
  registerCommerceWebhook(app, store, commerce);
  app.use(express.json()); app.use((req, res, next) => { res.locals.session = req.header('X-Demo-Session'); next(); });
  registerCommerce(app, store, commerce);
  const runtime = await listener(app);
  try { await operation({ url: runtime.url, store, provider, session: randomUUID() }); }
  finally { await runtime.close(); await provider.close(); store.close(); }
}
const singleItem = (checkoutKey = randomUUID()) => ({ checkoutKey, items: [{ productId: 'bp-headphones', quantity: 1 }] });
function api(url: string, session: string, path: string, body?: unknown) { return fetch(`${url}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Demo-Session': session, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
function proof(order: CommerceOrder, paymentId: string) {
  return { razorpay_order_id: order.razorpayOrderId, razorpay_payment_id: paymentId, razorpay_signature: createHmac('sha256', KEY_SECRET).update(`${order.razorpayOrderId}|${paymentId}`).digest('hex') };
}
async function create(shop: { url: string; session: string }, body: unknown = singleItem()): Promise<CommerceOrder> {
  const response = await api(shop.url, shop.session, '/api/shop/orders', body); assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  return (await response.json() as CommerceCheckout).order;
}
async function webhook(url: string, payload: unknown, eventId = randomUUID(), signature?: string) {
  const raw = JSON.stringify(payload);
  return fetch(`${url}/api/shop/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Razorpay-Event-Id': eventId, 'X-Razorpay-Signature': signature ?? createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex') }, body: raw });
}

test('shop returns six server-priced products; keys missing or live keys disable real checkout', async () => {
  for (const keyId of ['', 'rzp_live_Disallowed']) await withShop(async shop => {
    const config = await (await api(shop.url, shop.session, '/api/shop/config')).json() as CommerceConfig;
    assert.equal(config.mode, 'test'); assert.equal(config.configured, false); assert.equal(config.keyId, null);
    const products = await (await api(shop.url, shop.session, '/api/shop/products')).json() as unknown[]; assert.equal(products.length, 6);
    const response = await api(shop.url, shop.session, '/api/shop/orders', singleItem()); assert.equal(response.status, 503);
    assert.equal(shop.provider.calls.length, 0); assert.equal(shop.store.listCommerceOrders(shop.session).length, 0);
  }, { keyId });
});

test('cart tampering, unknown products, duplicate products, excessive quantities and totals are rejected before provider calls', async () => {
  await withShop(async shop => {
    const invalid = [
      { ...singleItem(), amount: 1 },
      { ...singleItem(), items: [{ productId: 'bp-headphones', quantity: 1, priceMinor: 1 }] },
      { ...singleItem(), items: [{ productId: 'unknown', quantity: 1 }] },
      { ...singleItem(), items: [{ productId: 'bp-headphones', quantity: -1 }] },
      { ...singleItem(), items: [{ productId: 'bp-headphones', quantity: 1.5 }] },
      { ...singleItem(), items: [{ productId: 'bp-headphones', quantity: 6 }] },
      { ...singleItem(), items: [{ productId: 'bp-headphones', quantity: 1 }, { productId: 'bp-headphones', quantity: 1 }] },
      { ...singleItem(), items: [{ productId: 'bp-watch', quantity: 5 }] },
    ];
    for (const body of invalid) assert.equal((await api(shop.url, shop.session, '/api/shop/orders', body)).status, 400);
    assert.equal(shop.provider.calls.length, 0);
    const order = await create(shop); assert.equal(order.amountMinor, 199900); assert.equal(order.items[0]?.unitAmountMinor, 199900);
    assert.equal(shop.provider.calls[0]?.method, 'POST'); assert.equal((shop.provider.calls[0]?.body as Entity).amount, 199900);
  });
});

test('concurrent checkout and cancelled-checkout retry reuse one provider order and reject a changed cart', async () => {
  await withShop(async shop => {
    const body = singleItem();
    const responses = await Promise.all([api(shop.url, shop.session, '/api/shop/orders', body), api(shop.url, shop.session, '/api/shop/orders', body)]);
    assert.equal(responses[0]!.status, 201); assert.equal(responses[1]!.status, 201);
    const orders = await Promise.all(responses.map(async response => (await response.json() as CommerceCheckout).order));
    assert.equal(orders[0]?.id, orders[1]?.id); assert.equal(shop.provider.calls.filter(call => call.method === 'POST').length, 1);
    const retry = await create(shop, body); assert.equal(retry.id, orders[0]?.id); assert.equal(shop.provider.orders.size, 1);
    const conflict = await api(shop.url, shop.session, '/api/shop/orders', { ...body, items: [{ productId: 'bp-keyboard', quantity: 1 }] }); assert.equal(conflict.status, 409);
  });
});

test('ambiguous provider creation is retained and cannot blindly create another order', async () => {
  let calls = 0;
  await withShop(async shop => {
    const body = singleItem();
    assert.equal((await api(shop.url, shop.session, '/api/shop/orders', body)).status, 502);
    const orders = shop.store.listCommerceOrders(shop.session); assert.equal(orders.length, 1); assert.equal(orders[0]?.status, 'provider_unknown');
    const repeat = await api(shop.url, shop.session, '/api/shop/orders', body); assert.equal(repeat.status, 409); assert.equal(calls, 1);
  }, { providerTransport: async () => { calls++; throw new ProviderError('Fixture timeout after possible provider creation.', true); } });
});

test('invalid signatures, unrelated session, mismatched payment amount and wrong provider order cannot mark an order paid', async () => {
  await withShop(async shop => {
    const order = await create(shop); const payment = shop.provider.payment(order);
    const valid = proof(order, payment.id as string);
    assert.equal((await api(shop.url, shop.session, `/api/shop/orders/${order.id}/verify`, { ...valid, razorpay_signature: '00'.repeat(32) })).status, 400);
    assert.equal(shop.store.getCommerceOrder(order.id, shop.session)?.razorpayPaymentId, null);
    assert.equal((await api(shop.url, randomUUID(), `/api/shop/orders/${order.id}/verify`, valid)).status, 404);
    assert.equal((await api(shop.url, shop.session, `/api/shop/orders/${order.id}/verify`, { ...valid, razorpay_order_id: 'order_wrong' })).status, 400);
    payment.amount = 1;
    assert.equal((await api(shop.url, shop.session, `/api/shop/orders/${order.id}/verify`, valid)).status, 409);
    payment.amount = order.amountMinor; payment.order_id = 'order_another';
    assert.equal((await api(shop.url, shop.session, `/api/shop/orders/${order.id}/verify`, valid)).status, 409);
    assert.equal(shop.store.getCommerceOrder(order.id, shop.session)?.status, 'pending');
    assert.equal((await api(shop.url, randomUUID(), `/api/shop/orders/${order.id}`)).status, 404);
    assert.equal((await (await api(shop.url, randomUUID(), '/api/shop/orders')).json() as { orders: CommerceOrder[] }).orders.length, 0);
  });
});

test('authorized callback retains the payment; a later GET confirms capture without another callback or webhook', async () => {
  await withShop(async shop => {
    const order = await create(shop); const payment = shop.provider.payment(order, 'authorized'); const signed = proof(order, payment.id as string);
    const pending = await (await api(shop.url, shop.session, `/api/shop/orders/${order.id}/verify`, signed)).json() as CommerceOrder;
    assert.equal(pending.status, 'pending'); assert.equal(pending.paidAt, null); assert.equal(pending.razorpayPaymentId, payment.id);
    payment.status = 'captured'; payment.captured = true;
    const providerOrder = shop.provider.orders.get(order.razorpayOrderId!)!; providerOrder.status = 'paid'; providerOrder.amount_paid = order.amountMinor; providerOrder.amount_due = 0;
    const verified = await (await api(shop.url, shop.session, `/api/shop/orders/${order.id}`)).json() as CommerceOrder;
    assert.equal(verified.status, 'paid'); assert.equal(verified.razorpayPaymentId, payment.id); assert.ok(verified.paidAt);
    const callsBefore = shop.provider.calls.length;
    const repeated = await (await api(shop.url, shop.session, `/api/shop/orders/${order.id}/verify`, signed)).json() as CommerceOrder;
    assert.deepEqual(repeated, verified); assert.equal(shop.provider.calls.length, callsBefore); assert.equal(shop.provider.orders.size, 1);
    const otherPayment = shop.provider.payment(order);
    assert.equal((await api(shop.url, shop.session, `/api/shop/orders/${order.id}/verify`, proof(order, otherPayment.id as string))).status, 409);
    assert.equal(shop.store.getCommerceOrder(order.id, shop.session)?.razorpayPaymentId, payment.id);
  });
});

test('a transient provider read failure retains signed proof and a later GET can reconcile the original payment', async () => {
  let failRead = true;
  await withShop(async shop => {
    const order = await create(shop); const payment = shop.provider.payment(order);
    const response = await api(shop.url, shop.session, `/api/shop/orders/${order.id}/verify`, proof(order, payment.id as string));
    assert.equal(response.status, 502);
    const pending = shop.store.getCommerceOrder(order.id, shop.session)!;
    assert.equal(pending.status, 'pending'); assert.equal(pending.razorpayPaymentId, payment.id); assert.equal(pending.paidAt, null);
    failRead = false;
    const reconciled = await api(shop.url, shop.session, `/api/shop/orders/${order.id}`); assert.equal(reconciled.status, 200);
    const paid = await reconciled.json() as CommerceOrder;
    assert.equal(paid.status, 'paid'); assert.equal(paid.id, order.id); assert.equal(paid.razorpayPaymentId, payment.id);
    assert.equal(shop.provider.calls.filter(call => call.method === 'POST').length, 1);
  }, {}, transport => async (method, path, body) => {
    if (method === 'GET' && path.startsWith('/payments/') && failRead) throw new ProviderError('Fixture transient read failure.', true);
    return transport(method, path, body);
  });
});

test('GET reconciliation remains pending when stored signed payment details mismatch the server order', async () => {
  await withShop(async shop => {
    const order = await create(shop); const payment = shop.provider.payment(order, 'authorized');
    assert.equal((await api(shop.url, shop.session, `/api/shop/orders/${order.id}/verify`, proof(order, payment.id as string))).status, 200);
    payment.status = 'captured'; payment.captured = true; payment.amount = 1;
    const response = await api(shop.url, shop.session, `/api/shop/orders/${order.id}`); assert.equal(response.status, 409);
    const pending = shop.store.getCommerceOrder(order.id, shop.session)!;
    assert.equal(pending.status, 'pending'); assert.equal(pending.paidAt, null); assert.equal(pending.razorpayPaymentId, payment.id);
    const calls = shop.provider.calls.length;
    assert.equal((await api(shop.url, randomUUID(), `/api/shop/orders/${order.id}`)).status, 404);
    assert.equal(shop.provider.calls.length, calls);
  });
});

test('captured payment requires matching paid provider totals and rejects a refunded capture', async () => {
  await withShop(async shop => {
    const order = await create(shop); const payment = shop.provider.payment(order); const signed = proof(order, payment.id as string);
    const providerOrder = shop.provider.orders.get(order.razorpayOrderId!)!; providerOrder.amount_paid = 0;
    assert.equal((await api(shop.url, shop.session, `/api/shop/orders/${order.id}/verify`, signed)).status, 409);
    providerOrder.amount_paid = order.amountMinor; payment.amount_refunded = order.amountMinor;
    assert.equal((await api(shop.url, shop.session, `/api/shop/orders/${order.id}/verify`, signed)).status, 409);
    assert.equal(shop.store.getCommerceOrder(order.id, shop.session)?.status, 'pending');
  });
});

test('raw signed webhook confirms provider capture without a browser session; duplicate events do not reprocess payment', async () => {
  await withShop(async shop => {
    const order = await create(shop); const payment = shop.provider.payment(order); const eventId = randomUUID();
    const payload = { event: 'payment.captured', payload: { payment: { entity: payment } } };
    assert.equal((await webhook(shop.url, payload, eventId, '00'.repeat(32))).status, 400);
    const response = await webhook(shop.url, payload, eventId); assert.equal(response.status, 200);
    assert.equal(shop.store.getCommerceOrder(order.id, shop.session)?.status, 'paid');
    const calls = shop.provider.calls.length;
    const duplicate = await webhook(shop.url, payload, eventId); assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).duplicate, true); assert.equal(shop.provider.calls.length, calls);
    assert.equal((await webhook(shop.url, { ...payload, extra: true }, eventId)).status, 409);
  });
});

test('webhook cannot confirm wrong amount or unverified provider capture; a failed event can retry after provider convergence', async () => {
  await withShop(async shop => {
    const order = await create(shop); const payment = shop.provider.payment(order, 'authorized');
    const payload = { event: 'payment.captured', payload: { payment: { entity: { ...payment, status: 'captured', captured: true } } } };
    const mismatch = { event: 'payment.captured', payload: { payment: { entity: { ...payment, status: 'captured', captured: true, amount: 1 } } } };
    assert.equal((await webhook(shop.url, mismatch)).status, 409);
    const eventId = randomUUID(); assert.equal((await webhook(shop.url, payload, eventId)).status, 503);
    assert.equal(shop.store.getCommerceOrder(order.id, shop.session)?.status, 'pending');
    payment.status = 'captured'; payment.captured = true;
    const providerOrder = shop.provider.orders.get(order.razorpayOrderId!)!; providerOrder.status = 'paid'; providerOrder.amount_paid = order.amountMinor; providerOrder.amount_due = 0;
    assert.equal((await webhook(shop.url, payload, eventId)).status, 200);
    assert.equal(shop.store.getCommerceOrder(order.id, shop.session)?.status, 'paid');
  });
});
