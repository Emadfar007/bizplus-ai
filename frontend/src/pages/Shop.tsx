import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, CheckCircle2, Loader2, LockKeyhole, Minus, Plus, ReceiptText, RefreshCw, ShieldCheck, ShoppingBag, ShoppingCart, TriangleAlert, X } from 'lucide-react';
import type { CommerceConfig, CommerceOrder, CommercePaymentVerification, Product } from '@bizplus/shared';
import type { Workspace } from '../hooks/useWorkspace';
import { Badge, EmptyState, SectionLabel, shortId, time } from '../components/UI';
import { commerceApi, loadRazorpay, type RazorpayInstance } from '../services/commerce';

interface CartState { items: Record<string, number>; checkoutKey: string | null; orderId: string | null }
const MAX_CART_ITEMS = 10;
const blankCart = (): CartState => ({ items: {}, checkoutKey: null, orderId: null });
const cartStorageKey = (session: string) => `bizplus.cart.v1.${session}`;
const receiptStorageKey = (session: string) => `bizplus.receipt.v1.${session}`;
function readReceipt(session: string): string | null { try { return localStorage.getItem(receiptStorageKey(session)); } catch { return null; } }
function readCart(session: string): CartState {
  try {
    const stored = JSON.parse(localStorage.getItem(cartStorageKey(session)) || 'null') as CartState | null;
    if (stored && typeof stored.items === 'object' && stored.items !== null) {
      const items = Object.fromEntries(Object.entries(stored.items).filter(([id, quantity]) => id.startsWith('bp-') && Number.isInteger(quantity) && quantity > 0 && quantity <= 5));
      return { items, checkoutKey: typeof stored.checkoutKey === 'string' ? stored.checkoutKey : null, orderId: typeof stored.orderId === 'string' ? stored.orderId : null };
    }
  } catch { /* The cart still works if browser storage is unavailable. */ }
  return blankCart();
}
const money = (minor: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: minor % 100 ? 2 : 0 }).format(minor / 100);
const productIllustrations: Record<string, string> = {
  'bp-headphones': '/assets/figma/bp-headphones.svg',
  'bp-keyboard': '/assets/figma/bp-keyboard.svg',
  'bp-speaker': '/assets/figma/bp-speaker.svg',
  'bp-watch': '/assets/figma/bp-watch.svg',
  'bp-backpack': '/assets/figma/bp-backpack.svg',
  'bp-desk-lamp': '/assets/figma/bp-desk-lamp.svg',
};
function ProductVisual({ product }: { product: Product }) {
  return <div className="product-visual"><img src={productIllustrations[product.id] || product.image} width={180} height={145} alt="" aria-hidden="true"/></div>;
}

