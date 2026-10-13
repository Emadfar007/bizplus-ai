import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import type { Health, LiveTarget, Scenario } from '@bizplus/shared';
import { Store } from './database/store.js';
import { PostgresStore } from './database/postgres.js';
import type { DataStore } from './database/types.js';
import { Engine, WORKFLOW, WorkflowError, type EngineOptions } from './engine/workflow.js';
import { createSandbox } from './sandbox/routes.js';
import { registerCommerce, registerCommerceWebhook, type CommerceOptions } from './commerce/routes.js';
import { registerLiveMonitor, type LiveMonitorOptions } from './live/monitor.js';
import { registerHostedFrontend } from './hosting/frontend.js';
import { observerConnection, registerObservability, type ObserverOptions } from './observability.js';
import { registerLogin, type LoginOptions } from './login/routes.js';
import { createErrorReporter, applicationErrorCode, safeErrorPath } from './incidents/reporting.js';

export interface AppOptions {
  databasePath?: string;
  databaseUrl?: string;
  databaseCaCert?: string;
  store?: DataStore;
  historyPolicy?: Health['historyPolicy'];
  commerce?: CommerceOptions;
  observer?: ObserverOptions;
  live?: LiveMonitorOptions;
  login?: LoginOptions;
  corsOrigins?: string[];
  stepTimeoutMs?: number;
  sandboxLatencyMs?: number;
  recoveryVerificationFault?: EngineOptions['recoveryVerificationFault'];
  rateLimits?: { reads: number; mutationsPerSession: number; mutationsPerIp: number };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type RateEntry = { count: number; resetAt: number };
const jsonError = (res: Response, status: number, code: string, error: string) => res.status(status).json({ error, code });

export async function createApp(options: AppOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  const databaseUrl = options.databaseUrl ?? (options.databasePath === undefined ? process.env.DATABASE_URL : undefined);
  const store: DataStore = options.store ?? (databaseUrl ? new PostgresStore(databaseUrl,{ caCert: options.databaseCaCert ?? process.env.DATABASE_CA_CERT }) : new Store(options.databasePath ?? process.env.DATABASE_PATH ?? resolve('data/bizplus.sqlite')));
  try { await store.initialize(); } catch (error) { await store.close(); throw error; }
  const nonce = randomBytes(32).toString('hex');
  const historyPolicy = store.driver === 'postgres' ? 'cloud' : options.historyPolicy ?? (process.env.HISTORY_POLICY === 'temporary' ? 'temporary' : 'local');
  const engine = new Engine(store, nonce, { stepTimeoutMs: options.stepTimeoutMs ?? 5000, recoveryVerificationFault: options.recoveryVerificationFault }, historyPolicy);
  try { await engine.initialize(); } catch (error) { await store.close(); throw error; }
  const errorReporter = createErrorReporter(store);
  const capturedRequests = new Map<string,{expiresAt:number;result:ReturnType<typeof errorReporter.report>}>();
  app.use((req, res, next) => {
    const sendJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      const session = req.header('X-Demo-Session')?.toLowerCase();
      const requestPath = req.originalUrl.split(/[?#]/,1)[0] || '/';
      const value = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
      if (!/^\/api\//i.test(requestPath) || /^\/api\/errors\/?$/i.test(requestPath) || res.statusCode < 400 || !session || !UUID.test(session)
        || typeof value?.incidentId === 'string' && UUID.test(value.incidentId)) return sendJson(body);
      // Capture categorical metadata only. Never pass bodies, credentials, raw
      // exception messages or provider responses into the incident recorder.
      const code = applicationErrorCode(value?.code);
      const path = safeErrorPath(requestPath);
      const now = Date.now();
      const fingerprint = `${session}:${code}:${path}:${res.statusCode}`;
      const cached = capturedRequests.get(fingerprint);
      let result = cached && cached.expiresAt > now ? cached.result : undefined;
      if (!result) {
        const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
        // Recording rejected traffic must stay bounded even after its API budget
        // is exhausted. Identical rapid failures share their existing incident.
        if (!withinLimit(`capture-session:${session}`,60) || !withinLimit(`capture-ip:${ip}`,120)) return sendJson(body);
        result = errorReporter.report(session,{source:'api',code,path,httpStatus:res.statusCode,eventId:randomUUID()});
        capturedRequests.set(fingerprint,{expiresAt:now+5000,result});
        if (capturedRequests.size > 1000) {
          for (const [key,entry] of capturedRequests) if (entry.expiresAt <= now) capturedRequests.delete(key);
          while (capturedRequests.size > 1000) capturedRequests.delete(capturedRequests.keys().next().value!);
        }
        void result.catch(() => { if (capturedRequests.get(fingerprint)?.result === result) capturedRequests.delete(fingerprint); });
      }
      void result
        .then(result => { if (!res.destroyed && !res.headersSent) sendJson(value ? { ...value,incidentId:result.incidentId } : { error:'The request failed.',incidentId:result.incidentId }); })
        .catch(() => { if (!res.destroyed && !res.headersSent) sendJson(body); });
      return res;
    }) as typeof res.json;
    next();
  });
  const sandbox = createSandbox(store, nonce, options.sandboxLatencyMs ?? 220);
  const localOrigins = process.env.NODE_ENV === 'production' ? [] : ['http://localhost:5173', 'http://localhost:4173', 'http://127.0.0.1:5173', 'http://127.0.0.1:4173'];
  const origins = options.corsOrigins ?? [process.env.CORS_ORIGIN, ...localOrigins].filter((origin): origin is string => Boolean(origin));
  app.use(cors({ origin: (origin, callback) => { if (!origin || origins.includes(origin)) callback(null, true); else callback(new WorkflowError(403, 'ORIGIN_NOT_ALLOWED', 'This origin is not allowed to access the demo API.')); }, methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'X-Demo-Session'] }));
  const commerceOptions: CommerceOptions = { ...options.commerce,database: store.driver };
  const observer = observerConnection(options.observer);
  const registerObserverProxy = registerObservability(app,store,commerceOptions,observer,{ errorReporter });
  registerCommerceWebhook(app,store,commerceOptions);
  app.use(express.json({ limit: '8kb' }));
  app.get('/health', (_req, res) => res.json(engine.health));
  app.use('/sandbox', sandbox.router);

