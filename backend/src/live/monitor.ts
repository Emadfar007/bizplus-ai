import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import type { Express } from 'express';
import { LIVE_FAULTS, type Assertion, type LiveEvidence, type LiveFault, type LiveMonitoring, type LiveRecoveryResponse, type LiveRun, type LiveTarget } from '@bizplus/shared';
import { WorkflowError } from '../engine/workflow.js';
import type { DataStore } from '../database/types.js';
import { fetchPublicPage, publicHttpsUrl, type PublicFetcher } from './network.js';
import { FaultLab, LAB_TARGET_ID, type LabOptions } from './lab.js';
import { diagnoseLiveRun } from './diagnosis.js';

export const OWNED_TARGET: LiveTarget = { id: 'bizplus-public-api', name: 'BizPlus public API', url: 'https://bizplus-ai-api.onrender.com/health', expectedStatus: 200, containsText: '"status":"ok"' };
export const OWNED_READY_TARGET: LiveTarget = { id: 'bizplus-dependencies', name: 'BizPlus database and payment readiness', url: 'https://bizplus-ai-api.onrender.com/ready', expectedStatus: 200, containsText: '"status":"ready"' };
export function parseTargets(input: string | undefined): LiveTarget[] {
  if (!input) return [OWNED_TARGET, OWNED_READY_TARGET];
  const parsed: unknown = JSON.parse(input);
  if (!Array.isArray(parsed) || parsed.length > 10) throw new Error('LIVE_TARGETS must be a JSON array with at most ten owned website targets.');
  const ids = new Set<string>();
  return parsed.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Each live target must be an object.');
    const target = value as Record<string, unknown>;
    if (Object.keys(target).some(key => !['id','name','url','expectedStatus','containsText'].includes(key)) || typeof target.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(target.id) || ids.has(target.id) || typeof target.name !== 'string' || !target.name.trim() || target.name.length > 80 || typeof target.url !== 'string' || target.url.length > 2048 || !Number.isInteger(target.expectedStatus) || Number(target.expectedStatus) < 100 || Number(target.expectedStatus) > 599 || (target.containsText !== undefined && (typeof target.containsText !== 'string' || !target.containsText || target.containsText.length > 200))) throw new Error('Live targets need unique IDs, a name, HTTPS URL, expectedStatus, and optional short containsText.');
    if (target.id === LAB_TARGET_ID) throw new Error('The built-in isolated lab target cannot be overridden.');
    ids.add(target.id);
    return { id: target.id, name: target.name.trim(), url: publicHttpsUrl(target.url).href, expectedStatus: Number(target.expectedStatus), ...(target.containsText ? { containsText: String(target.containsText) } : {}) };
  });
}
const assertion = (code: string, expected: string, actual: string, passed: boolean): Assertion => ({ code, expected, actual, passed });
function excerpt(body: string): string {
  // Store only a short visible-text sample, never HTML scripts or embedded configuration.
  return body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 320);
}
export class LiveMonitor {
  private readonly active = new Map<string, Promise<void>>();
  private readonly actions = new Set<string>();
  readonly lab: FaultLab;
  private internalOrigin = '';
  private publicOrigin: string | undefined;
  constructor(private store: DataStore, readonly targets: LiveTarget[], private fetcher: PublicFetcher = fetchPublicPage, private options: Pick<LiveMonitorOptions, 'browserProbe' | 'lab' | 'monitoring'> = {}) { this.lab = new FaultLab(options.lab); }
  setBaseUrl(localBaseUrl: string, publicOrigin?: string) {
    const local = new URL(localBaseUrl);
    if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || !local.port || local.pathname !== '/' || local.search || local.username || local.password) throw new Error('The internal lab origin must be the server-minted loopback listener.');
    this.internalOrigin = local.origin;
    if (publicOrigin) { const url = publicHttpsUrl(publicOrigin); if (url.pathname !== '/') throw new Error('The public app URL must be an HTTPS origin.'); this.publicOrigin = url.origin; }
    this.lab.setOrigin(this.publicOrigin ?? this.internalOrigin);
  }
  listTargets(session: string) { return [...this.targets, this.lab.target(session)]; }
  labState(session: string) { return this.lab.state(session); }
  introduceFault(session: string, fault: LiveFault) {
    if (this.active.has(session) || this.actions.has(session)) throw new WorkflowError(409, 'LIVE_RUN_ACTIVE', 'Wait for this session\'s live test or recovery to finish before changing the fault.');
    return this.lab.introduce(session, fault);
  }
  async start(session: string, targetId: string): Promise<LiveRun> {
    return this.enqueue(session, targetId, false);
  }
  private async enqueue(session: string, targetId: string, action: boolean, requireBrowser = false): Promise<LiveRun> {
    const target = targetId === LAB_TARGET_ID ? this.lab.target(session) : this.targets.find(item => item.id === targetId);
    if (!target) throw new WorkflowError(400, 'TARGET_NOT_ALLOWED', 'Choose a configured owned website target.');
    if (this.active.has(session) || (!action && this.actions.has(session))) throw new WorkflowError(409, 'LIVE_RUN_ACTIVE', 'A live website test or recovery is already active in this session.');
    if (this.active.size >= 10) throw new WorkflowError(429, 'LIVE_RUNNER_BUSY', 'The live test runner is busy. Try again shortly.');
    const run: LiveRun = { id: randomUUID(), targetId, url: target.url, status: 'queued', httpStatus: null, durationMs: 0, startedAt: new Date().toISOString(), completedAt: null, error: null, message: 'Waiting to inspect the configured website.', assertions: [], evidence: { responseBytes: 0, events: [] }, fingerprint: null, ...(targetId === LAB_TARGET_ID ? { labRevision: this.lab.state(session).revision } : {}) };
    // Acquire the slot synchronously before any database/network await.
    const persisted = Promise.resolve().then(() => this.store.saveLiveRun(session, run));
    const pending = persisted.then(() => this.execute(session, run, target, requireBrowser)).finally(() => this.active.delete(session));
    this.active.set(session, pending);
    void pending.catch(error => console.error('Live monitor persistence failed:', error instanceof Error ? error.name : 'Unknown error'));
    await persisted;
    return run;
  }
  private fetchLab(session: string) {
    // The caller cannot provide this URL or change its origin/path. External targets always use the SSRF-restricted fetcher.
    const path = `/test-site/${session}`;
    if (this.publicOrigin) return this.fetcher(`${this.publicOrigin}${path}`);
    if (!this.internalOrigin) throw new Error('The isolated test website listener has not been initialized.');
    const url = `${this.internalOrigin}${path}`;
    return new Promise<Awaited<ReturnType<PublicFetcher>>>((resolve, reject) => {
      const req = request(url, { method: 'GET', headers: { Accept: 'text/html', 'User-Agent': 'BizPlusAI-Monitor/1.0' } }, res => {
        let bytes = 0; const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 512 * 1024) req.destroy(new Error('Website response exceeds the 512 KB inspection limit.')); else chunks.push(chunk); });
        res.on('error', reject);
        res.on('end', () => resolve({ httpStatus: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), responseBytes: bytes, finalUrl: url, contentType: String(res.headers['content-type'] ?? '') }));
      });
      const timer = setTimeout(() => req.destroy(new Error('Website request timed out after 12 seconds.')), 12_000);
      req.on('close', () => clearTimeout(timer)); req.on('error', reject); req.end();
    });
  }
  private async execute(session: string, run: LiveRun, target: LiveTarget, requireBrowser = false): Promise<void> {
    const start = performance.now();
    const isLab = target.id === LAB_TARGET_ID;
    const labState = isLab ? this.lab.state(session) : undefined;
    run.status = 'running'; run.message = 'Sending a real website request.';
    try {
      await this.store.saveLiveRun(session, run);
      const response = await (isLab ? this.fetchLab(session) : this.fetcher(target.url));
      run.httpStatus = response.httpStatus;
      run.assertions.push(assertion('HTTP_STATUS', `HTTP ${target.expectedStatus}`, `HTTP ${response.httpStatus}`, response.httpStatus === target.expectedStatus));
      if (target.containsText) run.assertions.push(assertion('EXPECTED_CONTENT', target.containsText, response.body.includes(target.containsText) ? 'Expected content found' : 'Expected content missing', response.body.includes(target.containsText)));
      run.assertions.push(assertion('RESPONSE_PRESENT', 'Non-empty response body', `${response.responseBytes} bytes`, response.responseBytes > 0));
      const title = response.body.match(/<title[^>]*>([^<]{1,200})<\/title>/i)?.[1];
      const responseEvent: LiveEvidence = { id: randomUUID(), kind: 'response', timestamp: new Date().toISOString(), message: `Real GET ${target.url} returned HTTP ${response.httpStatus}.`, data: { url: target.url, httpStatus: response.httpStatus, responseBytes: response.responseBytes } };
      run.evidence = { responseBytes: response.responseBytes, ...(title ? { title: title.trim() } : {}), excerpt: excerpt(response.body), events: [responseEvent] };
      if (isLab && run.assertions.every(item => item.passed)) {
        if (labState?.fault === 'login_401') {
          run.assertions.push(assertion('MANUAL_LOGIN_FORM', 'Username and password form available for a human', response.body.includes('data-testid="manual-login-form"') ? 'Login form available; no credentials submitted' : 'Login form missing', response.body.includes('data-testid="manual-login-form"')));
          if (requireBrowser) run.assertions.push(assertion('BROWSER_JOURNEY_AVAILABLE', 'The original failed interaction is verified', 'Opening a manual login form cannot verify the original browser failure. Enter credentials yourself for login; restore the matching site behavior for other incidents.', false));
        } else if (this.options.browserProbe) {
          try {
            const browser = await this.options.browserProbe(session);
            if (!browser.assertions.length) throw new Error('The independent browser monitor returned no journey assertions.');
            run.assertions.push(...browser.assertions); run.evidence.events!.push(...browser.evidence);
          }
          catch (error) { const message = error instanceof Error ? error.message : 'Independent browser monitor failed.'; run.assertions.push(assertion('BROWSER_JOURNEY_AVAILABLE', 'Actual browser journey completes', message, false)); }
        } else if (requireBrowser || (labState && ['javascript_error','button_broken','login_401','payment_unavailable','database_unavailable'].includes(labState.fault))) run.assertions.push(assertion('BROWSER_JOURNEY_AVAILABLE', 'Independent browser monitor configured', 'Browser journey is unavailable; HTTP alone cannot verify the required interaction behavior.', false));
      }
      run.status = run.assertions.every(item => item.passed) ? 'passed' : 'failed';
      run.message = run.status === 'passed' ? (labState?.fault === 'login_401' ? 'Login page is reachable. Enter credentials yourself to verify login; this check did not attempt authentication.' : isLab && this.options.browserProbe ? 'Website response and the actual synthetic browser journey passed.' : isLab ? 'HTTP baseline passed. Connect the independent browser monitor to verify sign-in, cart and confirmation.' : 'Website returned its expected status and content.') : 'Website response or browser journey failed a configured assertion. Inspect its explanation and measured evidence.';
    } catch (error) {
      run.status = 'failed'; run.error = error instanceof Error ? error.message : 'Website request failed.';
      run.message = run.error; run.assertions.push(assertion('REQUEST_COMPLETED', 'HTTPS response within 12 seconds', run.error, false));
    } finally {
      run.durationMs = Math.round(performance.now() - start); run.completedAt = new Date().toISOString();
      if (isLab) run.evidence.events!.push(...this.lab.eventsSince(session, run.startedAt));
      if (run.status === 'failed') {
        run.diagnosis = diagnoseLiveRun(run, labState?.fault); run.incidentStatus = 'open';
        run.fingerprint = createHash('sha256').update(JSON.stringify([target.id, isLab ? '/test-site/:session' : target.url,run.httpStatus,run.diagnosis.category,run.assertions.filter(item => !item.passed).map(item => item.code)])).digest('hex').slice(0,16);
      }
      await this.store.saveLiveRun(session, run);
    }
  }
  async recover(session: string, runId: string, restore: boolean): Promise<LiveRecoveryResponse> {
    if (this.active.has(session) || this.actions.has(session)) throw new WorkflowError(409, 'LIVE_RUN_ACTIVE', 'Wait for this session\'s active test or recovery to finish.');
    this.actions.add(session);
    try {
      const original = await this.store.getLiveRun(runId, session);
      if (!original) throw new WorkflowError(404, 'NOT_FOUND', 'Live test was not found in this session.');
      if (original.status !== 'failed') throw new WorkflowError(409, 'NO_LIVE_INCIDENT', 'Only a failed live test can be recovered or verified.');
      if (original.recovery?.status === 'verified') return { runId, verificationRunId: original.recovery.verificationRunId, status: 'verified' };
      if (original.diagnosis?.category === 'authentication') throw new WorkflowError(409, 'MANUAL_LOGIN_REQUIRED', 'Login recovery requires the human to enter correct credentials. Open the manual login test; an automatic site restore cannot verify login.');
      if (restore) {
        if (original.targetId !== LAB_TARGET_ID || !original.labRevision) throw new WorkflowError(400, 'MANUAL_REPAIR_REQUIRED', 'Only isolated lab faults can be restored automatically. Apply the recommended repair to your owned site, then verify.');
        this.lab.restore(session, original.labRevision);
      }
      const requiresBrowser = original.assertions.some(item => /^BROWSER_/.test(item.code));
      const verification = await this.enqueue(session, original.targetId, true, requiresBrowser);
      await this.active.get(session);
      const checked = await this.store.getLiveRun(verification.id, session);
      const status = checked?.status === 'passed' ? 'verified' : 'failed';
      original.recovery = { status, verificationRunId: verification.id, completedAt: new Date().toISOString() };
      original.incidentStatus = status === 'verified' ? 'resolved' : 'open';
      original.evidence.events ??= [];
      original.evidence.events.push({ id: randomUUID(), kind: 'recovery', timestamp: original.recovery.completedAt, message: status === 'verified' ? 'A fresh request and configured browser checks passed; this incident is resolved.' : 'Fresh verification failed; this incident remains open.', data: { verificationRunId: verification.id, status, restoredLabOnly: restore, realPayments: 0 } });
      await this.store.saveLiveRun(session, original);
      return { runId, verificationRunId: verification.id, status };
    } finally { this.actions.delete(session); }
  }
  async drain(): Promise<void> { await Promise.allSettled(this.active.values()); }
}
export type BrowserProbe = (session: string) => Promise<{ assertions: Assertion[]; evidence: LiveEvidence[] }>;
export interface LiveMonitorOptions { targets?: LiveTarget[]; fetcher?: PublicFetcher; browserProbe?: BrowserProbe; lab?: LabOptions; monitoring?: LiveMonitoring }
export function registerLiveMonitor(app: Express, store: DataStore, options: LiveMonitorOptions = {}) {
  const monitor = new LiveMonitor(store, options.targets ?? parseTargets(process.env.LIVE_TARGETS), options.fetcher, options);
  monitor.lab.register(app);
  app.get('/api/live/targets', (_req, res) => res.json({ targets: monitor.listTargets(String(res.locals.session)), configured: true, ...(options.monitoring ? { monitoring: options.monitoring } : {}) }));
  app.get('/api/live/lab', (_req, res) => res.json(monitor.labState(String(res.locals.session))));
  app.post('/api/live/lab', (req, res) => {
    const input: unknown = req.body;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2 || !('fault' in input) || !('approved' in input) || input.approved !== true || typeof input.fault !== 'string' || !LIVE_FAULTS.includes(input.fault as LiveFault)) throw new WorkflowError(400, 'INVALID_LAB_REQUEST', 'Explicit approval and a supported controlled fault are required.');
    res.json(monitor.introduceFault(String(res.locals.session), input.fault as LiveFault));
  });
  app.post('/api/live/runs', async (req, res) => {
    const input: unknown = req.body;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !('targetId' in input) || typeof input.targetId !== 'string') throw new WorkflowError(400, 'INVALID_LIVE_REQUEST', 'Provide only a configured targetId.');
    const run = await monitor.start(String(res.locals.session), input.targetId); res.status(202).json({ runId: run.id });
  });
  app.get('/api/live/runs', async (_req, res) => res.json({ runs: await store.listLiveRuns(String(res.locals.session)) }));
  app.get('/api/live/runs/:id', async (req, res) => {
    const run = await store.getLiveRun(String(req.params.id), String(res.locals.session));
    if (!run) throw new WorkflowError(404, 'NOT_FOUND', 'Live test was not found in this session.');
    res.json(run);
  });
  for (const action of ['recover', 'verify'] as const) app.post(`/api/live/runs/:id/${action}`, async (req, res) => {
    const input: unknown = req.body;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !('approved' in input) || input.approved !== true) throw new WorkflowError(400, 'APPROVAL_REQUIRED', 'Explicit approval is required for recovery or a fresh verification.');
    res.json(await monitor.recover(String(res.locals.session), String(req.params.id), action === 'recover'));
  });
  return monitor;
}
