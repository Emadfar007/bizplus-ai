import { Router, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AMOUNT_MINOR, PRODUCT_ID, type Store } from '../database/store.js';

export function createSandbox(store: Store, nonce: string, latencyMs: number) {
  const router = Router(); const pending = new Set<Promise<void>>();
  router.use((req, res, next) => {
    const supplied = req.header('X-Sandbox-Key') ?? '';
    const suppliedBytes = Buffer.from(supplied); const nonceBytes = Buffer.from(nonce);
    if (suppliedBytes.length !== nonceBytes.length || !timingSafeEqual(suppliedBytes, nonceBytes)) { res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' }); return; }
    const runId = req.header('X-Sandbox-Run') ?? '';
    if (!store.getRun(runId)) { res.status(404).json({ error: 'Run not found', code: 'NOT_FOUND' }); return; }
    res.locals.runId = runId; next();
  });
  const route = (handler: (req: Request, res: Response, runId: string) => void) => (req: Request, res: Response) => {
    const task = (async () => {
      if (latencyMs > 0) await delay(latencyMs);
      if (res.destroyed) return;
      const runId = res.locals.runId as string;
      if (req.path !== '/login' && req.header('Authorization') !== `Bearer sandbox:${runId}`) {
        store.log(runId, 'Synthetic authentication token was rejected.'); res.status(401).json({ error: 'Synthetic token rejected' }); return;
      }
      handler(req, res, runId);
    })().catch(error => { if (!res.headersSent && !res.destroyed) res.status(500).json({ error: error instanceof Error ? error.message : 'Sandbox operation failed' }); }).finally(() => pending.delete(task));
    pending.add(task);
  };
  router.post('/login', route((_req, res, runId) => {
    store.log(runId, 'Authenticated the synthetic demo shopper; no real credentials were used.');
    res.json({ authenticated: true, token: `sandbox:${runId}` });
  }));
  router.get('/inventory', route((_req, res, runId) => {
    store.log(runId, 'Inventory check: BP-HEADSET has 12 items; synthetic unit price is INR 1,299.00.');
    res.json({ productId: PRODUCT_ID, stock: 12, priceMinor: AMOUNT_MINOR, currency: 'INR' });
  }));
  router.post('/cart', route((req, res, runId) => {
    if (req.body?.productId !== PRODUCT_ID || req.body?.quantity !== 1) { res.status(400).json({ error: 'Only the fixed synthetic product is allowed' }); return; }
    store.log(runId, 'Created a sandbox cart containing one synthetic headset.');
    res.json({ cartId: `cart:${runId}`, productId: PRODUCT_ID, quantity: 1, amountMinor: AMOUNT_MINOR, currency: 'INR' });
  }));
  router.post('/checkout', route((req, res, runId) => {
    const run = store.getRun(runId)!;
    if (req.body?.idempotencyKey !== `checkout:${runId}` || req.body?.amountMinor !== AMOUNT_MINOR) { res.status(400).json({ error: 'Checkout requires the original run key and amount' }); return; }
    if (run.scenario === 'checkout_500') {
      store.log(runId, 'Injected checkout HTTP 500 before payment creation. Ledger unchanged.');
      res.status(500).json({ error: 'Injected checkout service unavailable', paymentCreated: false }); return;
    }
    const payment = store.checkout(runId, run.scenario === 'receipt_order_missing');
    store.log(runId, `Exactly one simulated payment exists for order ${payment.order_id}. No real money was charged.`);
    if (run.scenario === 'receipt_order_missing') store.log(runId, `Confirmation worker paused for order ${payment.order_id}; HTTP transport may succeed while the business outcome is missing.`);
    else store.log(runId, `Confirmation worker completed for order ${payment.order_id}.`);
    res.json({ paid: true, orderId: payment.order_id, transactionId: payment.transaction_id, amountMinor: payment.amount_minor, currency: 'INR' });
  }));
  router.get('/orders/:orderId', route((req, res, runId) => {
    const order = store.order(String(req.params.orderId), runId);
    if (!order) { res.status(404).json({ error: 'Original order not found' }); return; }
    store.log(runId, order.confirmed ? `Verified confirmed original order ${order.orderId}.` : `HTTP 200 returned for ${order.orderId}, but confirmation is missing; worker state ${order.workerState}.`);
    res.json({ order: order.confirmed ? { orderId: order.orderId, transactionId: order.transactionId, amountMinor: order.amountMinor, currency: 'INR', confirmed: true } : null,
      receipt: { orderId: order.orderId, transactionId: order.transactionId, amountMinor: order.amountMinor }, workerState: order.workerState });
  }));
  return { router, drain: async () => { await Promise.allSettled([...pending]); } };
}
