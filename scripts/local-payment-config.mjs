import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const LOCAL_CREDENTIALS = fileURLToPath(new URL('../.local/integrations.env', import.meta.url));

/** Load only payment settings for the local app; never change its database or login environment. */
export function readLocalPaymentConfig({ environment = process.env, file = LOCAL_CREDENTIALS } = {}) {
  const saved = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  return {
    keyId: environment.RAZORPAY_KEY_ID ?? saved.RAZORPAY_KEY_ID,
    keySecret: environment.RAZORPAY_KEY_SECRET ?? saved.RAZORPAY_KEY_SECRET,
    webhookSecret: environment.RAZORPAY_WEBHOOK_SECRET ?? saved.RAZORPAY_WEBHOOK_SECRET,
  };
}
