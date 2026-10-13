import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Incident, IncidentList, Metrics, RecoveryResult, Run, Scenario } from '@bizplus/shared';
import { startServer, type AppOptions } from '../src/app.js';
import { Store } from '../src/database/store.js';
import type { DataStore } from '../src/database/types.js';

type Runtime = Awaited<ReturnType<typeof startServer>>;
async function api(runtime: Runtime, session: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${runtime.baseUrl}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Demo-Session': session, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function runScenario(runtime: Runtime, session: string, scenario: Scenario): Promise<Run> {
  const started = await api(runtime, session, '/api/runs', { workflowId: 'commerce-checkout', scenario });
  assert.equal(started.status, 202);
  const { runId } = await started.json() as { runId: string };
  for (let attempt = 0; attempt < 300; attempt++) {
    const response = await api(runtime, session, `/api/runs/${runId}`); assert.equal(response.status, 200);
    const run = await response.json() as Run;
    if (run.status === 'passed' || run.status === 'failed') return run;
    await delay(5);
  }
  throw new Error('Workflow did not finish within test deadline');
}
async function withRuntime(operation: (runtime: Runtime, session: string) => Promise<void>, options: AppOptions = {}) {
  const runtime = await startServer({ port: 0, databasePath: ':memory:', sandboxLatencyMs: 0, corsOrigins: ['http://localhost:5173'], ...options });
  try { await operation(runtime, randomUUID()); } finally { await runtime.close(); }
}
const approval = { action: 'resume_receipt_worker', approved: true };
async function removeTestFolder(folder: string): Promise<void> {
  assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
  assert.ok(basename(folder).startsWith('bizplus-test-') || basename(folder).startsWith('bizplus-interruption-'));
  await rm(folder, { recursive: true, force: true });
}

