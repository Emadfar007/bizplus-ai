import express, { type Express, type Request, type Response } from 'express';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { CommerceCheckout, CommerceConfig, CommerceOrder, CommerceOrderLine, CommercePaymentVerification } from '@bizplus/shared';
import { PRODUCTS } from './catalog.js';
import { CommerceError, ProviderError, razorpayTransport, type RazorpayTransport } from './razorpay.js';

type Awaitable<T> = T | Promise<T>;
export interface CommerceStore {
  saveCommerceOrder(session: string, order: CommerceOrder): Awaitable<void>;
  getCommerceOrder(id: string, session: string): Awaitable<CommerceOrder | null>;
  getCommerceOrderByCheckoutKey(session: string, key: string): Awaitable<CommerceOrder | null>;
  getCommerceOrderByProviderId(razorpayId: string): Awaitable<{ session: string; order: CommerceOrder } | null>;
  listCommerceOrders(session: string): Awaitable<CommerceOrder[]>;
}
export interface CommerceOptions {
  keyId?: string;
  keySecret?: string;
  webhookSecret?: string;
  database?: 'sqlite' | 'postgres';
  providerTimeoutMs?: number;
  /** Internal test injection. Browser requests cannot choose a transport or provider host. */
  providerTransport?: RazorpayTransport;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORDER_ID = /^order_[A-Za-z0-9]{1,64}$/;
const PAYMENT_ID = /^pay_[A-Za-z0-9]{1,64}$/;
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null;
const reject = (status: number, code: string, message: string): never => { throw new CommerceError(status, code, message); };
function equalSignature(expected: string, actual: unknown): boolean {
  return typeof actual === 'string' && /^[0-9a-f]{64}$/i.test(actual) && timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}
function session(res: Response): string {
  const value = res.locals.session as unknown;
  if (typeof value !== 'string' || !UUID.test(value)) reject(400, 'SESSION_REQUIRED', 'Send a browser-generated UUID in X-Demo-Session.');
  return value as string;
}
function cart(body: unknown): { checkoutKey: string; items: CommerceOrderLine[]; amountMinor: number } {
  const value = object(body);
  if (!value || Object.keys(value).some(key => !['checkoutKey', 'items'].includes(key)) || typeof value.checkoutKey !== 'string' || !UUID.test(value.checkoutKey) || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > PRODUCTS.length) reject(400, 'INVALID_CART', 'Provide a checkout UUID and one to six catalog products.');
  const input = value!;
  const seen = new Set<string>();
  const items = (input.items as unknown[]).map(item => {
    const line = object(item);
    if (!line || Object.keys(line).some(key => !['productId', 'quantity'].includes(key)) || typeof line.productId !== 'string' || !Number.isInteger(line.quantity) || (line.quantity as number) < 1 || (line.quantity as number) > 5) reject(400, 'INVALID_CART', 'Each product needs an integer quantity between one and five.');
    const product = PRODUCTS.find(product => product.id === line!.productId);
    if (!product || seen.has(product.id)) reject(400, 'INVALID_CART', 'Use unique product IDs from the demo catalog.');
    seen.add(product!.id);
    const quantity = line!.quantity as number;
    return { productId: product!.id, name: product!.name, quantity, unitAmountMinor: product!.priceMinor, lineAmountMinor: product!.priceMinor * quantity };
  });
  items.sort((left, right) => left.productId.localeCompare(right.productId));
  const amountMinor = items.reduce((total, item) => total + item.lineAmountMinor, 0);
  if (items.reduce((total, item) => total + item.quantity, 0) > 10 || amountMinor > 1_000_000) reject(400, 'CART_LIMIT', 'Demo carts are limited to ten items and ₹10,000.');
  return { checkoutKey: (input.checkoutKey as string).toLowerCase(), items, amountMinor };
}

class CommerceService {
  readonly keyId: string;
  private readonly keySecret: string;
  readonly webhookSecret: string;
  readonly configured: boolean;
  private readonly transport: RazorpayTransport;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly webhookEvents = new Map<string, string>();
  readonly config: CommerceConfig;
  constructor(private readonly store: CommerceStore, options: CommerceOptions) {
    this.keyId = (options.keyId ?? process.env.RAZORPAY_KEY_ID ?? '').trim();
    this.keySecret = (options.keySecret ?? process.env.RAZORPAY_KEY_SECRET ?? '').trim();
    this.webhookSecret = (options.webhookSecret ?? process.env.RAZORPAY_WEBHOOK_SECRET ?? '').trim();
    this.configured = /^rzp_test_[A-Za-z0-9]+$/.test(this.keyId) && this.keySecret.length > 0;
    this.transport = options.providerTransport ?? razorpayTransport(this.keyId, this.keySecret, options.providerTimeoutMs);
    this.config = {
      mode: 'test', configured: this.configured, keyId: this.configured ? this.keyId : null,
      database: options.database ?? (process.env.DATABASE_URL ? 'postgres' : 'sqlite'),
      message: this.configured ? 'Razorpay Test Mode is connected. Test payments do not move real money; demo products are not shipped.' : this.keyId.startsWith('rzp_live_') ? 'Live Razorpay keys are disabled for this demo. Configure a Test Mode key ID and secret on the backend.' : 'Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to the backend to enable Razorpay Test Mode checkout.',
    };
  }
  private requireConfigured(): void { if (!this.configured) reject(503, 'RAZORPAY_NOT_CONFIGURED', this.config.message); }
  private async locked<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => waiting);
    this.locks.set(key, tail);
    await previous;
    try { return await task(); }
    finally { release(); if (this.locks.get(key) === tail) this.locks.delete(key); }
  }
  private async find(sessionId: string, id: string): Promise<CommerceOrder> {
    const order = await this.store.getCommerceOrder(id, sessionId);
    if (!order) return reject(404, 'ORDER_NOT_FOUND', 'This order was not found in your demo session.');
    return order;
  }
  async get(sessionId: string, id: string): Promise<CommerceOrder> {
    return this.locked(`order:${id}`, async () => {
      const order = await this.find(sessionId, id);
      if (order.status !== 'pending' || !order.razorpayPaymentId || !order.razorpayOrderId) return order;
      this.requireConfigured();
      // A previously signed callback is retained even across a reload. Reconcile by
      // reading the original payment/order only; never create or capture a payment.
      return this.confirm(sessionId, order, order.razorpayPaymentId);
    });
  }
  private async rememberPayment(sessionId: string, order: CommerceOrder, paymentId: string): Promise<void> {
    if (order.status === 'paid') {
      if (order.razorpayPaymentId !== paymentId) return reject(409, 'ORDER_ALREADY_PAID', 'This order already has a verified payment.');
      return;
    }
    if (order.status === 'pending' && order.razorpayPaymentId === paymentId) return;
    order.status = 'pending'; order.razorpayPaymentId = paymentId; order.updatedAt = new Date().toISOString();
    // Persist only after authenticating the callback/webhook, before provider reads.
    // A timeout must not lose the payment reference needed for later reconciliation.
    await this.store.saveCommerceOrder(sessionId, order);
  }
  async create(sessionId: string, body: unknown): Promise<CommerceCheckout> {
    this.requireConfigured();
    const input = cart(body);
    return this.locked(`checkout:${sessionId}:${input.checkoutKey}`, async () => {
      const existing = await this.store.getCommerceOrderByCheckoutKey(sessionId, input.checkoutKey);
      if (existing) {
        if (JSON.stringify(existing.items) !== JSON.stringify(input.items)) return reject(409, 'CHECKOUT_KEY_REUSED', 'This checkout key already belongs to a different cart.');
        if (!existing.razorpayOrderId) return reject(409, existing.status === 'failed' ? 'ORDER_CREATION_FAILED' : 'ORDER_CREATION_UNKNOWN', existing.status === 'failed' ? 'Razorpay did not create this order. Start a new checkout after checking the provider configuration.' : 'The original provider request may have succeeded. This checkout is blocked to prevent duplicate orders; inspect its receipt in the Razorpay Test dashboard.');
        return { order: existing, keyId: this.keyId, mode: 'test' };
      }
      const now = new Date().toISOString();
      const order: CommerceOrder = { id: randomUUID(), checkoutKey: input.checkoutKey, status: 'creating', items: input.items, amountMinor: input.amountMinor, currency: 'INR', razorpayOrderId: null, razorpayPaymentId: null, createdAt: now, updatedAt: now, paidAt: null };
      // Persist the checkout key before contacting Razorpay. A restart cannot blindly repeat it.
      await this.store.saveCommerceOrder(sessionId, order);
      try {
        const response = object(await this.transport('POST', '/orders', { amount: order.amountMinor, currency: order.currency, receipt: order.id, partial_payment: false, notes: { application: 'BizPlus AI test storefront' } }));
        if (!response || typeof response.id !== 'string' || !ORDER_ID.test(response.id) || response.amount !== order.amountMinor || response.currency !== order.currency || response.receipt !== order.id || response.status !== 'created') throw new ProviderError('The provider order did not match this cart. Check the Razorpay Test dashboard before retrying.', true);
        order.razorpayOrderId = response.id; order.status = 'pending'; order.updatedAt = new Date().toISOString();
        await this.store.saveCommerceOrder(sessionId, order);
      } catch (error) {
        order.status = error instanceof ProviderError && !error.ambiguous ? 'failed' : 'provider_unknown'; order.updatedAt = new Date().toISOString();
        // A provider order ID may already have been returned even if persistence failed.
        await this.store.saveCommerceOrder(sessionId, order);
        if (error instanceof CommerceError) throw error;
        throw new ProviderError('The order could not be saved or verified. Do not start another payment; inspect the original checkout first.', true);
      }
      return { order, keyId: this.keyId, mode: 'test' };
    });
  }
  async verify(sessionId: string, id: string, body: unknown): Promise<CommerceOrder> {
    this.requireConfigured();
    const input = object(body);
    if (!input || Object.keys(input).some(key => !['razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature'].includes(key)) || typeof input.razorpay_order_id !== 'string' || !ORDER_ID.test(input.razorpay_order_id) || typeof input.razorpay_payment_id !== 'string' || !PAYMENT_ID.test(input.razorpay_payment_id)) reject(400, 'INVALID_PAYMENT_RESPONSE', 'Provide the original Razorpay order ID, payment ID, and signature.');
    const value = input as unknown as CommercePaymentVerification;
    return this.locked(`order:${id}`, async () => {
      const order = await this.find(sessionId, id);
      if (!order.razorpayOrderId || value.razorpay_order_id !== order.razorpayOrderId || !equalSignature(createHmac('sha256', this.keySecret).update(`${order.razorpayOrderId}|${value.razorpay_payment_id}`).digest('hex'), value.razorpay_signature)) return reject(400, 'PAYMENT_SIGNATURE_INVALID', 'The payment response signature does not match this order.');
      await this.rememberPayment(sessionId, order, value.razorpay_payment_id);
      return this.confirm(sessionId, order, value.razorpay_payment_id);
    });
  }
  private async confirm(sessionId: string, order: CommerceOrder, paymentId: string): Promise<CommerceOrder> {
    if (order.status === 'paid') {
      if (order.razorpayPaymentId !== paymentId) return reject(409, 'ORDER_ALREADY_PAID', 'This order already has a verified payment.');
      return order;
    }
    const responses = await Promise.all([
      this.transport('GET', `/payments/${paymentId}`),
      this.transport('GET', `/orders/${order.razorpayOrderId}`),
    ]);
    const payment = object(responses[0]);
    const providerOrder = object(responses[1]);
    if (!payment || payment.id !== paymentId || payment.order_id !== order.razorpayOrderId || payment.amount !== order.amountMinor || payment.currency !== order.currency || !providerOrder || providerOrder.id !== order.razorpayOrderId || providerOrder.receipt !== order.id || providerOrder.amount !== order.amountMinor || providerOrder.currency !== order.currency) return reject(409, 'PAYMENT_MISMATCH', 'Provider payment details do not match the original order and server-calculated total.');
    if (payment.status !== 'captured' || payment.captured !== true) {
      // Authorized and failed attempts do not fulfill an order or prevent a later retry.
      order.status = 'pending'; order.updatedAt = new Date().toISOString();
      await this.store.saveCommerceOrder(sessionId, order);
      return order;
    }
    if (providerOrder.status !== 'paid' || providerOrder.amount_paid !== order.amountMinor || providerOrder.amount_due !== 0 || payment.amount_refunded !== 0) return reject(409, 'CAPTURE_NOT_CONFIRMED', 'The captured payment and paid provider order have not been confirmed consistently. Try verification again shortly.');
    const now = new Date().toISOString();
    order.status = 'paid'; order.razorpayPaymentId = paymentId; order.updatedAt = now; order.paidAt = now;
    await this.store.saveCommerceOrder(sessionId, order);
    return order;
  }
  async webhook(req: Request): Promise<{ received: true; duplicate?: boolean; ignored?: boolean }> {
    this.requireConfigured();
    if (!this.webhookSecret) return reject(503, 'WEBHOOK_NOT_CONFIGURED', 'A Razorpay Test webhook secret is not configured.');
    if (!Buffer.isBuffer(req.body) || !equalSignature(createHmac('sha256', this.webhookSecret).update(req.body).digest('hex'), req.header('X-Razorpay-Signature'))) return reject(400, 'WEBHOOK_SIGNATURE_INVALID', 'The webhook signature is invalid.');
    const eventId = req.header('X-Razorpay-Event-Id');
    if (!eventId || eventId.length > 200) return reject(400, 'WEBHOOK_EVENT_REQUIRED', 'A Razorpay event ID is required.');
    const digest = createHash('sha256').update(req.body).digest('hex');
    return this.locked(`event:${eventId}`, async () => {
      const seen = this.webhookEvents.get(eventId);
      if (seen) { if (seen !== digest) return reject(409, 'WEBHOOK_EVENT_REUSED', 'This event ID has already been received with different content.'); return { received: true, duplicate: true }; }
      let payload: ObjectValue | null;
      try { payload = object(JSON.parse((req.body as Buffer).toString('utf8')) as unknown); }
      catch { return reject(400, 'INVALID_WEBHOOK', 'The webhook body must be valid JSON.'); }
      if (!payload || payload.event !== 'payment.captured') return { received: true, ignored: true };
      const entity = object(object(object(payload.payload)?.payment)?.entity);
      if (!entity || typeof entity.id !== 'string' || !PAYMENT_ID.test(entity.id) || typeof entity.order_id !== 'string' || !ORDER_ID.test(entity.order_id)) return reject(400, 'INVALID_WEBHOOK', 'The captured payment entity is invalid.');
      const found = await this.store.getCommerceOrderByProviderId(entity.order_id);
      if (!found) return { received: true, ignored: true };
      await this.locked(`order:${found.order.id}`, async () => {
        const order = await this.find(found.session, found.order.id);
        if (entity.amount !== order.amountMinor || entity.currency !== order.currency || entity.status !== 'captured' || entity.captured !== true) return reject(409, 'PAYMENT_MISMATCH', 'The webhook payment does not match the server order.');
        await this.rememberPayment(found.session, order, entity.id as string);
        const verified = await this.confirm(found.session, order, entity.id as string);
        if (verified.status !== 'paid') return reject(503, 'CAPTURE_NOT_CONFIRMED', 'Razorpay has not yet confirmed this capture. Retry this event after provider data converges.');
      });
      this.webhookEvents.set(eventId, digest);
      if (this.webhookEvents.size > 10_000) this.webhookEvents.delete(this.webhookEvents.keys().next().value!);
      return { received: true };
    });
  }
}