export default function Shop({ workspace }: { workspace: Workspace }) {
  const session = workspace.session;
  const [products, setProducts] = useState<Product[]>([]);
  const [category, setCategory] = useState('All essentials');
  const [config, setConfig] = useState<CommerceConfig | null>(null);
  const [orders, setOrders] = useState<CommerceOrder[]>([]);
  const [cart, setCart] = useState<CartState>(() => readCart(session));
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(() => readCart(session).orderId || readReceipt(session));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  const cartRef = useRef(cart);
  const paymentRef = useRef<RazorpayInstance | null>(null);
  const requestBusy = useRef(false);
  const verifying = useRef(false);
  const notifiedPaid = useRef(new Set<string>());
  const selectedOrderRef = useRef(selectedOrderId);
  const ordersRef = useRef(orders);
  const captureProofOrder = useRef<string | null>(null);
  const reconciliation = useRef<{ id: string | null; deadline: number; expiredNotice: boolean; busy: boolean }>({ id: null, deadline: 0, expiredNotice: false, busy: false });
  cartRef.current = cart;
  selectedOrderRef.current = selectedOrderId;
  ordersRef.current = orders;
  const current = useCallback(() => alive.current && workspace.isCurrentSession(session), [session, workspace.isCurrentSession]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; paymentRef.current?.close(); }; }, []);
  useEffect(() => { try { localStorage.setItem(cartStorageKey(session), JSON.stringify(cart)); } catch { /* In-memory cart remains available. */ } }, [cart, session]);
  useEffect(() => { try { if (selectedOrderId) localStorage.setItem(receiptStorageKey(session), selectedOrderId); } catch { /* The receipt remains visible in memory. */ } }, [selectedOrderId, session]);
  const applyOrder = useCallback((order: CommerceOrder) => {
    if (!current()) return;
    setOrders(previous => {
      const existing = previous.find(item => item.id === order.id);
      const update = existing?.status === 'paid' && order.status !== 'paid' ? existing : order;
      return [update, ...previous.filter(item => item.id !== order.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
    if (order.status === 'paid' && cartRef.current.checkoutKey === order.checkoutKey) {
      const empty = blankCart(); cartRef.current = empty; setCart(empty);
      if (!notifiedPaid.current.has(order.id)) { notifiedPaid.current.add(order.id); setNotice('Payment verified by the server. Your original order is paid and the receipt is ready.'); }
    }
  }, [current]);
  const refreshOrders = useCallback(async (manual = false) => {
    try {
      const knownId = cartRef.current.orderId || selectedOrderRef.current;
      const known = ordersRef.current.find(order => order.id === knownId);
      const paymentReceived = !!known && (!!known.razorpayPaymentId || captureProofOrder.current === known.id);
      if (knownId && known && paymentReceived && ['pending', 'creating', 'provider_unknown'].includes(known.status)) {
        const state = reconciliation.current;
        if (state.id !== knownId) { state.id = knownId; state.deadline = Date.now() + 120000; state.expiredNotice = false; }
        if ((manual || Date.now() < state.deadline) && !state.busy) {
          state.busy = true;
          try { const reconciled = await commerceApi.order(session, knownId); if (!current()) return; applyOrder(reconciled); }
          catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : 'The pending order could not be reconciled.'); }
          finally { state.busy = false; }
        } else if (Date.now() >= state.deadline && !state.expiredNotice) {
          state.expiredNotice = true;
          if (current()) setNotice('This order is still pending after two minutes. Use Refresh orders to check capture later; its original order and checkout key are preserved.');
        }
      } else if (known && !paymentReceived) {
        // Opening or cancelling an unpaid checkout is not a capture wait.
        // Begin the bounded clock only after an actual payment response arrives.
        reconciliation.current.id = null;
        reconciliation.current.deadline = 0;
        reconciliation.current.expiredNotice = false;
        if (current()) setNotice(previous => previous?.startsWith('This order is still pending after two minutes.') ? null : previous);
      }
      if (!current()) return;
      const result = await commerceApi.orders(session);
      if (!current()) return;
      setOrders(previous => result.orders.map(order => previous.find(existing => existing.id === order.id && existing.status === 'paid') || order));
      const paid = result.orders.find(order => order.status === 'paid' && order.checkoutKey === cartRef.current.checkoutKey);
      if (paid) applyOrder(paid);
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : 'Order history could not be loaded.'); }
  }, [session, current, applyOrder]);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const results = await Promise.allSettled([commerceApi.products(session), commerceApi.config(session), commerceApi.orders(session)]);
    if (!current()) return;
    if (results[0].status === 'fulfilled') setProducts(results[0].value);
    if (results[1].status === 'fulfilled') setConfig(results[1].value);
    if (results[2].status === 'fulfilled') {
      setOrders(previous => results[2].status === 'fulfilled' ? results[2].value.orders.map(order => previous.find(existing => existing.id === order.id && existing.status === 'paid') || order) : previous);
      const paid = results[2].value.orders.find(order => order.status === 'paid' && order.checkoutKey === cartRef.current.checkoutKey);
      if (paid) { setSelectedOrderId(paid.id); applyOrder(paid); }
    }
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') setError(failure.reason instanceof Error ? failure.reason.message : 'The storefront could not be loaded.');
    setLoading(false);
  }, [session, current, applyOrder]);
  useEffect(() => { if (workspace.connection === 'ready') void load(); }, [workspace.connection, load]);
  useEffect(() => {
    if (workspace.connection !== 'ready') return;
    let cancelled = false, polling = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() { if (cancelled || polling) return; polling = true; try { if (!document.hidden) await refreshOrders(); } finally { polling = false; } if (!cancelled) timer = setTimeout(poll, 5000); }
    timer = setTimeout(poll, 5000);
    const visibility = () => { if (!document.hidden) { clearTimeout(timer); void poll(); } };
    document.addEventListener('visibilitychange', visibility);
    return () => { cancelled = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [workspace.connection, refreshOrders]);

  const lines = products.filter(product => cart.items[product.id]).map(product => ({ product, quantity: cart.items[product.id] }));
  const quantity = lines.reduce((sum, line) => sum + line.quantity, 0);
  const subtotal = lines.reduce((sum, line) => sum + line.product.priceMinor * line.quantity, 0);
  const visibleProducts = category === 'All essentials' ? products : products.filter(product => product.category === category);
  const selectedOrder = orders.find(order => order.id === selectedOrderId) || null;
  const checkoutOrder = orders.find(order => order.id === cart.orderId) || null;
  const awaitingCapture = !!checkoutOrder && checkoutOrder.status !== 'paid' && checkoutOrder.status !== 'failed' && (!!checkoutOrder.razorpayPaymentId || captureProofOrder.current === checkoutOrder.id);
  const cartLocked = busy || paymentOpen || awaitingCapture;
  const historyPolicy = workspace.metrics?.historyPolicy || workspace.health?.historyPolicy;
  const storageDescription = historyPolicy === 'temporary' ? 'Temporary hosted history · resets after restart' : historyPolicy === 'cloud' ? 'Cloud database' : historyPolicy === 'local' ? 'Local SQLite history' : config?.database === 'postgres' ? 'Cloud database' : 'Checking history storage…';
  function changeQuantity(id: string, change: number) {
    if (cartLocked) return;
    const items = { ...cartRef.current.items };
    const nextQuantity = Math.max(0, Math.min(5, (items[id] || 0) + change));
    if (nextQuantity === items[id]) return;
    const totalItems = Object.values(items).reduce((sum, itemQuantity) => sum + itemQuantity, 0);
    if (nextQuantity > (items[id] || 0) && totalItems >= MAX_CART_ITEMS) { setError('Your test cart can contain up to 10 items. Remove an item before adding another.'); return; }
    if (nextQuantity) items[id] = nextQuantity; else delete items[id];
    const next = { items, checkoutKey: Object.keys(items).length ? crypto.randomUUID() : null, orderId: null };
    cartRef.current = next; setCart(next); setError(null); setNotice(null);
  }
  function restoreOrder(order: CommerceOrder) {
    if (cartLocked || order.status === 'paid') return;
    const restored = { items: Object.fromEntries(order.items.map(item => [item.productId, item.quantity])), checkoutKey: order.checkoutKey, orderId: order.id };
    cartRef.current = restored; setCart(restored); setSelectedOrderId(order.id); setError(null);
    setNotice('This saved order is back in your cart. Resume checkout to retry its existing provider order.');
  }
  async function verify(order: CommerceOrder, response: CommercePaymentVerification) {
    if (!current()) return;
    captureProofOrder.current = order.id;
    reconciliation.current.id = order.id;
    reconciliation.current.deadline = Date.now() + 120000;
    reconciliation.current.expiredNotice = false;
    verifying.current = true; setBusy(true); setPaymentOpen(false); setNotice('Payment response received. The server is checking its signature and capture status…');
    try {
      const verifiedOrder = await commerceApi.verify(session, order.id, response);
      if (!current()) return;
      applyOrder(verifiedOrder); setSelectedOrderId(verifiedOrder.id);
      if (verifiedOrder.status !== 'paid') setNotice('The payment is awaiting capture confirmation. This order will update when the server verifies it.');
    } catch (cause) { if (current()) { setNotice(null); setError(cause instanceof Error ? cause.message : 'Payment verification failed. The order remains pending until verified.'); } }
    finally { if (current()) { verifying.current = false; requestBusy.current = false; setBusy(false); } }
  }
  async function checkout() {
    if (!current() || requestBusy.current || awaitingCapture || !config?.configured || !config.keyId || !lines.length || quantity > MAX_CART_ITEMS || subtotal > 1000000 || workspace.connection !== 'ready') return;
    requestBusy.current = true; setBusy(true); setError(null); setNotice(null);
    const requestedCart = cartRef.current;
    const checkoutKey = requestedCart.checkoutKey || crypto.randomUUID();
    const stored = { ...requestedCart, checkoutKey }; cartRef.current = stored; setCart(stored);
    try {
      const result = await commerceApi.checkout(session, lines.map(line => ({ productId: line.product.id, quantity: line.quantity })), checkoutKey);
      if (!current()) return;
      applyOrder(result.order); setSelectedOrderId(result.order.id);
      if (result.order.status === 'paid') { requestBusy.current = false; setBusy(false); return; }
      const next = { ...cartRef.current, orderId: result.order.id }; cartRef.current = next; setCart(next);
      if (result.mode !== 'test' || !result.keyId.startsWith('rzp_test_')) throw new Error('This storefront accepts Razorpay Test Mode only. The server configuration needs a test key.');
      if (!result.order.razorpayOrderId || result.order.status === 'provider_unknown' || result.order.status === 'creating') throw new Error('The provider order is not ready. Keep this order and refresh its status; another payment order will not be created automatically.');
      const Razorpay = await loadRazorpay();
      if (!current()) return;
      const instance = new Razorpay({ key: result.keyId, amount: result.order.amountMinor, currency: result.order.currency, name: 'BizPlus Select', description: 'Test purchase · no live charges', order_id: result.order.razorpayOrderId, theme: { color: '#248b80' }, handler: response => { void verify(result.order, response); }, modal: { ondismiss: () => { if (!current() || verifying.current) return; setPaymentOpen(false); setBusy(false); requestBusy.current = false; setNotice('Checkout closed. Your pending order is saved; retrying the unchanged cart reuses the same order.'); void refreshOrders(); } } });
      instance.on('payment.failed', response => { if (current()) setError(response.error?.description || 'This payment attempt failed. You can retry in checkout or close it and resume the same saved order.'); });
      paymentRef.current = instance; setPaymentOpen(true); setBusy(false); instance.open();
    } catch (cause) { if (current()) { setError(cause instanceof Error ? cause.message : 'Checkout could not start.'); requestBusy.current = false; setBusy(false); setPaymentOpen(false); } }
  }
  const purchaseStage = cart.orderId || paymentOpen || busy ? 2 : selectedOrder?.status === 'paid' && quantity === 0 ? 3 : 1;
  return <div className="shop-page">
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{quantity ? `Cart updated: ${quantity} ${quantity === 1 ? 'item' : 'items'}, total ${money(subtotal)}.` : 'Your cart is empty.'}</p>
    <section className="shop-hero">
      <SectionLabel>BIZPLUS SELECT · TEST STOREFRONT</SectionLabel>
      <h1>Everyday essentials. Thoughtfully chosen.</h1>
      <p>Six demo products. A real Razorpay Test Mode checkout. A receipt verified by the server.</p>
    </section>
    <div className="shop-cart-shortcut">
      <span>{quantity} {quantity === 1 ? 'item' : 'items'} · {money(subtotal)}</span>
      <a className="primary-button" href="#shopping-cart">View cart</a>
    </div>
    {error ? <div className="feedback error" role="alert"><TriangleAlert size={20}/><span>{error}</span><button className="text-button" onClick={() => void load()}>Refresh</button><button className="icon-button" aria-label="Dismiss storefront error" onClick={() => setError(null)}><X size={20}/></button></div> : null}
    {notice ? <div className="feedback notice" role="status"><CheckCircle2 size={20}/><span>{notice}</span><button className="icon-button" aria-label="Dismiss storefront message" onClick={() => setNotice(null)}><X size={20}/></button></div> : null}
    <ol className="shop-purchase-guide" aria-label="Test purchase progress">
      <li className={purchaseStage >= 1 ? 'current' : ''} aria-current={purchaseStage === 1 ? 'step' : undefined}>1&nbsp; Choose products</li>
      <li className={purchaseStage >= 2 ? 'current' : ''} aria-current={purchaseStage === 2 ? 'step' : undefined}>2&nbsp; Test checkout</li>
      <li className={purchaseStage === 3 ? 'current' : ''} aria-current={purchaseStage === 3 ? 'step' : undefined}>3&nbsp; Verified receipt</li>
    </ol>
    <section className={`shop-config ${config?.configured ? 'configured' : ''}`} aria-label="Test checkout information">
      <strong>{config && !config.configured ? 'Test checkout needs setup.' : 'Test payments. No real charge or delivery.'}</strong>
      <p>{config && !config.configured ? config.message : 'Choose a product, complete test checkout, and follow the verified receipt.'}</p>
      <span className="sr-only">{config ? config.configured ? 'Razorpay Test Mode is connected.' : 'Payment setup is required.' : 'Checking payment configuration.'}</span>
    </section>
    <div className="shop-layout">
      <section className="catalog-section" aria-label="Demo product collection">
        <h2 className="sr-only">The essentials collection</h2>
        <div className="shop-categories" aria-label="Filter products by category">
          {['All essentials', 'Audio', 'Workspace'].map(item => <button key={item} className={category === item ? 'primary-button' : 'secondary-button'} aria-pressed={category === item} onClick={() => setCategory(item)}>{item}</button>)}
        </div>
        <p className="sr-only" role="status" aria-live="polite">{visibleProducts.length} products shown in {category}.</p>
        {loading && !products.length ? <div className="panel"><EmptyState icon={Loader2} title="Loading the collection">Fetching the product catalog and current prices from the server.</EmptyState></div> : products.length ? <div className="product-grid">
          {visibleProducts.map(product => <article className="product-card" key={product.id} aria-label={product.name}>
            <div className="product-image-wrap"><ProductVisual product={product}/></div>
            <span className="product-category">{product.category}</span>
            <h3>{product.name}</h3>
            <p className="sr-only">{product.description}</p>
            <strong className="product-price">{money(product.priceMinor)}</strong>
            <button className="secondary-button add-cart-button" disabled={cartLocked || quantity >= MAX_CART_ITEMS || (cart.items[product.id] || 0) >= 5} onClick={() => changeQuantity(product.id, 1)} aria-label={`Add ${product.name} to cart`}>Add to cart{cart.items[product.id] ? <span aria-label={`${cart.items[product.id]} in cart`}>{cart.items[product.id]}</span> : null}</button>
          </article>)}
        </div> : <div className="panel"><EmptyState icon={ShoppingBag} title="The collection is unavailable">Reconnect to the backend or refresh to retrieve the catalog.</EmptyState></div>}
      </section>
      <aside className="cart-panel panel" id="shopping-cart" tabIndex={-1} aria-label="Shopping cart">
        <div className="panel-header"><h2>Your cart</h2>{quantity ? <span className="cart-count"><ShoppingCart size={18}/>{quantity}</span> : null}</div>
        {lines.length ? <>
          <div className="cart-lines">{lines.map(({ product, quantity: itemQuantity }) => <div className="cart-line" key={product.id}>
            <div className="cart-line-copy"><strong>{product.name}</strong><span>{money(product.priceMinor)} each</span>
              <div className="quantity-control"><button disabled={cartLocked} onClick={() => changeQuantity(product.id, -1)} aria-label={`Remove one ${product.name}`}><Minus size={18}/></button><span>{itemQuantity}</span><button disabled={cartLocked || quantity >= MAX_CART_ITEMS || itemQuantity >= 5} onClick={() => changeQuantity(product.id, 1)} aria-label={`Add one ${product.name}`}><Plus size={18}/></button></div>
            </div><strong className="line-price">{money(product.priceMinor * itemQuantity)}</strong>
          </div>)}</div>
          <div className="cart-totals"><div><span>Subtotal</span><strong>{money(subtotal)}</strong></div><div><span>Delivery</span><span className="cyan">Test purchase</span></div><div className="cart-grand-total"><span>Total</span><strong>{money(subtotal)}</strong></div></div>
          {quantity > MAX_CART_ITEMS ? <p className="cart-limit" role="alert">This saved cart contains more than 10 items. Reduce a quantity to continue.</p> : null}
          {subtotal > 1000000 ? <p className="cart-limit">This test order exceeds ₹10,000. Reduce a quantity to continue.</p> : null}
          <button className="primary-button checkout-button" disabled={!config?.configured || quantity > MAX_CART_ITEMS || subtotal > 1000000 || workspace.connection !== 'ready' || cartLocked} onClick={() => void checkout()}>{busy ? <Loader2 className="spin" size={18}/> : <LockKeyhole size={18}/>} {busy ? 'Checking your order…' : paymentOpen ? 'Checkout is open' : awaitingCapture ? 'Awaiting capture verification' : cart.orderId ? 'Resume test checkout' : 'Pay with Razorpay'}</button>
          <p className="cart-disclaimer">Test payments only. Up to 10 items, 5 of each product, and ₹10,000 per order. The server verifies your payment before marking this order paid.</p>
          {cart.orderId ? <div className="pending-order-note"><ReceiptText size={18}/><span>Saved order <code>{shortId(cart.orderId)}</code><small>{awaitingCapture ? 'Payment received. This cart stays bound to its original order while capture is checked.' : 'Unchanged-cart retries reuse this order.'}</small>{awaitingCapture ? <button className="text-button capture-refresh" onClick={() => void refreshOrders(true)}><RefreshCw size={16}/> Check capture status</button> : null}</span></div> : null}
        </> : <div className="cart-empty"><p>A little room for something good.</p><p>Add an essential to start a test purchase.</p><button className="primary-button checkout-button" disabled>Pay with Razorpay</button><small>Up to 10 items · No real charge</small></div>}
      </aside>
    </div>
    <section className="shop-orders" aria-label="Purchase history">
      {orders.length ? <>
        <div className="section-heading"><h2>Your receipts, in one place.</h2><button className="text-button" onClick={() => void refreshOrders(true)}><RefreshCw size={18}/> Refresh orders</button></div>
        <div className="orders-layout"><div className="order-list panel">{orders.map(order => <button key={order.id} aria-pressed={order.id === selectedOrderId} aria-label={`Inspect ${order.status.replace(/_/g, ' ')} order ${shortId(order.id)}, ${money(order.amountMinor)}`} className={`shop-order-row ${order.id === selectedOrderId ? 'selected' : ''}`} onClick={() => setSelectedOrderId(order.id)}>
          <span className={`order-row-icon ${order.status}`}>{order.status === 'paid' ? <Check size={20}/> : <ReceiptText size={20}/>}</span><span className="order-row-copy"><strong>{order.items.map(item => item.name).join(', ')}</strong><small>{time(order.createdAt)} · {shortId(order.id)}</small></span><strong>{money(order.amountMinor)}</strong><Badge status={order.status === 'paid' ? 'passed' : order.status === 'failed' ? 'failed' : 'pending'}>{order.status === 'provider_unknown' ? 'Provider status unknown' : order.status}</Badge><ArrowUpRight size={18}/>
        </button>)}</div>
        <div className="panel order-receipt"><div className="panel-header"><h2>{selectedOrder?.status === 'paid' ? 'Payment verified' : 'Order details'}</h2>{selectedOrder?.status === 'paid' ? <ShieldCheck size={24} className="cyan"/> : <ReceiptText size={24} className="muted"/>}</div>
          {selectedOrder ? <><div className={`receipt-status ${selectedOrder.status}`}><Badge status={selectedOrder.status === 'paid' ? 'passed' : 'pending'}>{selectedOrder.status === 'paid' ? 'Paid · server verified' : selectedOrder.status.replace(/_/g, ' ')}</Badge><strong>{money(selectedOrder.amountMinor)}</strong></div>
          <div className="receipt-lines">{selectedOrder.items.map(item => <div key={item.productId}><span>{item.quantity} × {item.name}</span><strong>{money(item.lineAmountMinor)}</strong></div>)}</div>
          <details className="receipt-details"><summary>Payment references &amp; storage</summary><dl className="receipt-identifiers"><div><dt>Order</dt><dd>{selectedOrder.id}</dd></div><div><dt>Provider order</dt><dd>{selectedOrder.razorpayOrderId || 'Awaiting provider'}</dd></div><div><dt>Payment</dt><dd>{selectedOrder.razorpayPaymentId || 'Not captured yet'}</dd></div><div><dt>History storage</dt><dd>{storageDescription}</dd></div></dl></details>
          {selectedOrder.status !== 'paid' ? <div className="receipt-pending-copy"><p>A pending or unknown order is never shown as paid. Its status changes only after the server verifies the provider response.</p><button className="secondary-button" disabled={cartLocked} onClick={() => restoreOrder(selectedOrder)}>Restore saved order to cart <ArrowRight size={18}/></button></div> : <div className="receipt-verified"><CheckCircle2 size={20}/><span>{historyPolicy === 'temporary' ? 'Payment verified · temporary hosted receipt' : 'Payment verified · receipt saved'}</span></div>}</> : <EmptyState icon={ReceiptText} title="Select an order">Inspect its items, payment references, and verified status.</EmptyState>}
        </div></div>
      </> : <div className="panel shop-empty-history"><h2>Your receipts, in one place.</h2><p>Orders appear after checkout. A receipt is marked paid only after server verification.</p></div>}
    </section>
  </div>;
}