test('healthy workflow executes real HTTP steps and validates one payment and original order', async () => {
  await withRuntime(async (runtime, session) => {
    const health = await fetch(`${runtime.baseUrl}/health`); assert.equal(health.status, 200);
    const workflows = await api(runtime, session, '/api/workflows'); assert.equal((await workflows.json()).length, 1);
    const run = await runScenario(runtime, session, 'healthy');
    assert.equal(run.status, 'passed'); assert.equal(run.steps.length, 5); assert.equal(run.paymentCount, 1); assert.equal(run.incidentId, null);
    assert.ok(run.orderId); assert.ok(run.transactionId); assert.equal(run.amountMinor, 129900);
    assert.ok(!JSON.stringify(run).includes(`sandbox:${run.id}`), 'Synthetic session token must not appear in persisted evidence');
    for (const step of run.steps) {
      assert.equal(step.status, 'passed'); assert.equal(step.httpStatus, 200); assert.ok(step.completedAt); assert.ok(step.durationMs >= 0);
      assert.ok(step.assertions.length >= 3); assert.ok(step.assertions.every(a => a.passed)); assert.ok(step.evidence.some(e => e.kind === 'response')); assert.ok(step.evidence.some(e => e.kind === 'log'));
    }
    const metrics = await (await api(runtime, session, '/api/metrics')).json() as Metrics;
    assert.equal(metrics.totalRuns, 1); assert.equal(metrics.passedRuns, 1); assert.equal(metrics.failedRuns, 0); assert.equal(metrics.successRate, 100); assert.equal(metrics.chart.length, 1);
    assert.equal(metrics.chart[0]?.durationMs, run.durationMs);
    const repeatCheckout = await fetch(`${runtime.baseUrl}/sandbox/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sandbox-Key': runtime.engine.nonce, 'X-Sandbox-Run': run.id, Authorization: `Bearer sandbox:${run.id}` }, body: JSON.stringify({ idempotencyKey: `checkout:${run.id}`, amountMinor: run.amountMinor }) });
    assert.equal(repeatCheckout.status, 200);
    const samePayment = await repeatCheckout.json(); assert.equal(samePayment.orderId, run.orderId); assert.equal(samePayment.transactionId, run.transactionId); assert.equal(runtime.store.paymentCount(run.id), 1);
  });
});

test('checkout HTTP 500 fails before payment writes and dependent confirmation is skipped', async () => {
  await withRuntime(async (runtime, session) => {
    const run = await runScenario(runtime, session, 'checkout_500');
    assert.equal(run.status, 'failed'); assert.equal(run.steps[3]?.status, 'failed'); assert.equal(run.steps[3]?.httpStatus, 500); assert.equal(run.steps[4]?.status, 'skipped');
    assert.equal(run.paymentCount, 0); assert.equal(runtime.store.paymentCount(run.id), 0); assert.equal(run.orderId, null);
    const incident = await (await api(runtime, session, `/api/incidents/${run.incidentId}`)).json() as Incident;
    assert.equal(incident.status, 'open'); assert.equal(incident.diagnosis.recommendedAction, null); assert.equal(incident.diagnosis.source, 'rules'); assert.ok(incident.diagnosis.evidenceIds.length > 0);
    assert.ok(incident.evidence.some(e => e.message.includes('Ledger unchanged')));
    const recover = await api(runtime, session, `/api/incidents/${run.incidentId}/recover`, approval); assert.equal(recover.status, 409);
  });
});

test('HTTP 200 with no confirmed order creates evidence-backed incident; resume is idempotent', async () => {
  await withRuntime(async (runtime, session) => {
    const first = await runScenario(runtime, session, 'receipt_order_missing');
    assert.equal(first.status, 'failed'); assert.equal(first.steps[4]?.httpStatus, 200); assert.equal(first.steps[4]?.errorCategory, 'business_outcome_missing'); assert.equal(first.paymentCount, 1);
    const second = await runScenario(runtime, session, 'receipt_order_missing');
    const list = await (await api(runtime, session, '/api/incidents')).json() as IncidentList;
    assert.equal(list.groups.length, 1); assert.equal(list.groups[0]?.count, 2); assert.equal(list.incidents[0]?.relatedIncidentIds.length, 1);
    assert.equal(list.incidents[0]?.fingerprint, list.incidents[1]?.fingerprint); assert.notEqual(first.orderId, second.orderId);
    const recoveredResponse = await api(runtime, session, `/api/incidents/${first.incidentId}/recover`, approval); assert.equal(recoveredResponse.status, 200);
    const recovered = await recoveredResponse.json() as RecoveryResult;
    assert.equal(recovered.status, 'verified'); assert.equal(recovered.originalOrderId, first.orderId); assert.equal(recovered.paymentCountBefore, 1); assert.equal(recovered.paymentCountAfter, 1);
    assert.equal(recovered.verification.status, 'passed'); assert.ok(recovered.verification.assertions.find(a => a.code === 'NO_DUPLICATE_PAYMENT')?.passed);
    const repeated = await (await api(runtime, session, `/api/incidents/${first.incidentId}/recover`, approval)).json() as RecoveryResult;
    assert.equal(repeated.id, recovered.id); assert.equal(runtime.store.paymentCount(first.id), 1);
    const dbCount = runtime.store.db.prepare('SELECT COUNT(*) AS count FROM confirmations WHERE order_id=?').get(first.orderId!) as { count: number }; assert.equal(dbCount.count, 1);
    const original = await (await api(runtime, session, `/api/runs/${first.id}`)).json() as Run;
    assert.equal(original.status, 'failed'); assert.equal(original.orderId, first.orderId); // Original evidence remains unchanged.
    const incident = await (await api(runtime, session, `/api/incidents/${first.incidentId}`)).json() as Incident; assert.equal(incident.status, 'resolved');
    const metrics = await (await api(runtime, session, '/api/metrics')).json() as Metrics;
    assert.equal(metrics.failedRuns, 2); assert.equal(metrics.verifiedRecoveries, 1); assert.equal(metrics.openIncidents, 1); assert.equal(metrics.chart.length, 2);
  });
});

test('approval, action allowlist, fixed workflow, private sandbox, and session ownership are enforced', async () => {
  await withRuntime(async (runtime, session) => {
    assert.equal((await fetch(`${runtime.baseUrl}/api/metrics`)).status, 400);
    assert.equal((await fetch(`${runtime.baseUrl}/sandbox/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
    assert.equal((await api(runtime, session, '/api/runs', { workflowId: 'arbitrary-target', scenario: 'healthy' })).status, 400);
    assert.equal((await api(runtime, session, '/api/runs', { scenario: 'healthy', targetUrl: 'https://example.com' })).status, 400);
    assert.equal((await api(runtime, session, '/api/runs', { scenario: 'unknown' })).status, 400);
    assert.equal((await api(runtime, session, '/api/runs', { scenario: ['healthy'] })).status, 400);
    const run = await runScenario(runtime, session, 'receipt_order_missing');
    assert.equal((await api(runtime, session, `/api/incidents/${run.incidentId}/recover`, { action: 'resume_receipt_worker' })).status, 400);
    assert.equal((await api(runtime, session, `/api/incidents/${run.incidentId}/recover`, { action: 'execute_shell', approved: true })).status, 400);
    const otherSession = randomUUID();
    assert.equal((await api(runtime, otherSession, `/api/runs/${run.id}`)).status, 404);
    assert.equal((await api(runtime, otherSession, `/api/incidents/${run.incidentId}`)).status, 404);
    assert.equal((await api(runtime, otherSession, `/api/incidents/${run.incidentId}/recover`, approval)).status, 404);
    const otherMetrics = await (await api(runtime, otherSession, '/api/metrics')).json() as Metrics;
    assert.equal(otherMetrics.totalRuns, 0); assert.equal(otherMetrics.failedRuns, 0); assert.equal(otherMetrics.openIncidents, 3);
    const otherHistory = await runtime.store.listIncidents(otherSession);
    assert.equal(otherHistory.incidents.length, 3);
    assert.deepEqual(new Set(otherHistory.incidents.map(incident => incident.application?.path)),
      new Set(['/api/runs/:id', '/api/incidents/:id', '/api/incidents/:id/recover']));
    assert.ok(otherHistory.incidents.every(incident => incident.application?.source === 'api' && incident.application.httpStatus === 404
      && incident.application.code === 'NOT_FOUND' && incident.login === undefined && incident.recovery === null));
    const exposed = JSON.stringify({ history: otherHistory, runs: await runtime.store.listRuns(otherSession) });
    for (const privateId of [run.id, run.incidentId, run.orderId, run.transactionId]) if (privateId) assert.ok(!exposed.includes(privateId));
    assert.equal(await runtime.store.getRun(run.id, otherSession), null); assert.equal(await runtime.store.getIncident(run.incidentId!, otherSession), null);
    const unrelated = await runScenario(runtime, otherSession, 'healthy'); assert.equal(unrelated.status, 'passed'); assert.equal(runtime.store.getIncident(run.incidentId!, session)?.status, 'open');
    const denied = await api(runtime, session, '/api/metrics', undefined, { Origin: 'https://unapproved.example' }); assert.equal(denied.status, 403);
    const allowed = await api(runtime, session, '/api/metrics', undefined, { Origin: 'http://localhost:5173' }); assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), 'http://localhost:5173');
  });
});