const services = new WeakMap<object, CommerceService>();
function service(store: CommerceStore, options: CommerceOptions): CommerceService {
  let value = services.get(store);
  if (!value) { value = new CommerceService(store, options); services.set(store, value); }
  return value;
}
function route(task: (req: Request, res: Response) => Promise<unknown> | unknown) {
  return async (req: Request, res: Response) => {
    try { await task(req, res); }
    catch (error) {
      if (error instanceof CommerceError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
      // Never include provider credentials or raw payment details in responses/logs.
      res.status(500).json({ error: 'This order could not be completed. Check its status before starting another payment.', code: 'COMMERCE_ERROR' });
    }
  };
}
/** Register before express.json() and the session middleware; signatures cover raw bytes. */
export function registerCommerceWebhook(app: Express, store: CommerceStore, options: CommerceOptions = {}): void {
  const integration = service(store, options);
  app.post('/api/shop/webhook', express.raw({ type: 'application/json', limit: '64kb' }), route(async (req, res) => { res.json(await integration.webhook(req)); }));
}
/** Register after the API session/rate middleware. */
export function registerCommerce(app: Express, store: CommerceStore, options: CommerceOptions = {}): void {
  const integration = service(store, options);
  app.get('/api/shop/config', route((_req, res) => { session(res); res.json(integration.config); }));
  app.get('/api/shop/products', route((_req, res) => { session(res); res.json(PRODUCTS); }));
  app.post('/api/shop/orders', route(async (req, res) => { res.status(201).json(await integration.create(session(res), req.body)); }));
  app.get('/api/shop/orders', route(async (_req, res) => { res.json({ orders: await store.listCommerceOrders(session(res)) }); }));
  app.get('/api/shop/orders/:id', route(async (req, res) => {
    res.json(await integration.get(session(res), String(req.params.id)));
  }));
  app.post('/api/shop/orders/:id/verify', route(async (req, res) => { res.json(await integration.verify(session(res), String(req.params.id), req.body)); }));
}
