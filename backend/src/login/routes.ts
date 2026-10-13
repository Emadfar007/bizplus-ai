import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Express } from 'express';
import { DEMO_LOGIN_PASSWORD, DEMO_LOGIN_USERNAME, type Evidence, type Incident, type LoginConfig, type LoginRequest, type LoginResult, type LoginRecoveryResult, type Run, type StepResult } from '@bizplus/shared';
import type { DataStore } from '../database/types.js';
import { WorkflowError } from '../engine/workflow.js';

export interface LoginOptions { username?: string; password?: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUCCESS = 'Login successful';
const REJECTED = 'Invalid username or password';
const WORKFLOW_ID = 'manual-login';

function parseRequest(body: unknown): LoginRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WorkflowError(400, 'INVALID_LOGIN_REQUEST', 'Enter a username and password.');
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => !['username', 'password', 'source', 'incidentId', 'labRevision'].includes(key))
    || typeof input.username !== 'string' || input.username.length > 128
    || typeof input.password !== 'string' || input.password.length > 256
    || (input.source !== undefined && input.source !== 'login' && input.source !== 'live_test')
    || (input.incidentId !== undefined && (typeof input.incidentId !== 'string' || !UUID.test(input.incidentId)))
    || (input.labRevision !== undefined && (typeof input.labRevision !== 'string' || !UUID.test(input.labRevision)))) {
    throw new WorkflowError(400, 'INVALID_LOGIN_REQUEST', 'Provide only a username, password, and supported demo context.');
  }
  return { username: input.username, password: input.password, source: input.source ?? 'login',
    ...(input.incidentId === undefined ? {} : { incidentId: String(input.incidentId).toLowerCase() }),
    ...(input.labRevision === undefined ? {} : { labRevision: String(input.labRevision).toLowerCase() }) };
}

function digest(value: string): Buffer { return createHash('sha256').update(value, 'utf8').digest(); }
function event(kind: Evidence['kind'], timestamp: string, message: string, data: Record<string, unknown>): Evidence {
  return { id: randomUUID(), kind, timestamp, message, data };
}
function loginStep(accepted: boolean, source: LoginRequest['source'], startedAt: string, durationMs: number, recovery = false): StepResult {
  const completedAt = new Date().toISOString();
  const httpStatus = accepted ? 200 : 401;
  const message = accepted ? SUCCESS : REJECTED;
  const assertion = { code: 'LOGIN_ACCEPTED', expected: 'HTTP 200 and Login successful', actual: `HTTP ${httpStatus} and ${message}`, passed: accepted };
  const evidence = [
    event('response', completedAt, `Human-submitted login returned HTTP ${httpStatus}.`, { httpStatus, message, source, manualOnly: true, credentials: 'redacted', requestId: randomUUID() }),
    event('assertion', completedAt, recovery ? 'Verify the credentials entered by the human for recovery.' : 'Verify the result of the login submitted by the human.', { ...assertion }),
  ];
  return { id: 'login', name: recovery ? 'Manual login recovery' : 'Manual login', method: 'POST', path: '/api/login', status: accepted ? 'passed' : 'failed',
    expected: assertion.expected, actual: assertion.actual, durationMs, httpStatus, startedAt, completedAt, assertions: [assertion], evidence,
    ...(accepted ? {} : { errorCategory: 'login_rejected' }) };
}

/**
 * This checks a synthetic demo credential pair. It does not issue an account token or gate
 * the application. A credential rejection is observable, but the monitor/AI cannot retry
 * or recover it. The human must submit corrected credentials for the original incident.
 * Submitted usernames and passwords never enter stored runs, evidence, logs, or errors.
 */
