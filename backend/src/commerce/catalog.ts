import type { Product } from '@bizplus/shared';

// Prices live on the server; the browser submits product IDs and quantities only.
export const PRODUCTS: readonly Product[] = Object.freeze([
  { id: 'bp-headphones', name: 'Pulse Wireless Headphones', category: 'Audio', description: 'Soft cushions, clear sound, and a focused workday. Demo product.', priceMinor: 199900, currency: 'INR', image: '/products/bp-headphones.svg', accent: 'violet', badge: 'Best seller' },
  { id: 'bp-keyboard', name: 'Flow Mechanical Keyboard', category: 'Workspace', description: 'A compact keyboard with satisfying keys and a clean desk footprint. Demo product.', priceMinor: 129900, currency: 'INR', image: '/products/bp-keyboard.svg', accent: 'cyan', badge: 'New arrival' },
  { id: 'bp-speaker', name: 'Orbit Mini Speaker', category: 'Audio', description: 'Small enough for any shelf, with room-filling everyday sound. Demo product.', priceMinor: 59900, currency: 'INR', image: '/products/bp-speaker.svg', accent: 'orange', badge: 'Under ₹1,000' },
  { id: 'bp-watch', name: 'Tempo Smart Watch', category: 'Lifestyle', description: 'A lightweight watch for your daily routine and activity tracking. Demo product.', priceMinor: 249900, currency: 'INR', image: '/products/bp-watch.svg', accent: 'green', badge: 'Featured' },
  { id: 'bp-backpack', name: 'Nomad Everyday Backpack', category: 'Lifestyle', description: 'A simple carry for your laptop, ideas, and the next adventure. Demo product.', priceMinor: 149900, currency: 'INR', image: '/products/bp-backpack.svg', accent: 'blue', badge: 'Everyday essential' },
  { id: 'bp-desk-lamp', name: 'Halo Desk Lamp', category: 'Workspace', description: 'Warm light and an adjustable silhouette for late-night builds. Demo product.', priceMinor: 79900, currency: 'INR', image: '/products/bp-desk-lamp.svg', accent: 'rose', badge: 'Team favorite' },
].map(product => Object.freeze(product as Product)));
