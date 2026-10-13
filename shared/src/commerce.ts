export interface Product {
  id: string;
  name: string;
  category: string;
  description: string;
  priceMinor: number;
  currency: 'INR';
  image: string;
  accent: string;
  badge: string;
}
export interface CommerceOrderLine {
  productId: string;
  name: string;
  quantity: number;
  unitAmountMinor: number;
  lineAmountMinor: number;
}
export type CommerceOrderStatus = 'creating' | 'pending' | 'paid' | 'failed' | 'provider_unknown';
export interface CommerceOrder {
  id: string;
  checkoutKey: string;
  status: CommerceOrderStatus;
  items: CommerceOrderLine[];
  amountMinor: number;
  currency: 'INR';
  razorpayOrderId: string | null;
  razorpayPaymentId: string | null;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
}
export interface CommerceConfig {
  mode: 'test';
  configured: boolean;
  keyId: string | null;
  database: 'sqlite' | 'postgres';
  message: string;
}
export interface CommerceCheckout {
  order: CommerceOrder;
  keyId: string;
  mode: 'test';
}
export interface CommercePaymentVerification {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}