export function registerLogin(app: Express, store: DataStore, options: LoginOptions = {}) {
  const configuredUsername = options.username ?? process.env.DEMO_LOGIN_USERNAME;
  const configuredPassword = options.password ?? process.env.DEMO_LOGIN_PASSWORD;
  const username = configuredUsername ?? DEMO_LOGIN_USERNAME;
  const password = configuredPassword ?? DEMO_LOGIN_PASSWORD;
  if (!username || username.length > 128 || !password || password.length > 256) throw new Error('Controlled demo login credentials must be nonempty and within the supported lengths.');
  const usernameDigest = digest(username); const passwordDigest = digest(password);
  const customCredentials = configuredUsername !== undefined || configuredPassword !== undefined;
  const config: LoginConfig = { mode: 'controlled_demo', demo: true, manualOnly: true, defaultCredentials: !customCredentials, customCredentials,
    ...(customCredentials ? {} : { username: DEMO_LOGIN_USERNAME, password: DEMO_LOGIN_PASSWORD }) };
  const active = new Map<string, Promise<unknown>>();

  function credentialsAccepted(input: LoginRequest): boolean {
    // Evaluate both comparisons with fixed-size digests, regardless of the first result.
    const correctUsername = timingSafeEqual(digest(input.username), usernameDigest);
    const correctPassword = timingSafeEqual(digest(input.password), passwordDigest);
    return correctUsername && correctPassword;
  }
  function serialized<T>(session: string, operation: () => Promise<T>): Promise<T> {
    const previous = active.get(session) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    active.set(session, pending);
    void pending.finally(() => { if (active.get(session) === pending) active.delete(session); }).catch(() => undefined);
    return pending;
  }
  async function attempt(session: string, input: LoginRequest): Promise<LoginResult> {
    const started = performance.now(); const attemptedAt = new Date().toISOString();
    let original: Incident | null = null;
    if (input.incidentId) {
      original = await store.getIncident(input.incidentId, session);
      if (!original) throw new WorkflowError(404, 'NOT_FOUND', 'Incident was not found in this demo session.');
      if (original.workflowId !== WORKFLOW_ID || !original.login?.manualOnly) throw new WorkflowError(409, 'NOT_LOGIN_INCIDENT', 'Choose a login rejection incident for manual login recovery.');
    }
    const accepted = credentialsAccepted(input);
    // A stale recovery form may be used after another tab already resolved the
    // incident. A new rejection must be recorded as a fresh failure, while the
    // old verified incident stays intact. Correct repeats remain idempotent.
    if (original?.status === 'resolved' && original.manualRecovery?.status === 'verified') {
      if (accepted) return { status: 'successful', message: SUCCESS, runId: original.runId, incidentId: original.id, recovery: original.manualRecovery };
      original = null;
    }
    const source = original?.login?.source ?? input.source;
    const step = loginStep(accepted, source, attemptedAt, Math.round(performance.now() - started), !!original);
    if (original) {
      const recovery: LoginRecoveryResult = { id: randomUUID(), status: accepted ? 'verified' : 'failed', actor: 'human', attemptedAt,
        completedAt: step.completedAt!, durationMs: step.durationMs, verification: step,
        evidence: [event('recovery', step.completedAt!, accepted ? 'The human supplied valid demo credentials; the original login incident is resolved.' : 'The credentials entered by the human were rejected; the original login incident remains open.', { accepted, actor: 'human', credentials: 'redacted', originalRunId: original.runId }), ...step.evidence] };
      original.manualRecovery = recovery; original.status = accepted ? 'resolved' : 'open'; original.resolvedAt = accepted ? recovery.completedAt : null;
      original.evidence.push(...recovery.evidence);
      await store.saveIncident(session, original);
      return { status: accepted ? 'successful' : 'rejected', message: accepted ? SUCCESS : REJECTED, runId: original.runId, incidentId: original.id, recovery,
        ...(accepted ? {} : { error: REJECTED, code: 'LOGIN_REJECTED' }) };
    }
    const runId = randomUUID(); const incidentId = accepted ? null : randomUUID();
    const run: Run = { id: runId, workflowId: WORKFLOW_ID, scenario: 'manual_login', status: accepted ? 'passed' : 'failed', createdAt: attemptedAt,
      completedAt: step.completedAt, durationMs: step.durationMs, steps: [step], incidentId, orderId: null, transactionId: null, amountMinor: 0, paymentCount: 0 };
    await store.saveRun(session, run);
    if (incidentId) {
      const incident: Incident = { id: incidentId, runId, workflowId: WORKFLOW_ID, title: 'Login rejected', status: 'open', createdAt: attemptedAt, resolvedAt: null,
        failedStepId: step.id, fingerprint: 'manual-login:login:HTTP401', evidence: step.evidence, recovery: null, relatedIncidentIds: [],
        login: { source: input.source ?? 'login', manualOnly: true, ...(input.labRevision ? { labRevision: input.labRevision } : {}) },
        diagnosis: { source: 'rules', summary: 'The controlled demo rejected the credentials entered by the human.', observedFacts: ['A human submitted the login form.', 'The server rejected the credential pair with HTTP 401.', 'No submitted username or password was saved.'],
          possibleCauses: ['The username or password does not match the configured synthetic demo credentials.'], evidenceIds: step.evidence.map(item => item.id), recommendedAction: null,
          guidance: 'The human must enter the correct demo username and password in the recovery form. The server verifies them before resolving this incident. AI and automatic monitoring cannot sign in, reset credentials, or recover login.' } };
      await store.saveIncident(session, incident);
    }
    return { status: accepted ? 'successful' : 'rejected', message: accepted ? SUCCESS : REJECTED, runId, incidentId,
      ...(accepted ? {} : { error: REJECTED, code: 'LOGIN_REJECTED' }) };
  }
  app.get('/api/login/config', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(config); });
  app.post('/api/login', async (req, res) => {
    const input = parseRequest(req.body);
    const result = await serialized(res.locals.session as string, () => attempt(res.locals.session as string, input));
    res.setHeader('Cache-Control', 'no-store'); res.status(result.status === 'successful' ? 200 : 401).json(result);
  });
  return { config, drain: async () => { await Promise.allSettled([...active.values()]); } };
}
