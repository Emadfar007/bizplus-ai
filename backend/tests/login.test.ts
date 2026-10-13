import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Incident, IncidentList, LoginConfig, LoginResult, Metrics } from '@bizplus/shared';
import { startServer, type AppOptions } from '../src/app.js';
import { Store } from '../src/database/store.js';

type Runtime = Awaited<ReturnType<typeof startServer>>;
const valid = { username: 'owner', password: 'BizPlus@123' };
async function api(runtime: Runtime, session: string, path: string, body?: unknown) {
  return fetch(`${runtime.baseUrl}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Demo-Session': session,
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function withRuntime(operation: (runtime: Runtime, session: string) => Promise<void>, options: AppOptions = {}) {
  const runtime = await startServer({ port: 0, databasePath: ':memory:', sandboxLatencyMs: 0,
    rateLimits: { reads: 600, mutationsPerSession: 100, mutationsPerIp: 600 }, ...options });
  try { await operation(runtime, randomUUID()); } finally { await runtime.close(); }
}
async function login(runtime: Runtime, session: string, credentials: Record<string, unknown>): Promise<{ response: Response; result: LoginResult }> {
  const response = await api(runtime, session, '/api/login', credentials);
  return { response, result: await response.json() as LoginResult };
}

test('human-submitted bad credentials return a real HTTP 401 and a redacted Investigation incident', async () => {
  await withRuntime(async (runtime, session) => {
    const attempt = { username: 'attempted-user-private-9381', password: 'attempted-password-private-2935', source: 'live_test', labRevision: randomUUID() };
    const { response, result } = await login(runtime, session, attempt);
    assert.equal(response.status, 401); assert.equal(result.status, 'rejected'); assert.equal(result.message, 'Invalid username or password');
    assert.equal(result.code, 'LOGIN_REJECTED'); assert.ok(result.incidentId); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const list = await (await api(runtime, session, '/api/incidents')).json() as IncidentList;
    assert.equal(list.incidents.length, 1); const incident = list.incidents[0]!;
    assert.equal(incident.id, result.incidentId); assert.equal(incident.title, 'Login rejected'); assert.equal(incident.status, 'open');
    assert.equal(incident.workflowId, 'manual-login'); assert.equal(incident.login?.manualOnly, true);
    assert.equal(incident.login?.source, 'live_test'); assert.equal(incident.login?.labRevision, attempt.labRevision);
    assert.equal(incident.diagnosis.recommendedAction, null); assert.equal(incident.recovery, null); assert.equal(incident.manualRecovery, undefined);
    const run = await runtime.store.getRun(result.runId, session); assert.ok(run);
    assert.equal(run.status, 'failed'); assert.equal(run.scenario, 'manual_login'); assert.equal(run.steps[0]?.httpStatus, 401);
    assert.equal(run.paymentCount, 0); assert.equal(run.amountMinor, 0); assert.equal(run.transactionId, null); assert.equal(run.orderId, null);
    assert.ok(incident.evidence.some(item => item.data?.credentials === 'redacted'));
    const logs = await runtime.store.logs(result.runId);
    const exposed = JSON.stringify({ result, list, run, logs });
    assert.ok(!exposed.includes(attempt.username)); assert.ok(!exposed.includes(attempt.password));
    const store = runtime.store as Store;
    const persisted = JSON.stringify({ runs: store.db.prepare('SELECT data FROM runs').all(), incidents: store.db.prepare('SELECT data FROM incidents').all(), logs: store.db.prepare('SELECT message FROM logs').all() });
    assert.ok(!persisted.includes(attempt.username)); assert.ok(!persisted.includes(attempt.password));
  });
});

test('correct demo credentials show Login successful with no rejection incident or account token', async () => {
  await withRuntime(async (runtime, session) => {
    const { response, result } = await login(runtime, session, valid);
    assert.equal(response.status, 200); assert.equal(result.status, 'successful'); assert.equal(result.message, 'Login successful');
    assert.equal(result.incidentId, null); assert.equal(result.error, undefined); assert.equal(response.headers.get('set-cookie'), null);
    const run = await runtime.store.getRun(result.runId, session); assert.equal(run?.status, 'passed'); assert.equal(run?.steps[0]?.httpStatus, 200);
    assert.equal((await runtime.store.listIncidents(session)).incidents.length, 0);
    assert.ok(!JSON.stringify(run).includes(valid.password)); assert.ok(!JSON.stringify(run).includes(`"${valid.username}"`));
  });
});

test('manual correct recovery resolves the owned incident and preserves the original rejection', async () => {
  await withRuntime(async (runtime, session) => {
    const rejected = await login(runtime, session, { ...valid, password: 'first-wrong-password' });
    const incidentId = rejected.result.incidentId!;
    const originalRun = await runtime.store.getRun(rejected.result.runId, session);
    const originalEvidence = (await runtime.store.getIncident(incidentId, session))!.evidence;
    const stillWrong = await login(runtime, session, { ...valid, password: 'second-wrong-password', incidentId });
    assert.equal(stillWrong.response.status, 401); assert.equal(stillWrong.result.incidentId, incidentId); assert.equal(stillWrong.result.recovery?.status, 'failed');
    const open = await runtime.store.getIncident(incidentId, session); assert.equal(open?.status, 'open'); assert.equal(open?.resolvedAt, null);
    assert.equal(open?.manualRecovery?.verification.httpStatus, 401);
    const automatic = await api(runtime, session, `/api/incidents/${incidentId}/recover`, { approved: true, action: 'resume_receipt_worker' });
    assert.equal(automatic.status, 409);
    const blockedRecovery = await automatic.json() as { code: string; incidentId: string };
    assert.equal(blockedRecovery.code, 'RECOVERY_UNSUPPORTED'); assert.ok(blockedRecovery.incidentId); assert.notEqual(blockedRecovery.incidentId, incidentId);
    const blockedIncident = await runtime.store.getIncident(blockedRecovery.incidentId, session);
    assert.equal(blockedIncident?.application?.source, 'api'); assert.equal(blockedIncident?.application?.httpStatus, 409);
    assert.equal(blockedIncident?.application?.path, '/api/incidents/:id/recover'); assert.equal(blockedIncident?.login, undefined);
    assert.equal(blockedIncident?.diagnosis.recommendedAction, null); assert.equal(blockedIncident?.status, 'open');
    const recovered = await login(runtime, session, { ...valid, incidentId });
    assert.equal(recovered.response.status, 200); assert.equal(recovered.result.message, 'Login successful'); assert.equal(recovered.result.recovery?.status, 'verified');
    assert.equal(recovered.result.recovery?.actor, 'human'); assert.equal(recovered.result.recovery?.verification.httpStatus, 200);
    const resolved = await (await api(runtime, session, `/api/incidents/${incidentId}`)).json() as Incident;
    assert.equal(resolved.status, 'resolved'); assert.ok(resolved.resolvedAt); assert.equal(resolved.recovery, null);
    const metrics = await (await api(runtime, session, '/api/metrics')).json() as Metrics;
    assert.equal(metrics.verifiedRecoveries, 1); assert.equal(metrics.openIncidents, 1); assert.equal(metrics.failedRuns, 1);
    assert.equal((await runtime.store.getIncident(blockedRecovery.incidentId, session))?.status, 'open');
    assert.deepEqual(resolved.evidence.slice(0, originalEvidence.length), originalEvidence);
    assert.deepEqual(await runtime.store.getRun(rejected.result.runId, session), originalRun);
    const repeated = await login(runtime, session, { ...valid, incidentId });
    assert.equal(repeated.response.status, 200); assert.equal(repeated.result.recovery?.id, recovered.result.recovery?.id);
    const runsAfterRecovery = await runtime.store.listRuns(session);
    assert.equal(runsAfterRecovery.length, 2); assert.equal(runsAfterRecovery.filter(run => run.scenario === 'manual_login').length, 1);
    assert.equal(runsAfterRecovery.filter(run => run.scenario === 'application_error').length, 1);
    const resolvedSnapshot = await runtime.store.getIncident(incidentId, session);
    const badAfterRecovery = await login(runtime, session, { ...valid, password: 'wrong-after-resolution', incidentId });
    assert.equal(badAfterRecovery.response.status, 401); assert.equal(badAfterRecovery.result.recovery, undefined);
    assert.ok(badAfterRecovery.result.incidentId); assert.notEqual(badAfterRecovery.result.incidentId, incidentId); assert.notEqual(badAfterRecovery.result.runId, rejected.result.runId);
    const newFailure = await runtime.store.getIncident(badAfterRecovery.result.incidentId!, session);
    assert.equal(newFailure?.status, 'open'); assert.equal(newFailure?.manualRecovery, undefined);
    const prior = await runtime.store.getIncident(incidentId, session);
    // relatedIncidentIds is computed at read time and now includes the new rejection.
    assert.deepEqual({ ...prior, relatedIncidentIds: [] }, { ...resolvedSnapshot, relatedIncidentIds: [] });
    const finalRuns = await runtime.store.listRuns(session);
    assert.equal(finalRuns.length, 3); assert.equal(finalRuns.filter(run => run.scenario === 'manual_login').length, 2);
    assert.equal(finalRuns.filter(run => run.scenario === 'application_error').length, 1);
    assert.equal((await runtime.store.getRun(badAfterRecovery.result.runId, session))?.steps[0]?.httpStatus, 401);
  });
});

test('a successful separate login does not silently resolve an earlier rejection', async () => {
  await withRuntime(async (runtime, session) => {
    const failure = await login(runtime, session, { ...valid, password: 'wrong' });
    assert.equal((await login(runtime, session, valid)).response.status, 200);
    assert.equal((await runtime.store.getIncident(failure.result.incidentId!, session))?.status, 'open');
    assert.equal((await runtime.store.listRuns(session)).length, 2);
  });
});

test('login recovery is session isolated and rejects non-login incidents or invented recovery controls', async () => {
  await withRuntime(async (runtime, session) => {
    const failure = await login(runtime, session, { ...valid, password: 'wrong' });
    const originalBeforeForeignRequest = await runtime.store.getIncident(failure.result.incidentId!, session);
    const other = randomUUID();
    const foreign = await login(runtime, other, { ...valid, incidentId: failure.result.incidentId });
    assert.equal(foreign.response.status, 404); assert.ok(foreign.result.incidentId); assert.notEqual(foreign.result.incidentId, failure.result.incidentId);
    const foreignRuns = await runtime.store.listRuns(other); const foreignIncidents = await runtime.store.listIncidents(other);
    assert.equal(foreignRuns.length, 1); assert.equal(foreignRuns[0]?.scenario, 'application_error');
    assert.equal(foreignIncidents.incidents.length, 1); const foreignIncident = foreignIncidents.incidents[0]!;
    assert.equal(foreignIncident.id, foreign.result.incidentId); assert.equal(foreignIncident.login, undefined); assert.equal(foreignIncident.manualRecovery, undefined);
    assert.equal(foreignIncident.application?.source, 'api'); assert.equal(foreignIncident.application?.code, 'NOT_FOUND');
    assert.equal(foreignIncident.application?.path, '/api/login'); assert.equal(foreignIncident.application?.httpStatus, 404);
    const foreignHistory = JSON.stringify({ result: foreign.result, runs: foreignRuns, incidents: foreignIncidents });
    assert.ok(!foreignHistory.includes(failure.result.incidentId!)); assert.ok(!foreignHistory.includes(valid.password));
    assert.ok(!foreignHistory.includes(`"${valid.username}"`));
    assert.equal(await runtime.store.getIncident(failure.result.incidentId!, other), null);
    assert.deepEqual(await runtime.store.getIncident(failure.result.incidentId!, session), originalBeforeForeignRequest);
    const incident = (await runtime.store.getIncident(failure.result.incidentId!, session))!;
    await runtime.store.saveIncident(session, { ...incident, workflowId: 'commerce-checkout', login: undefined });
    assert.equal((await login(runtime, session, { ...valid, incidentId: incident.id })).response.status, 409);
    assert.equal((await api(runtime, session, '/api/login', { ...valid, approved: true, resetCredentials: true })).status, 400);
    assert.equal((await api(runtime, session, '/api/runs', { scenario: 'manual_login' })).status, 400);
    assert.equal((await fetch(`${runtime.baseUrl}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(valid) })).status, 400);
    assert.equal((await api(runtime, session, '/api/login', { username: ['owner'], password: 'private' })).status, 400);
    assert.equal((await api(runtime, session, '/api/login', { ...valid, incidentId: 'malformed' })).status, 400);
    assert.equal((await api(runtime, session, '/api/login', { ...valid, source: 'ai' })).status, 400);
  });
});

