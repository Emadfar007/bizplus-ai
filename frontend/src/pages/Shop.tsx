import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowRight, ArrowUpRight, Check, CheckCircle2, CreditCard, Loader2, LockKeyhole, Minus, PackageCheck, Plus, ReceiptText, RefreshCw, ShieldCheck, ShoppingBag, ShoppingCart, TriangleAlert, X } from 'lucide-react';
import type { CommerceConfig, CommerceOrder, CommercePaymentVerification, Product } from '@bizplus/shared';
import type { Workspace } from '../hooks/useWorkspace';
import { Badge, EmptyState, SectionLabel, shortId, time } from '../components/UI';
import { commerceApi, loadRazorpay, type RazorpayInstance } from '../services/commerce';

interface CartState { items: Record<string, number>; checkoutKey: string | null; orderId: string | null }
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
function ProductVisual({ product, compact = false }: { product: Product; compact?: boolean }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return <div className={`product-visual ${compact ? 'compact' : ''}`} style={{ '--product-accent': product.accent } as CSSProperties}><div className="product-halo"/><svg viewBox="0 0 180 145" aria-hidden="true"><ellipse cx="90" cy="130" rx="51" ry="5" fill="currentColor" opacity=".08"/>
    {product.id.includes('headphones') ? <g {...common}><path d="M46 84V66c0-57 88-57 88 0v18" strokeWidth="9" opacity=".35"/><path d="M46 78V65c0-49 88-49 88 0v13" strokeWidth="4"/><rect x="35" y="70" width="29" height="49" rx="11" fill="currentColor" fillOpacity=".12"/><rect x="116" y="70" width="29" height="49" rx="11" fill="currentColor" fillOpacity=".12"/><path d="M46 79v31M134 79v31" opacity=".5"/></g> : product.id.includes('keyboard') ? <g {...common} transform="rotate(-10 90 75)"><rect x="22" y="40" width="137" height="75" rx="9" fill="currentColor" fillOpacity=".08"/>{[0,1,2].map(row => <g key={row}>{[0,1,2,3,4,5,6,7,8].map(col => <rect key={col} x={31 + col * 13.5} y={50 + row * 15} width="9" height="9" rx="2" strokeWidth="1.5" opacity={.7}/>)}</g>)}<rect x="54" y="95" width="66" height="9" rx="2" strokeWidth="1.5"/><path d="M33 119h115" opacity=".25"/></g> : product.id.includes('speaker') ? <g {...common}><rect x="44" y="24" width="92" height="99" rx="20" fill="currentColor" fillOpacity=".07"/><circle cx="90" cy="77" r="28" strokeWidth="3"/><circle cx="90" cy="77" r="21" opacity=".35"/><circle cx="90" cy="77" r="7" fill="currentColor" fillOpacity=".12"/><path d="M72 38h22" opacity=".5"/><circle cx="108" cy="38" r="2" fill="currentColor"/></g> : product.id.includes('watch') ? <g {...common} transform="rotate(12 90 75)"><path d="M72 40V10h36v30M72 106v29h36v-29" fill="currentColor" fillOpacity=".09"/><rect x="58" y="34" width="64" height="75" rx="19" fill="currentColor" fillOpacity=".12"/><rect x="64" y="41" width="52" height="61" rx="13" opacity=".25"/><path d="M90 55v17l12 8" strokeWidth="3"/><circle cx="90" cy="72" r="20" opacity=".5"/><path d="M124 56v11" strokeWidth="4"/></g> : product.id.includes('backpack') ? <g {...common}><path d="M60 44C60 8 120 8 120 44M67 24v-9h46v9" opacity=".55"/><rect x="48" y="31" width="84" height="94" rx="22" fill="currentColor" fillOpacity=".1"/><rect x="63" y="71" width="54" height="37" rx="10"/><path d="M68 83h41M44 51l-7 23v36M136 51l7 23v36M68 51h43" opacity=".55"/><path d="M105 78v11" strokeWidth="4"/></g> : <g {...common}><path d="M78 17h38l19 34H60z" fill="currentColor" fillOpacity=".15"/><path d="M94 52v29l-23 39M94 82l31 38" strokeWidth="4"/><path d="M58 121h78" strokeWidth="5"/><ellipse cx="98" cy="54" rx="40" ry="10" fill="currentColor" fillOpacity=".05" stroke="none"/><path d="M66 65l-7 20M130 65l8 20" opacity=".15"/></g>}
  </svg>{!compact ? <span className="visual-spec">BIZPLUS / SELECT</span> : null}</div>;
}