test('failed recovery verification keeps incident open and safe approval can be retried', async () => {
  let injectFailure = true;
  await withRuntime(async (runtime, session) => {
    const run = await runScenario(runtime, session, 'receipt_order_missing');
    const first = await (await api(runtime, session, `/api/incidents/${run.incidentId}/recover`, approval)).json() as RecoveryResult;
    assert.equal(first.status, 'failed'); assert.equal(first.verification.status, 'failed'); assert.equal(first.paymentCountAfter, 1);
    const open = await (await api(runtime, session, `/api/incidents/${run.incidentId}`)).json() as Incident; assert.equal(open.status, 'open'); assert.equal(open.resolvedAt, null); assert.ok(open.evidence.length > run.steps[4]!.evidence.length);
    injectFailure = false;
    const retried = await (await api(runtime, session, `/api/incidents/${run.incidentId}/recover`, approval)).json() as RecoveryResult;
    assert.equal(retried.status, 'verified'); assert.equal(retried.paymentCountAfter, 1); assert.equal(retried.originalOrderId, first.originalOrderId);
  }, { recoveryVerificationFault: () => injectFailure });
});

test('one active run per session while another session can run independently', async () => {
  await withRuntime(async (runtime, session) => {
    const first = await api(runtime, session, '/api/runs', { scenario: 'healthy' }); assert.equal(first.status, 202);
    const firstResult = await first.json() as { runId: string }; assert.ok(firstResult.runId);
    const duplicate = await api(runtime, session, '/api/runs', { scenario: 'checkout_500' }); assert.equal(duplicate.status, 409);
    const duplicateResult = await duplicate.json() as { code: string; incidentId: string };
    assert.equal(duplicateResult.code, 'RUN_ACTIVE'); assert.ok(duplicateResult.incidentId);
    const duplicateIncident = await runtime.store.getIncident(duplicateResult.incidentId, session);
    assert.equal(duplicateIncident?.application?.source, 'api'); assert.equal(duplicateIncident?.application?.httpStatus, 409);
    assert.equal(duplicateIncident?.application?.path, '/api/runs'); assert.equal(duplicateIncident?.diagnosis.recommendedAction, null);
    const second = await runScenario(runtime, randomUUID(), 'checkout_500'); assert.equal(second.status, 'failed'); assert.equal(second.paymentCount, 0);
    await runtime.engine.drain();
    const completedFirst = await runtime.store.getRun(firstResult.runId, session);
    assert.equal(completedFirst?.scenario, 'healthy'); assert.equal(completedFirst?.status, 'passed');
    assert.equal((await runtime.store.getRun(duplicateIncident!.runId, session))?.scenario, 'application_error');
    assert.equal((await runtime.store.getRun(duplicateIncident!.runId, session))?.status, 'failed');
  }, { sandboxLatencyMs: 20 });
});