test('concurrent valid manual recovery requests keep one verified result', async () => {
  await withRuntime(async (runtime, session) => {
    const failure = await login(runtime, session, { ...valid, password: 'wrong' });
    const attempts = await Promise.all([login(runtime, session, { ...valid, incidentId: failure.result.incidentId }), login(runtime, session, { ...valid, incidentId: failure.result.incidentId })]);
    assert.ok(attempts.every(attempt => attempt.response.status === 200));
    assert.equal(attempts[0]?.result.recovery?.id, attempts[1]?.result.recovery?.id);
    const incident = (await runtime.store.getIncident(failure.result.incidentId!, session))!;
    assert.equal(incident.evidence.filter(item => item.kind === 'recovery').length, 1);
    assert.equal((await runtime.store.listRuns(session)).length, 1);
  });
});

test('configured demo credentials stay private, and only those credentials are accepted', async () => {
  await withRuntime(async (runtime, session) => {
    const config = await (await api(runtime, session, '/api/login/config')).json() as LoginConfig;
    assert.equal(config.demo, true); assert.equal(config.mode, 'controlled_demo'); assert.equal(config.manualOnly, true);
    assert.equal(config.customCredentials, true); assert.equal(config.defaultCredentials, false); assert.equal(config.username, undefined); assert.equal(config.password, undefined);
    assert.ok(!JSON.stringify(config).includes('configured-private-password'));
    assert.equal((await login(runtime, session, valid)).response.status, 401);
    const accepted = await login(runtime, session, { username: 'configured-private-owner', password: 'configured-private-password' });
    assert.equal(accepted.response.status, 200);
    const history = JSON.stringify(await runtime.store.listRuns(session));
    assert.ok(!history.includes('configured-private-owner')); assert.ok(!history.includes('configured-private-password'));
  }, { login: { username: 'configured-private-owner', password: 'configured-private-password' } });
});