export default function Shop({ workspace }: { workspace: Workspace }) {
  const session = workspace.session;
  const [products, setProducts] = useState<Product[]>([]);
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
  const selectedOrder = orders.find(order => order.id === selectedOrderId) || null;
  const checkoutOrder = orders.find(order => order.id === cart.orderId) || null;
  const awaitingCapture = !!checkoutOrder && checkoutOrder.status !== 'paid' && checkoutOrder.status !== 'failed' && (!!checkoutOrder.razorpayPaymentId || captureProofOrder.current === checkoutOrder.id);
  const cartLocked = busy || paymentOpen || awaitingCapture;
  function changeQuantity(id: string, change: number) {
    if (cartLocked) return;
    const items = { ...cartRef.current.items };
    const nextQuantity = Math.max(0, Math.min(5, (items[id] || 0) + change));
    if (nextQuantity === items[id]) return;
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
    if (!current() || requestBusy.current || awaitingCapture || !config?.configured || !config.keyId || !lines.length || workspace.connection !== 'ready') return;
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
  return <>
    <section className="shop-hero"><div><SectionLabel><ShoppingBag size={13}/> BIZPLUS SELECT / TEST STOREFRONT</SectionLabel><h1>Good things.<br/><span>Great everyday.</span></h1><p>A considered collection for work, play, and everything between. Add something to your cart and follow its real test payment from checkout to verified receipt.</p><div className="shop-hero-tags"><span><ShieldCheck size={14}/> Razorpay Test Mode</span><span><PackageCheck size={14}/> Server-priced orders</span><span><ReceiptText size={14}/> Verified receipts</span></div></div><div className="shop-hero-art" aria-hidden="true"><span className="shop-art-line"/><ShoppingBag size={73} strokeWidth={1}/><div><span>THE EVERYDAY EDIT</span><strong>Six essentials.<br/>One smooth checkout.</strong></div></div></section>
    {error ? <div className="feedback error" role="alert"><TriangleAlert size={18}/><span>{error}</span><button className="text-button" onClick={() => void load()}>Refresh</button><button className="icon-button" aria-label="Dismiss storefront error" onClick={() => setError(null)}><X size={16}/></button></div> : null}
    {notice ? <div className="feedback notice" role="status"><CheckCircle2 size={18}/><span>{notice}</span><button className="icon-button" aria-label="Dismiss storefront message" onClick={() => setNotice(null)}><X size={16}/></button></div> : null}
    <div className={`shop-config ${config?.configured ? 'configured' : ''}`}><div className="config-icon">{config?.configured ? <CreditCard size={20}/> : <LockKeyhole size={20}/>}</div><div><strong>{config ? config.configured ? 'Test checkout is connected' : 'Payment setup is required' : 'Checking payment configuration…'}</strong><p>{config?.message || 'The server is checking whether Razorpay Test Mode is available.'}</p></div><span className="test-mode-tag">TEST MODE ONLY</span></div>
    <div className="shop-layout"><section className="catalog-section"><div className="section-heading"><div><SectionLabel>CURATED FOR YOUR EVERYDAY</SectionLabel><h2>The essentials collection</h2></div><span className="small-meta">{products.length} products · INR</span></div>{loading && !products.length ? <div className="panel"><EmptyState icon={Loader2} title="Loading the collection">Fetching the product catalog and current prices from the server.</EmptyState></div> : products.length ? <div className="product-grid">{products.map(product => <article className="product-card" key={product.id}><div className="product-image-wrap"><span className="product-badge">{product.badge}</span><ProductVisual product={product}/></div><div className="product-copy"><span className="product-category">{product.category}</span><h3>{product.name}</h3><p>{product.description}</p><div className="product-bottom"><strong>{money(product.priceMinor)}</strong><button className="add-cart-button" disabled={cartLocked || (cart.items[product.id] || 0) >= 5} onClick={() => changeQuantity(product.id, 1)} aria-label={`Add ${product.name} to cart`}><Plus size={15}/> Add{cart.items[product.id] ? <span>{cart.items[product.id]}</span> : null}</button></div></div></article>)}</div> : <div className="panel"><EmptyState icon={ShoppingBag} title="The collection is unavailable">Reconnect to the backend or refresh to retrieve the live catalog.</EmptyState></div>}</section>
    <aside className="cart-panel panel"><div className="panel-header"><div><SectionLabel>YOUR SELECTION</SectionLabel><h2>Shopping cart</h2></div><span className="cart-count"><ShoppingCart size={15}/>{quantity}</span></div>{lines.length ? <><div className="cart-lines">{lines.map(({ product, quantity: itemQuantity }) => <div className="cart-line" key={product.id}><ProductVisual product={product} compact/><div><strong>{product.name}</strong><span>{money(product.priceMinor)} each</span><div className="quantity-control"><button disabled={cartLocked} onClick={() => changeQuantity(product.id, -1)} aria-label={`Remove one ${product.name}`}><Minus size={12}/></button><span>{itemQuantity}</span><button disabled={cartLocked || itemQuantity >= 5} onClick={() => changeQuantity(product.id, 1)} aria-label={`Add one ${product.name}`}><Plus size={12}/></button></div></div><strong className="line-price">{money(product.priceMinor * itemQuantity)}</strong></div>)}</div><div className="cart-totals"><div><span>Subtotal</span><strong>{money(subtotal)}</strong></div><div><span>Delivery</span><span className="cyan">Test purchase</span></div><div className="cart-grand-total"><span>Total</span><strong>{money(subtotal)}</strong></div></div>{subtotal > 1000000 ? <p className="cart-limit">This test order exceeds ₹10,000. Reduce a quantity to continue.</p> : null}<button className="primary-button checkout-button" disabled={!config?.configured || subtotal > 1000000 || workspace.connection !== 'ready' || cartLocked} onClick={() => void checkout()}>{busy ? <Loader2 className="spin" size={17}/> : <LockKeyhole size={16}/>} {busy ? 'Checking your order…' : paymentOpen ? 'Checkout is open' : awaitingCapture ? 'Awaiting capture verification' : cart.orderId ? 'Resume test checkout' : 'Pay with Razorpay'}{!busy && !paymentOpen ? <ArrowRight size={16}/> : null}</button><p className="cart-disclaimer">Up to 5 of each item and ₹10,000 per test order. Only test payments are enabled. The server calculates the final total and verifies the payment before marking an order paid.</p>{cart.orderId ? <div className="pending-order-note"><ReceiptText size={14}/><span>Saved order <code>{shortId(cart.orderId)}</code><small>{awaitingCapture ? 'Payment received; this cart stays bound to its original order while capture is checked.' : 'Unchanged-cart retries reuse this order.'}</small>{awaitingCapture ? <button className="text-button capture-refresh" onClick={() => void refreshOrders(true)}><RefreshCw size={12}/> Check capture status</button> : null}</span></div> : null}</> : <EmptyState icon={ShoppingBag} title="A little room for something good">Add an essential from the collection to start a test purchase.</EmptyState>}<div className="cart-security"><ShieldCheck size={14}/><span>Signature checked on the server</span></div></aside></div>
    <section className="shop-orders"><div className="section-heading"><div><SectionLabel>YOUR SESSION, YOUR ORDERS</SectionLabel><h2>Purchase history</h2></div><button className="text-button" onClick={() => void refreshOrders(true)}><RefreshCw size={14}/> Refresh orders</button></div>{orders.length ? <div className="orders-layout"><div className="order-list panel">{orders.map(order => <button key={order.id} className={`shop-order-row ${order.id === selectedOrderId ? 'selected' : ''}`} onClick={() => setSelectedOrderId(order.id)}><span className={`order-row-icon ${order.status}`}>{order.status === 'paid' ? <Check size={18}/> : <ReceiptText size={18}/>}</span><span><strong>{order.items.map(item => item.name).join(', ')}</strong><small>{time(order.createdAt)} · {shortId(order.id)}</small></span><strong>{money(order.amountMinor)}</strong><Badge status={order.status === 'paid' ? 'passed' : order.status === 'failed' ? 'failed' : 'pending'}>{order.status === 'provider_unknown' ? 'Provider status unknown' : order.status}</Badge><ArrowUpRight size={14}/></button>)}</div><div className="panel order-receipt"><div className="panel-header"><div><SectionLabel>ORDER RECEIPT</SectionLabel><h2>{selectedOrder?.status === 'paid' ? 'Payment verified' : 'Order details'}</h2></div>{selectedOrder?.status === 'paid' ? <ShieldCheck size={23} className="cyan"/> : <ReceiptText size={23} className="muted"/>}</div>{selectedOrder ? <><div className={`receipt-status ${selectedOrder.status}`}><Badge status={selectedOrder.status === 'paid' ? 'passed' : 'pending'}>{selectedOrder.status === 'paid' ? 'Paid · server verified' : selectedOrder.status.replace(/_/g, ' ')}</Badge><strong>{money(selectedOrder.amountMinor)}</strong></div><div className="receipt-lines">{selectedOrder.items.map(item => <div key={item.productId}><span>{item.quantity} × {item.name}</span><strong>{money(item.lineAmountMinor)}</strong></div>)}</div><dl className="receipt-identifiers"><div><dt>Order</dt><dd>{selectedOrder.id}</dd></div><div><dt>Provider order</dt><dd>{selectedOrder.razorpayOrderId || 'Awaiting provider'}</dd></div><div><dt>Payment</dt><dd>{selectedOrder.razorpayPaymentId || 'Not captured yet'}</dd></div><div><dt>Storage</dt><dd>{config ? config.database === 'postgres' ? 'Cloud database' : 'Local database' : 'Awaiting storage status'}</dd></div></dl>{selectedOrder.status !== 'paid' ? <div className="receipt-pending-copy"><p>A pending or unknown order is never shown as paid. Its status changes only after the server verifies the provider response.</p><button className="secondary-button" disabled={cartLocked} onClick={() => restoreOrder(selectedOrder)}>Restore saved order to cart <ArrowRight size={14}/></button></div> : <div className="receipt-verified"><CheckCircle2 size={16}/> Verified payment. Receipt retained.</div>}</> : <EmptyState icon={ReceiptText} title="Select an order">Inspect its immutable items, provider references, and verified status.</EmptyState>}</div></div> : <div className="panel"><EmptyState icon={ReceiptText} title="Your first receipt starts here">Completed and pending orders appear here, separate from synthetic monitoring runs.</EmptyState></div>}</section>
  </>;
}