test('transient running-state persistence failure becomes terminal and releases the session without restart', async () => {
  const underlying = new Store(':memory:'); let saves = 0;
  const store: DataStore = new Proxy(underlying, {
    get(target, property) {
      if (property === 'saveRun') return async (session: string, run: Run) => {
        if (++saves === 2) throw new Error('Fixture transient running-state write failure');
        target.saveRun(session, run);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await withRuntime(async (runtime, session) => {
    const failed = await runScenario(runtime, session, 'healthy');
    assert.equal(failed.status, 'failed'); assert.ok(failed.completedAt); assert.equal(failed.paymentCount, 0);
    assert.equal(failed.steps[0]?.errorCategory, 'runner_error'); assert.ok(failed.steps[0]?.actual.includes('transient running-state write failure'));
    assert.ok(failed.steps[0]?.evidence.some(e => e.message.includes('transient running-state write failure')));
    assert.ok(failed.steps.slice(1).every(step => step.status === 'skipped'));
    assert.equal(underlying.getIncident(failed.incidentId!, session)?.status, 'open');
    assert.equal((await runScenario(runtime, session, 'healthy')).status, 'passed');
    const metrics = await (await api(runtime, session, '/api/metrics')).json() as Metrics;
    assert.equal(metrics.totalRuns, 2); assert.equal(metrics.failedRuns, 1); assert.equal(metrics.passedRuns, 1);
  }, { store });
});

test('request deadline creates timeout evidence without leaving the run active', async () => {
  await withRuntime(async (runtime, session) => {
    const run = await runScenario(runtime, session, 'healthy');
    assert.equal(run.status, 'failed'); assert.equal(run.steps[0]?.errorCategory, 'timeout'); assert.equal(run.steps[0]?.httpStatus, null); assert.equal(run.paymentCount, 0);
    assert.ok(run.steps.slice(1).every(s => s.status === 'skipped'));
    const incident = runtime.store.getIncident(run.incidentId!, session); assert.ok(incident?.diagnosis.summary.includes('deadline')); assert.equal(incident?.diagnosis.recommendedAction, null);
    assert.equal((await api(runtime, session, '/api/runs', { scenario: 'healthy' })).status, 202);
  }, { sandboxLatencyMs: 80, stepTimeoutMs: 10 });
});

test('bounded mutation and read rates return a useful retry response', async () => {
  await withRuntime(async (runtime, session) => {
    const run = await runScenario(runtime, session, 'healthy'); assert.equal(run.status, 'passed');
    const limited = await api(runtime, session, '/api/runs', { scenario: 'healthy' }); assert.equal(limited.status, 429); assert.equal(limited.headers.get('Retry-After'), '60'); assert.equal((await limited.json()).code, 'RATE_LIMITED');
  }, { rateLimits: { reads: 600, mutationsPerSession: 1, mutationsPerIp: 10 } });
  await withRuntime(async (runtime, session) => {
    assert.equal((await api(runtime, session, '/api/metrics')).status, 200);
    assert.equal((await api(runtime, session, '/api/metrics')).status, 429);
  }, { rateLimits: { reads: 1, mutationsPerSession: 10, mutationsPerIp: 10 } });
});

test('metrics aggregate all stored records while recent runs and chart remain bounded', async () => {
  await withRuntime(async (runtime, session) => {
    const original = await runScenario(runtime, session, 'healthy');
    for (let i = 0; i < 501; i++) runtime.store.saveRun(session, { ...original, id: randomUUID(), durationMs: 100 });
    const metrics = await (await api(runtime, session, '/api/metrics')).json() as Metrics;
    assert.equal(metrics.totalRuns, 502); assert.equal(metrics.passedRuns, 502); assert.equal(metrics.failedRuns, 0); assert.equal(metrics.successRate, 100);
    assert.equal(metrics.averageDurationMs, Math.round((50100 + original.durationMs) / 502)); assert.equal(metrics.recentRuns.length, 20); assert.equal(metrics.chart.length, 30);
  });
});

test('file-backed restart preserves original evidence and payments, reopens interrupted recovery', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'bizplus-test-')); const databasePath = join(folder, 'history.sqlite'); const session = randomUUID();
  let runtime = await startServer({ port: 0, databasePath, sandboxLatencyMs: 0 });
  try {
    const firstInstance = runtime.engine.health.instanceId;
    const run = await runScenario(runtime, session, 'receipt_order_missing');
    const incident = runtime.store.getIncident(run.incidentId!, session)!; incident.status = 'recovering'; runtime.store.saveIncident(session, incident);
    await runtime.close(); runtime = await startServer({ port: 0, databasePath, sandboxLatencyMs: 0 });
    assert.notEqual(runtime.engine.health.instanceId, firstInstance); assert.equal(runtime.engine.health.historyPolicy, 'local');
    assert.equal(runtime.store.getRun(run.id, session)?.steps[4]?.httpStatus, 200); assert.equal(runtime.store.paymentCount(run.id), 1); assert.equal(runtime.store.getIncident(run.incidentId!, session)?.status, 'open');
    const recovered = await (await api(runtime, session, `/api/incidents/${run.incidentId}/recover`, approval)).json() as RecoveryResult; assert.equal(recovered.status, 'verified'); assert.equal(recovered.paymentCountAfter, 1);
  } finally { await runtime.close(); await removeTestFolder(folder); }
});

test('interrupted workflow is terminal after restart, preserving a useful incident and allowing new runs', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'bizplus-interruption-')); const databasePath = join(folder, 'history.sqlite'); const session = randomUUID();
  let runtime = await startServer({ port: 0, databasePath, sandboxLatencyMs: 0 });
  try {
    const run = await runScenario(runtime, session, 'healthy');
    run.status = 'running'; run.completedAt = null; run.steps[4]!.status = 'running'; runtime.store.saveRun(session, run);
    await runtime.close(); runtime = await startServer({ port: 0, databasePath, sandboxLatencyMs: 0, historyPolicy: 'temporary' });
    const recoveredRun = runtime.store.getRun(run.id, session)!; assert.equal(recoveredRun.status, 'failed'); assert.equal(recoveredRun.steps[4]?.errorCategory, 'interrupted'); assert.ok(recoveredRun.incidentId);
    assert.equal(runtime.engine.health.historyPolicy, 'temporary'); assert.equal((await runScenario(runtime, session, 'healthy')).status, 'passed');
  } finally { await runtime.close(); await removeTestFolder(folder); }
});