  const buckets = new Map<string, RateEntry>();
  const limits = options.rateLimits ?? { reads: 600, mutationsPerSession: 12, mutationsPerIp: 60 };
  let lastPrune = Date.now();
  function withinLimit(key: string, limit: number): boolean {
    const now = Date.now(); let entry = buckets.get(key);
    if (!entry || now >= entry.resetAt) { entry = { count: 0, resetAt: now + 60_000 }; buckets.set(key, entry); }
    if (++entry.count > limit) return false;
    if (buckets.size > 1000) for (const [bucket, value] of buckets) if (now > value.resetAt) buckets.delete(bucket);
    return true;
  }
  app.use('/api', async (req, res, next) => {
    const session = req.header('X-Demo-Session') ?? '';
    if (!UUID.test(session)) { jsonError(res, 400, 'SESSION_REQUIRED', 'Send a browser-generated UUID in X-Demo-Session.'); return; }
    res.locals.session = session.toLowerCase();
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const mutation = req.method !== 'GET';
    const allowed = /^\/errors\/?$/i.test(req.path) && mutation ? withinLimit(`reports-session:${session.toLowerCase()}`,60) && withinLimit(`reports-ip:${ip}`,120) : mutation
      ? withinLimit(`mutation-ip:${ip}`, limits.mutationsPerIp) && withinLimit(`mutation-session:${session.toLowerCase()}`, limits.mutationsPerSession)
      : withinLimit(`read-ip:${ip}`, limits.reads);
    if (!allowed) { res.setHeader('Retry-After', '60'); jsonError(res, 429, 'RATE_LIMITED', 'Demo request limit reached. Wait one minute and try again.'); return; }
    if (historyPolicy === 'temporary' && Date.now() - lastPrune > 15 * 60_000) { await store.prune(new Date(Date.now() - 24 * 60 * 60_000).toISOString()); lastPrune = Date.now(); }
    next();
  });
  app.post('/api/errors', async (req, res) => {
    const result = await errorReporter.report(String(res.locals.session),req.body);
    res.setHeader('Cache-Control','no-store'); res.status(result.created ? 201 : 200).json(result);
  });
  app.get('/api/workflows', (_req, res) => res.json([WORKFLOW]));
  app.post('/api/runs', async (req, res) => {
    const body = req.body as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) { jsonError(res, 400, 'INVALID_REQUEST', 'Provide a workflow ID and scenario.'); return; }
    const input = body as Record<string, unknown>;
    if (Object.keys(input).some(key => !['workflowId', 'scenario'].includes(key)) || (input.workflowId !== undefined && input.workflowId !== WORKFLOW.id) || typeof input.scenario !== 'string' || !['healthy', 'checkout_500', 'receipt_order_missing'].includes(input.scenario)) { jsonError(res, 400, 'INVALID_REQUEST', 'Only the fixed commerce-checkout workflow and its three sandbox scenarios are supported.'); return; }
    const run = await engine.enqueue(res.locals.session as string, input.scenario as Scenario);
    res.status(202).json({ runId: run.id });
  });
  app.get('/api/runs/:id', async (req, res) => {
    const run = await store.getRun(String(req.params.id), res.locals.session as string);
    if (!run) { jsonError(res, 404, 'NOT_FOUND', 'Run was not found in this demo session.'); return; }
    res.json(run);
  });
  app.get('/api/incidents', async (_req, res) => {
    const session = String(res.locals.session);
    await liveMonitor.syncKnownFailures(session);
    await registerObserverProxy.syncKnownFailures(session);
    res.json(await store.listIncidents(session));
  });
  app.get('/api/incidents/:id', async (req, res) => {
    const incident = await store.getIncident(String(req.params.id), res.locals.session as string);
    if (!incident) { jsonError(res, 404, 'NOT_FOUND', 'Incident was not found in this demo session.'); return; }
    res.json(incident);
  });
  app.post('/api/incidents/:id/recover', async (req, res) => {
    const input = req.body as Record<string, unknown> | null;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['action', 'approved'].includes(key)) || input.action !== 'resume_receipt_worker' || input.approved !== true) { jsonError(res, 400, 'APPROVAL_REQUIRED', 'Explicit approval and the supported resume_receipt_worker action are required.'); return; }
    const result = await engine.recover(res.locals.session as string, String(req.params.id));
    res.json(result);
  });
  app.get('/api/metrics', async (_req, res) => res.json(await engine.metrics(res.locals.session as string)));
  registerCommerce(app,store,commerceOptions);
  const login = registerLogin(app,store,options.login);
  registerObserverProxy();
  const liveMonitor = registerLiveMonitor(app,store,{
    ...options.live,
    errorReporter,
    browserProbe: options.live?.browserProbe ?? (observer ? session => observer.probe(session) : undefined),
    monitoring: options.live?.monitoring ?? { enabled:!!observer, intervalSeconds:30, scope:'independent-owned-targets', independentObserver:!!observer },
  });
  registerHostedFrontend(app);
  app.use((_req, res) => jsonError(res, 404, 'NOT_FOUND', 'Endpoint not found.'));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof WorkflowError) { jsonError(res, error.status, error.code, error.message); return; }
    if (error instanceof SyntaxError && 'body' in error) { jsonError(res, 400, 'INVALID_JSON', 'Request body must be valid JSON.'); return; }
    if (error instanceof Error && 'status' in error && error.status === 413) { jsonError(res, 413, 'BODY_TOO_LARGE', 'Demo request body exceeds the 8 KB limit.'); return; }
    console.error('Backend request failed: an internal operation could not complete.');
    jsonError(res, 500, 'INTERNAL_ERROR', 'The demo could not complete this request. Try again shortly.');
  });
  return { app, store, engine, sandbox, liveMonitor, login, errorReporter };
}

export async function startServer(options: AppOptions & { port?: number; host?: string } = {}) {
  const runtime = await createApp(options);
  const server: Server = await new Promise((resolveServer, reject) => {
    const listening = runtime.app.listen(options.port ?? 3001, options.host ?? '0.0.0.0', () => resolveServer(listening)); listening.once('error', reject);
  });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  const baseUrl = `http://127.0.0.1:${address.port}`; runtime.engine.setBaseUrl(baseUrl);
  runtime.liveMonitor.setBaseUrl(baseUrl, process.env.PUBLIC_APP_URL ?? (process.env.SERVE_FRONTEND === 'true' && process.env.NODE_ENV === 'production' ? 'https://bizplus-ai-api.onrender.com' : undefined));
  let closed = false;
  return { ...runtime, server, baseUrl, close: async () => {
    if (closed) return; closed = true;
    await runtime.engine.drain(); await runtime.sandbox.drain(); await runtime.liveMonitor.drain(); await runtime.login.drain(); await runtime.errorReporter.drain();
    await new Promise<void>((resolveClose, reject) => { server.close(error => error ? reject(error) : resolveClose()); server.closeIdleConnections(); });
    await runtime.store.close();
  } };
}
