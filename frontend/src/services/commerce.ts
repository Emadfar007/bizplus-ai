import type { CommerceCheckout, CommerceConfig, CommerceOrder, CommercePaymentVerification, Product } from '@bizplus/shared';
import { request } from './api';

export const commerceApi = {
  products: (session: string) => request<Product[]>('/api/shop/products', session),
  config: (session: string) => request<CommerceConfig>('/api/shop/config', session),
  orders: (session: string) => request<{ orders: CommerceOrder[] }>('/api/shop/orders', session),
  order: (session: string, id: string) => request<CommerceOrder>(`/api/shop/orders/${encodeURIComponent(id)}`, session),
  checkout: (session: string, items: { productId: string; quantity: number }[], checkoutKey: string) => request<CommerceCheckout>('/api/shop/orders', session, { method: 'POST', body: JSON.stringify({ items, checkoutKey }) }, 30000),
  verify: (session: string, id: string, payload: CommercePaymentVerification) => request<CommerceOrder>(`/api/shop/orders/${encodeURIComponent(id)}/verify`, session, { method: 'POST', body: JSON.stringify(payload) }, 30000),
};

interface RazorpayOptions {
  key: string; amount: number; currency: string; name: string; description: string; order_id: string;
  handler: (response: CommercePaymentVerification) => void;
  modal: { ondismiss: () => void };
  theme: { color: string };
}
export interface RazorpayInstance { open(): void; close(): void; on(event: 'payment.failed', handler: (response: { error?: { description?: string; reason?: string } }) => void): void }
type RazorpayConstructor = new (options: RazorpayOptions) => RazorpayInstance;
type RazorpayWindow = Window & { Razorpay?: RazorpayConstructor };
let scriptPromise: Promise<RazorpayConstructor> | null = null;
export function loadRazorpay(): Promise<RazorpayConstructor> {
  const loaded = (window as RazorpayWindow).Razorpay;
  if (loaded) return Promise.resolve(loaded);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<RazorpayConstructor>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-bizplus-razorpay]');
    const script = existing || document.createElement('script');
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => { clearTimeout(timer); script.removeEventListener('load', success); script.removeEventListener('error', failure); };
    const failure = () => { cleanup(); scriptPromise = null; script.remove(); reject(new Error('Razorpay checkout could not load. Check your connection and retry the same order.')); };
    const success = () => { const constructor = (window as RazorpayWindow).Razorpay; if (!constructor) { failure(); return; } cleanup(); resolve(constructor); };
    script.addEventListener('load', success, { once: true });
    script.addEventListener('error', failure, { once: true });
    timer = setTimeout(failure, 20000);
    if (!existing) { script.src = 'https://checkout.razorpay.com/v1/checkout.js'; script.async = true; script.dataset.bizplusRazorpay = 'true'; document.head.appendChild(script); }
  });
  return scriptPromise;
}
