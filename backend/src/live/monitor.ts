import { createHash, randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Assertion, LiveRun, LiveTarget } from '@bizplus/shared';
import { WorkflowError } from '../engine/workflow.js';
import type { DataStore } from '../database/types.js';
import { fetchPublicPage, publicHttpsUrl, type PublicFetcher } from './network.js';

export const OWNED_TARGET: LiveTarget = { id: 'bizplus-public-api', name: 'BizPlus public API', url: 'https://bizplus-ai-api.onrender.com/health', expectedStatus: 200, containsText: '"status":"ok"' };
export function parseTargets(input: string | undefined): LiveTarget[] {
  if (!input) return [OWNED_TARGET];
  const parsed: unknown = JSON.parse(input);
  if (!Array.isArray(parsed) || parsed.length > 10) throw new Error('LIVE_TARGETS must be a JSON array with at most ten owned website targets.');
  const ids = new Set<string>();
  return parsed.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Each live target must be an object.');
    const target = value as Record<string, unknown>;
    if (Object.keys(target).some(key => !['id','name','url','expectedStatus','containsText'].includes(key)) || typeof target.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(target.id) || ids.has(target.id) || typeof target.name !== 'string' || !target.name.trim() || target.name.length > 80 || typeof target.url !== 'string' || target.url.length > 2048 || !Number.isInteger(target.expectedStatus) || Number(target.expectedStatus) < 100 || Number(target.expectedStatus) > 599 || (target.containsText !== undefined && (typeof target.containsText !== 'string' || !target.containsText || target.containsText.length > 200))) throw new Error('Live targets need unique IDs, a name, HTTPS URL, expectedStatus, and optional short containsText.');
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
  constructor(private store: DataStore, readonly targets: LiveTarget[], private fetcher: PublicFetcher = fetchPublicPage) {}
  async start(session: string, targetId: string): Promise<LiveRun> {
    const target = this.targets.find(item => item.id === targetId);
    if (!target) throw new WorkflowError(400, 'TARGET_NOT_ALLOWED', 'Choose a configured owned website target.');
    if (this.active.has(session)) throw new WorkflowError(409, 'LIVE_RUN_ACTIVE', 'A live website test is already active in this session.');
    if (this.active.size >= 10) throw new WorkflowError(429, 'LIVE_RUNNER_BUSY', 'The live test runner is busy. Try again shortly.');
    const run: LiveRun = { id: randomUUID(), targetId, url: target.url, status: 'queued', httpStatus: null, durationMs: 0, startedAt: new Date().toISOString(), completedAt: null, error: null, message: 'Waiting to inspect the configured website.', assertions: [], evidence: { responseBytes: 0 }, fingerprint: null };
    // Acquire the slot synchronously before any database/network await.
    const persisted = Promise.resolve().then(() => this.store.saveLiveRun(session, run));
    const pending = persisted.then(() => this.execute(session, run, target)).finally(() => this.active.delete(session));
    this.active.set(session, pending);
    void pending.catch(error => console.error('Live monitor persistence failed:', error instanceof Error ? error.name : 'Unknown error'));
    await persisted;
    return run;
  }
  private async execute(session: string, run: LiveRun, target: LiveTarget): Promise<void> {
    const start = performance.now();
    run.status = 'running'; run.message = 'Sending a real HTTPS request.';
    try {
      await this.store.saveLiveRun(session, run);
      const response = await this.fetcher(target.url);
      run.httpStatus = response.httpStatus;
      run.assertions.push(assertion('HTTP_STATUS', `HTTP ${target.expectedStatus}`, `HTTP ${response.httpStatus}`, response.httpStatus === target.expectedStatus));
      if (target.containsText) run.assertions.push(assertion('EXPECTED_CONTENT', target.containsText, response.body.includes(target.containsText) ? 'Expected content found' : 'Expected content missing', response.body.includes(target.containsText)));
      run.assertions.push(assertion('RESPONSE_PRESENT', 'Non-empty response body', `${response.responseBytes} bytes`, response.responseBytes > 0));
      const title = response.body.match(/<title[^>]*>([^<]{1,200})<\/title>/i)?.[1];
      run.evidence = { responseBytes: response.responseBytes, ...(title ? { title: title.trim() } : {}), excerpt: excerpt(response.body) };
      run.status = run.assertions.every(item => item.passed) ? 'passed' : 'failed';
      run.message = run.status === 'passed' ? 'Website returned its expected status and content.' : 'Website response failed a configured assertion. Inspect the measured evidence.';
    } catch (error) {
      run.status = 'failed'; run.error = error instanceof Error ? error.message : 'Website request failed.';
      run.message = run.error; run.assertions.push(assertion('REQUEST_COMPLETED', 'HTTPS response within 12 seconds', run.error, false));
    } finally {
      run.durationMs = Math.round(performance.now() - start); run.completedAt = new Date().toISOString();
      if (run.status === 'failed') run.fingerprint = createHash('sha256').update(JSON.stringify([target.id,target.url,run.httpStatus,run.assertions.filter(item => !item.passed).map(item => item.code)])).digest('hex').slice(0,16);
      await this.store.saveLiveRun(session, run);
    }
  }
  async drain(): Promise<void> { await Promise.allSettled(this.active.values()); }
}
export function registerLiveMonitor(app: Express, store: DataStore, options: { targets?: LiveTarget[]; fetcher?: PublicFetcher } = {}) {
  const monitor = new LiveMonitor(store, options.targets ?? parseTargets(process.env.LIVE_TARGETS), options.fetcher);
  app.get('/api/live/targets', (_req, res) => res.json({ targets: monitor.targets, configured: monitor.targets.length > 0 }));
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
  return monitor;
}