test('default config shares only public synthetic credentials and empty credentials are rejected', async () => {
  await withRuntime(async (runtime, session) => {
    const config = await (await api(runtime, session, '/api/login/config')).json() as LoginConfig;
    assert.equal(config.defaultCredentials, true); assert.equal(config.customCredentials, false);
    assert.equal(config.username, valid.username); assert.equal(config.password, valid.password);
    const rejected = await login(runtime, session, { username: '', password: '' });
    assert.equal(rejected.response.status, 401); assert.ok(rejected.result.incidentId);
  });
});

test('manual recovery after a backend restart keeps the original failed login evidence', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'bizplus-login-test-'));
  const databasePath = join(folder, 'login-history.sqlite'); const session = randomUUID();
  let runtime = await startServer({ port: 0, databasePath, sandboxLatencyMs: 0 });
  try {
    const rejection = await login(runtime, session, { username: 'private-restart-user', password: 'private-restart-password' });
    const original = await runtime.store.getRun(rejection.result.runId, session);
    await runtime.close(); runtime = await startServer({ port: 0, databasePath, sandboxLatencyMs: 0 });
    const persisted = await runtime.store.getIncident(rejection.result.incidentId!, session);
    assert.equal(persisted?.status, 'open'); assert.equal(persisted?.login?.manualOnly, true);
    const recovered = await login(runtime, session, { ...valid, incidentId: rejection.result.incidentId });
    assert.equal(recovered.result.recovery?.status, 'verified'); assert.deepEqual(await runtime.store.getRun(rejection.result.runId, session), original);
    const history = JSON.stringify(await runtime.store.listIncidents(session));
    assert.ok(!history.includes('private-restart-user')); assert.ok(!history.includes('private-restart-password'));
  } finally {
    await runtime.close();
    // This disposable folder was freshly created by the test; verify the absolute root before deletion.
    assert.equal(dirname(resolve(folder)), resolve(tmpdir())); assert.ok(basename(folder).startsWith('bizplus-login-test-'));
    await rm(folder, { recursive: true, force: true });
  }
});
