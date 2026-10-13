import { randomUUID } from 'node:crypto';
import type { Express, Response } from 'express';
import { LIVE_FAULTS, type LiveEvidence, type LiveFault, type LiveLabState, type LiveTarget } from '@bizplus/shared';
import { WorkflowError } from '../engine/workflow.js';

export const LAB_TARGET_ID = 'bizplus-fault-lab';
export const LAB_EXPECTED_CONTENT = 'BizPlus test site ready';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type SessionFault = { fault: LiveFault; revision: string; expiresAt: number | null; lastSeen: number; events: LiveEvidence[] };
export interface LabOptions { ttlMs?: number; now?: () => number }

/** An in-memory response fault belongs to one unguessable session URL. It never touches commerce or health. */
export class FaultLab {
  private sessions = new Map<string, SessionFault>();
  private now: () => number;
  private ttlMs: number;
  private origin = '';
  private readonly requests = new Map<string, { count: number; resetAt: number }>();
  private readonly inflightBySession = new Map<string, number>();
  private inflight = 0;
  constructor(options: LabOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = Math.min(120_000, Math.max(1, options.ttlMs ?? 120_000));
  }
  setOrigin(origin: string) { this.origin = origin.replace(/\/$/, ''); }
  private entry(session: string): SessionFault {
    if (!UUID.test(session)) throw new WorkflowError(400, 'INVALID_LAB_SESSION', 'A valid lab session UUID is required.');
    let entry = this.sessions.get(session);
    if (!entry) {
      if (this.sessions.size >= 200) {
        for (const [id, item] of this.sessions) if (this.now() - item.lastSeen > 120_000) this.sessions.delete(id);
        if (this.sessions.size >= 200) throw new WorkflowError(429, 'LAB_BUSY', 'The isolated lab is busy. Try again shortly.');
      }
      entry = { fault: 'healthy', revision: randomUUID(), expiresAt: null, lastSeen: this.now(), events: [] };
      this.sessions.set(session, entry);
    }
    entry.lastSeen = this.now();
    if (entry.expiresAt !== null && this.now() >= entry.expiresAt) {
      this.record(session, 'The controlled fault expired automatically; healthy responses were restored.', { fault: entry.fault, revision: entry.revision, expired: true });
      entry.fault = 'healthy'; entry.expiresAt = null;
      // Preserve the revision so a previously failed run can still verify its own expired fault.
    }
    return entry;
  }
  private publicEntry(session: string): SessionFault {
    if (!UUID.test(session) || !this.sessions.has(session)) throw new WorkflowError(404, 'LAB_SESSION_NOT_FOUND', 'Open the fault lab in your monitoring session before visiting its isolated website.');
    return this.entry(session);
  }
  state(session: string): LiveLabState {
    const entry = this.entry(session);
    return { sessionId: session, fault: entry.fault, expiresAt: entry.expiresAt === null ? null : new Date(entry.expiresAt).toISOString(), revision: entry.revision, targetId: LAB_TARGET_ID, url: `${this.origin}/test-site/${session}`, maxDurationSeconds: Math.ceil(this.ttlMs / 1000), safety: { isolated: true, syntheticPayments: true } };
  }
  target(session: string): LiveTarget { return { id: LAB_TARGET_ID, name: 'Isolated website fault lab', url: this.state(session).url, expectedStatus: 200, containsText: LAB_EXPECTED_CONTENT }; }
  introduce(session: string, fault: LiveFault): LiveLabState {
    if (!LIVE_FAULTS.includes(fault)) throw new WorkflowError(400, 'INVALID_LAB_FAULT', 'Choose a supported controlled fault.');
    const entry = this.entry(session); entry.fault = fault; entry.revision = randomUUID(); entry.expiresAt = fault === 'healthy' ? null : this.now() + this.ttlMs;
    this.record(session, fault === 'healthy' ? 'The lab was explicitly restored to healthy.' : `Controlled ${fault} fault enabled for this session only.`, { fault, revision: entry.revision, expiresAt: entry.expiresAt, realPayments: 0 });
    return this.state(session);
  }
  restore(session: string, revision: string) {
    const entry = this.entry(session);
    if (entry.revision !== revision) throw new WorkflowError(409, 'LAB_FAULT_CHANGED', 'A different fault has since been introduced. Test the current fault before restoring it.');
    const previousFault = entry.fault; entry.fault = 'healthy'; entry.expiresAt = null;
    this.record(session, 'The matching controlled fault was removed for recovery verification.', { fault: previousFault, revision, restored: true, realPayments: 0 });
  }
  private record(session: string, message: string, data: Record<string, unknown>): LiveEvidence {
    const entry = this.sessions.get(session)!;
    const event: LiveEvidence = { id: randomUUID(), kind: 'log', timestamp: new Date(this.now()).toISOString(), message, data };
    entry.events.push(event); if (entry.events.length > 50) entry.events.splice(0, entry.events.length - 50);
    return event;
  }
  eventsSince(session: string, since: string): LiveEvidence[] { return this.entry(session).events.filter(event => event.timestamp >= since).map(event => structuredClone(event)); }
  register(app: Express) {
    app.use('/test-site', (req, res, next) => {
      const now = this.now(); const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
      let bucket = this.requests.get(ip);
      if (!bucket || now >= bucket.resetAt) {
        if (this.requests.size >= 1000) {
          for (const [key, value] of this.requests) if (now >= value.resetAt) this.requests.delete(key);
          if (this.requests.size >= 1000) { res.status(503).json({ code:'LAB_BUSY',error:'The bounded test website is busy.' }); return; }
        }
        bucket = { count:0,resetAt:now + 60000 }; this.requests.set(ip,bucket);
      }
      if (++bucket.count > 240) { res.setHeader('Retry-After','60'); res.status(429).json({ code:'LAB_RATE_LIMITED',error:'Test website request limit reached. Wait one minute.' }); return; }
      const session = req.path.split('/')[1]?.toLowerCase() ?? '';
      if (this.inflight >= 40 || (this.inflightBySession.get(session) ?? 0) >= 5) { res.setHeader('Retry-After','2'); res.status(429).json({ code:'LAB_REQUESTS_ACTIVE',error:'The bounded test website already has active requests. Try again shortly.' }); return; }
      this.inflight++; this.inflightBySession.set(session,(this.inflightBySession.get(session) ?? 0)+1);
      let released = false;
      const release = () => { if (released) return; released = true; this.inflight--; const remaining = (this.inflightBySession.get(session) ?? 1)-1; if (remaining > 0) this.inflightBySession.set(session,remaining); else this.inflightBySession.delete(session); };
      res.once('finish',release); res.once('close',release); next();
    });
    app.get('/test-site/:session', async (req, res) => {
      const session = String(req.params.session).toLowerCase(); const entry = this.publicEntry(session); const fault = entry.fault;
      this.record(session, `The isolated test page received a real GET request with controlled fault ${fault}.`, { fault, revision: entry.revision, requestPath: `/test-site/${session}`, requestId: randomUUID(), observed: true });
      res.setHeader('Cache-Control', 'no-store');
      if (fault === 'timeout') {
        // A real delayed HTTP response exercises the same twelve-second deadline as external targets.
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, 13_500); res.once('close', () => { clearTimeout(timer); resolve(); }); });
        if (res.destroyed) return;
      }
      if (fault === 'http_500' || fault === 'http_503') { res.status(fault === 'http_500' ? 500 : 503).type('text').send(`Controlled ${fault} in isolated BizPlus test site`); return; }
      if (fault === 'not_found') { res.status(404).type('text').send('Controlled missing test route'); return; }
      if (fault === 'empty_body') { res.status(200).end(); return; }
      res.type('html').send(this.html(session, fault));
    });
    const reply = (session: string, endpoint: string, fault: LiveFault, expectedFault: LiveFault, res: Response, success: Record<string, unknown>) => {
      const entry = this.publicEntry(session); const failed = fault === expectedFault;
      const httpStatus = failed ? (expectedFault === 'login_401' ? 401 : 503) : 200;
      this.record(session, `Synthetic ${endpoint} request returned HTTP ${httpStatus}.`, { fault, revision: entry.revision, endpoint, httpStatus, observed: true, synthetic: true, realPayments: 0 });
      res.setHeader('Cache-Control', 'no-store');
      res.status(httpStatus).json(failed ? { error: `Controlled ${expectedFault}`, synthetic: true } : success);
    };
    app.get('/test-site/:session/api/login', (req, res) => { const session = String(req.params.session).toLowerCase(); reply(session, 'login', this.publicEntry(session).fault, 'login_401', res, { authenticated: true, synthetic: true }); });
    app.get('/test-site/:session/api/catalog', (req, res) => { const session = String(req.params.session).toLowerCase(); reply(session, 'catalog', this.publicEntry(session).fault, 'database_unavailable', res, { items: [{ id: 'demo-item', name: 'Demo item' }], synthetic: true }); });
    app.get('/test-site/:session/api/confirmation', (req, res) => { const session = String(req.params.session).toLowerCase(); reply(session, 'confirmation', this.publicEntry(session).fault, 'payment_unavailable', res, { confirmed: true, synthetic: true, paymentCount: 0 }); });
  }
  private html(session: string, fault: LiveFault): string {
    const marker = fault === 'missing_content' ? 'Controlled content unavailable' : LAB_EXPECTED_CONTENT;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>BizPlus isolated test website</title><style>body{font:18px system-ui;max-width:760px;margin:48px auto;padding:24px;color:#182038;background:#f4f7fb}button{padding:12px 18px;margin:8px;border:0;border-radius:8px;background:#215fce;color:white}section{padding:20px;background:white;border-radius:12px;margin:20px 0}</style></head><body><h1>${marker}</h1><p>This session-isolated website makes synthetic requests. No real account, order, database outage or payment is created. Controlled errors expire after two minutes.</p><section><h2>Test storefront</h2><button data-testid="login">Sign in to test account</button><span data-testid="login-status">Signed out</span><p>Demo item</p><button data-testid="add-product">Add demo item</button><span>Cart: <span data-testid="cart-count">0</span></span><p><button data-testid="checkout">Simulate order confirmation</button><span data-testid="confirmation">No confirmation</span></p></section><script>
const root='/test-site/${session}/api/';
const read=async(path)=>{const response=await fetch(root+path,{cache:'no-store'});const data=await response.json();if(!response.ok)throw Error(data.error||('HTTP '+response.status));return data;};
${fault === 'javascript_error' ? "throw Error('Controlled JavaScript initialization error');" : ''}
${fault === 'button_broken' ? '' : `document.querySelector('[data-testid="login"]').onclick=async()=>{try{const data=await read('login');document.querySelector('[data-testid="login-status"]').textContent=data.authenticated?'Signed in':'Sign-in failed';}catch(error){document.querySelector('[data-testid="login-status"]').textContent=error.message;}};
document.querySelector('[data-testid="add-product"]').onclick=async()=>{try{const data=await read('catalog');document.querySelector('[data-testid="cart-count"]').textContent=data.items.length?'1':'0';}catch(error){document.querySelector('[data-testid="cart-count"]').textContent=error.message;}};
document.querySelector('[data-testid="checkout"]').onclick=async()=>{try{const data=await read('confirmation');document.querySelector('[data-testid="confirmation"]').textContent=data.confirmed?'Order confirmed':'No confirmation';}catch(error){document.querySelector('[data-testid="confirmation"]').textContent=error.message;}};`}
</script></body></html>`;
  }
}
