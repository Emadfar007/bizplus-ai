import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { UUID } from './config.mjs';

const clean = value => String(value)
  .replace(/(bearer\s+|token[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
  .replace(/https?:\/\/[^\s)"']+/gi, url => { try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname}`; } catch { return '[URL redacted]'; } })
  .replace(/\s+/g, ' ').slice(0, 250);
const assertion = (code, expected, actual, passed) => ({ code, expected, actual: clean(actual), passed });

export class BrowserProbes {
  constructor(origin, launch = () => chromium.launch({ headless: true, timeout: 10000, args: ['--disable-dev-shm-usage'] })) {
    this.origin = origin; this.launch = launch; this.busy = false;
    this.health = { available: null, lastError: null };
  }
  async probe(sessionId, kind = 'lab') {
    if (!UUID.test(sessionId)) throw new Error('A valid session UUID is required.');
    if (this.busy) { const error = new Error('The browser observer is running another bounded check. Retry shortly.'); error.code = 'BROWSER_BUSY'; throw error; }
    this.busy = true;
    let browser, context, timer;
    const started = Date.now(); const errors = [];
    const result = { assertions: [], evidence: [] };
    let stage = 'BROWSER_RUNNER_AVAILABLE';
    try {
      browser = await this.launch();
      this.health.available = true; this.health.lastError = null;
      const work = (async () => {
        context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
        await context.route('**/*', async route => {
          const request = route.request();
          const url = new URL(request.url());
          // Never visit arbitrary destinations or launch provider checkout.
          if (url.origin !== this.origin || !['GET', 'HEAD'].includes(request.method())) return route.abort('blockedbyclient');
          return route.continue();
        });
        await context.addInitScript(id => localStorage.setItem('bizplus.demo-session.v1', id), sessionId);
        const page = await context.newPage();
        page.setDefaultTimeout(2800); page.setDefaultNavigationTimeout(10000);
        page.on('pageerror', error => { errors.push(clean(error.message)); });
        page.on('requestfailed', request => {
          const url = new URL(request.url());
          if (url.origin === this.origin && result.evidence.length < 20) result.evidence.push(`Browser request failed: ${url.pathname.slice(0, 120)}.`);
        });
        page.on('response', response => {
          const url = new URL(response.url());
          if (url.origin === this.origin && response.status() >= 400 && result.evidence.length < 20) result.evidence.push(`Browser received HTTP ${response.status()} at ${url.pathname.slice(0, 120)}.`);
        });
        stage = 'BROWSER_PAGE_LOAD';
        const response = await page.goto(`${this.origin}${kind === 'lab' ? `/test-site/${sessionId}` : '/shop'}`, { waitUntil: 'domcontentloaded' });
        result.assertions.push(assertion(stage, 'HTTP 200 document', response?.status() ?? 'No document', response?.status() === 200));
        if (response?.status() !== 200) return;
        if (kind === 'lab') {
          stage = 'BROWSER_LOGIN';
          await page.getByTestId('login').click();
          await page.getByTestId('login-status').filter({ hasText: 'Signed in' }).waitFor();
          result.assertions.push(assertion(stage, 'Signed in after pressing login', await page.getByTestId('login-status').innerText(), true));
          stage = 'BROWSER_CART';
          await page.getByTestId('add-product').click();
          await page.getByTestId('cart-count').filter({ hasText: /^1$/ }).waitFor();
          result.assertions.push(assertion(stage, 'Cart count 1 after pressing add product', await page.getByTestId('cart-count').innerText(), true));
          stage = 'BROWSER_CONFIRMATION';
          await page.getByTestId('checkout').click();
          await page.getByTestId('confirmation').filter({ hasText: 'Order confirmed' }).waitFor();
          result.assertions.push(assertion(stage, 'Synthetic order confirmed after pressing checkout', await page.getByTestId('confirmation').innerText(), true));
        } else {
          stage = 'STOREFRONT_ADD_TO_CART';
          // The first control depends on HTML, JavaScript hydration, health and catalog
          // reads. Allow that bootstrap to use the remaining bounded journey budget.
          const bootstrapTimeout = Math.max(1, Math.min(10000, 15000 - (Date.now() - started) - 500));
          await page.getByRole('button', { name: /^Add .+ to cart$/ }).first().click({ timeout: bootstrapTimeout });
          await page.locator('.cart-count').filter({ hasText: /1/ }).waitFor();
          result.assertions.push(assertion(stage, 'Cart quantity becomes 1', await page.locator('.cart-count').innerText(), true));
          stage = 'STOREFRONT_QUANTITY';
          await page.getByRole('button', { name: /^Add one / }).first().click();
          await page.locator('.quantity-control > span').filter({ hasText: /^2$/ }).waitFor();
          await page.getByRole('button', { name: /^Remove one / }).first().click();
          await page.locator('.quantity-control > span').filter({ hasText: /^1$/ }).waitFor();
          result.assertions.push(assertion(stage, 'Cart quantity increments to 2 and decrements to 1', '2 → 1', true));
          stage = 'STOREFRONT_CHECKOUT_AVAILABLE';
          const button = page.locator('.checkout-button');
          await button.waitFor();
          const available = await button.isEnabled();
          result.assertions.push(assertion(stage, 'Configured test checkout button is enabled', available ? 'Enabled; provider checkout was not opened' : 'Disabled; test checkout is unavailable', available));
          result.evidence.push('Read-only storefront journey changed only a fresh browser cart. Provider checkout was not opened; no commerce order or payment was created.');
        }
      })();
      await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The bounded browser journey exceeded 15 seconds.')), Math.max(1, 15000 - (Date.now() - started))); })]);
    } catch (error) {
      if (stage === 'BROWSER_RUNNER_AVAILABLE') {
        this.health.available = false;
        this.health.lastError = 'Chromium could not be launched. Install the pinned Playwright Chromium runtime and check observer resources.';
        result.monitorError = true;
        result.error = this.health.lastError;
        result.assertions.push(assertion(stage, 'Observer Chromium runtime available', this.health.lastError, false));
      } else {
        const detail = clean(error instanceof Error ? error.message : 'Unknown browser execution failure');
        const actual = `${stage}: ${detail}`;
        result.error = actual;
        result.assertions.push(assertion(stage, 'Browser action completes and visible business outcome changes', actual, false));
        result.evidence.push(`Actual browser failure at ${stage}: ${detail}`);
      }
    } finally {
      clearTimeout(timer);
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
      if (!result.monitorError && browser) {
        result.assertions.push(assertion('BROWSER_JAVASCRIPT', 'No uncaught browser JavaScript errors', errors.length ? errors.join('; ') : 'No uncaught errors', errors.length === 0));
        result.evidence.push(...errors.map(error => `Uncaught browser JavaScript error: ${error}`).slice(0, 4));
      }
      result.evidence = result.evidence.slice(0, 20);
      this.busy = false;
    }
    return result;
  }
  async storefront() { return this.probe(randomUUID(), 'storefront'); }
}
