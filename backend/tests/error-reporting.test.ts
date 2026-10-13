import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { LiveRun } from '@bizplus/shared';
import { Store } from '../src/database/store.js';
import { createErrorReporter, applicationErrorCode, safeErrorPath } from '../src/incidents/reporting.js';
import { WorkflowError } from '../src/engine/workflow.js';

async function withReporter(operation: (store: Store, reporter: ReturnType<typeof createErrorReporter>, session: string) => Promise<void>) {
  const store = new Store(':memory:'); const reporter = createErrorReporter(store);
  try { await operation(store, reporter, randomUUID()); } finally { await reporter.drain(); store.close(); }
}
function liveRun(targetId: string, status: 'failed' | 'passed', startedAt: string): LiveRun {
  return { id: randomUUID(), targetId, url: 'https://example.com/health', status, httpStatus: status === 'passed' ? 200 : 503,
    durationMs: 10, startedAt, completedAt: startedAt, error: null, message: 'Controlled check', assertions: [{ code: 'HTTP_STATUS', expected: 'HTTP 200', actual: status === 'passed' ? 'HTTP 200' : 'HTTP 503', passed: status === 'passed' }], evidence: { responseBytes: 2 }, fingerprint: null };
}

test('application error creates a failed run and an Investigation incident with categorical evidence and no invented repair', async () => {
  await withReporter(async (store, reporter, session) => {
    const result = await reporter.report(session, { source: 'api', code: 'INTERNAL_ERROR', path: '/api/shop/orders', httpStatus: 500, eventId: randomUUID() });
    assert.equal(result.created, true); assert.equal(result.occurrenceCount, 1);
    const incident = await store.getIncident(result.incidentId, session);
    assert.ok(incident); assert.equal(incident.status, 'open'); assert.equal(incident.application?.source, 'api');
    assert.equal(incident.application?.code, 'INTERNAL_ERROR'); assert.equal(incident.application?.httpStatus, 500);
    assert.equal(incident.diagnosis.recommendedAction, null); assert.equal(incident.recovery, null); assert.equal(incident.manualRecovery, undefined);
    const run = await store.getRun(result.runId, session);
    assert.equal(run?.scenario, 'application_error'); assert.equal(run?.status, 'failed'); assert.equal(run?.steps[0]?.httpStatus, 500);
    assert.equal(run?.amountMinor, 0); assert.equal(run?.paymentCount, 0); assert.equal(run?.orderId, null);
    assert.ok(incident.evidence.some(item => item.data?.requestData === 'not captured'));
  });
});

test('concurrent repeats coalesce only the same source, safe route, code and status within one session', async () => {
  await withReporter(async (store, reporter, session) => {
    const input = { source: 'api', code: 'API_HTTP_ERROR', path: '/api/shop/orders/private-order-id/verify', httpStatus: 503 };
    const results = await Promise.all(Array.from({ length: 12 }, () => reporter.report(session, { ...input, eventId: randomUUID() })));
    assert.equal(new Set(results.map(item => item.incidentId)).size, 1); assert.equal(results.filter(item => item.created).length, 1);
    const incident = (await store.listIncidents(session)).incidents[0]!;
    assert.equal(incident.application?.occurrenceCount, 12); assert.equal(incident.application?.path, '/api/shop/orders/:id/verify');
    assert.equal((await store.listRuns(session)).length, 1);
    const differentStatus = await reporter.report(session, { ...input, httpStatus: 500 });
    const differentSource = await reporter.report(session, { ...input, source: 'payment' });
    const otherSession = await reporter.report(randomUUID(), input);
    for (const other of [differentStatus, differentSource, otherSession]) assert.notEqual(other.incidentId, incident.id);
  });
});

test('retried event IDs remain idempotent after a reporter restart and reject reuse for a different error', async () => {
  await withReporter(async (store, reporter, session) => {
    const input = { source: 'browser', code: 'BROWSER_RUNTIME_ERROR', path: '/login', eventId: randomUUID() };
    const first = await reporter.report(session, input);
    const retry = await reporter.report(session, input);
    assert.equal(retry.incidentId, first.incidentId); assert.equal(retry.occurrenceCount, 1); assert.equal(retry.created, false);
    const restarted = createErrorReporter(store); const afterRestart = await restarted.report(session, input);
    assert.equal(afterRestart.occurrenceCount, 1);
    await assert.rejects(() => reporter.report(session, { ...input, code: 'BROWSER_RENDER_ERROR' }), (error: unknown) => error instanceof WorkflowError && error.code === 'ERROR_EVENT_REUSED');
  });
});

test('evidence and recent event IDs stay bounded while the original history event remains idempotent', async () => {
  await withReporter(async (store, reporter, session) => {
    const input = { source: 'observer', code: 'OBSERVER_CHECK_FAILED', path: '/health', eventId: randomUUID() };
    const first = await reporter.report(session, input);
    for (let index = 0; index < 155; index++) await reporter.report(session, { ...input, eventId: randomUUID() });
    const incident = (await store.getIncident(first.incidentId, session))!;
    assert.equal(incident.application?.occurrenceCount, 156); assert.equal(incident.application?.recentEventIds.length, 128);
    assert.equal(incident.application?.recentEventIds[0], input.eventId); assert.equal(incident.evidence.length, 40);
    assert.equal((await reporter.report(session, input)).occurrenceCount, 156);
    assert.deepEqual(incident.diagnosis.evidenceIds, incident.evidence.map(item => item.id));
  });
});

test('query, hash, URL credentials, dynamic IDs and arbitrary messages cannot enter persisted reports', async () => {
  await withReporter(async (store, reporter, session) => {
    const secrets = ['private-user-713', 'private-password-293', 'private-signature-907', 'private-token-568'];
    const result = await reporter.report(session, { source: 'payment', code: 'PAYMENT_FAILED',
      path: `https://${secrets[0]}:${secrets[1]}@example.com/api/shop/orders/${secrets[2]}/verify?token=${secrets[3]}#password=${secrets[1]}` });
    const exposed = JSON.stringify({ incident: await store.getIncident(result.incidentId, session), run: await store.getRun(result.runId, session), logs: await store.logs(result.runId) });
    for (const secret of secrets) assert.ok(!exposed.includes(secret));
    const persisted = JSON.stringify({ runs: store.db.prepare('SELECT data FROM runs').all(), incidents: store.db.prepare('SELECT data FROM incidents').all() });
    for (const secret of secrets) assert.ok(!persisted.includes(secret));
    await assert.rejects(() => reporter.report(session, { source: 'browser', code: 'BROWSER_RUNTIME_ERROR', path: '/login', message: secrets[0], password: secrets[1] }), (error: unknown) => error instanceof WorkflowError && error.code === 'INVALID_ERROR_REPORT');
    assert.equal(safeErrorPath('/api/private-password-293?signature=private-signature-907'), '/api/:unrecognized');
    assert.equal(safeErrorPath('/test-site/private-session-321/api/login?password=private'), '/test-site/:session/api/login');
    assert.equal(applicationErrorCode('PRIVATE_PASSWORD_SECRET'), 'API_HTTP_ERROR');
  });
});

test('malformed metadata and unsupported codes are rejected without storing an incident', async () => {
  await withReporter(async (store, reporter, session) => {
    for (const input of [null, [], { source: 'ai', code: 'API_HTTP_ERROR' }, { source: 'api', code: 'password-private' },
      { source: 'api', httpStatus: 99 }, { source: 'api', httpStatus: 600 }, { source: 'api', httpStatus: '500' },
      { source: 'api', httpStatus: 401.5 }, { source: 'api', eventId: 'my password' },
      { source: 'api', observedAt: 'token' }, { source: 'observer', observerCheckKey: 'private-username' },
      { source: 'api', approved: true, action: 'resume_receipt_worker' }]) {
      await assert.rejects(() => reporter.report(session, input), (error: unknown) => error instanceof WorkflowError && error.code === 'INVALID_ERROR_REPORT');
    }
    await assert.rejects(() => reporter.report('missing-session', { source: 'api' }));
    assert.equal((await store.listIncidents(session)).incidents.length, 0); assert.equal((await store.listRuns(session)).length, 0);
  });
});

test('client-side form validation is visible as Input needs correction without saved input values', async () => {
  await withReporter(async (store, reporter, session) => {
    const reported = await reporter.report(session, { source: 'browser', code: 'BROWSER_VALIDATION_ERROR', path: '/login' });
    const incident = (await store.getIncident(reported.incidentId, session))!;
    assert.equal(incident.title, 'Input needs correction'); assert.equal(incident.application?.code, 'BROWSER_VALIDATION_ERROR');
    assert.equal(incident.diagnosis.recommendedAction, null); assert.equal(incident.manualRecovery, undefined);
    assert.ok(incident.diagnosis.guidance.includes('human')); assert.equal(incident.application?.httpStatus, null);
  });
});

test('failed browser resources are recorded by category and current page without asset URLs', async () => {
  await withReporter(async (store, reporter, session) => {
    const reported = await reporter.report(session, { source: 'browser', code: 'BROWSER_RESOURCE_ERROR', path: '/shop' });
    const incident = (await store.getIncident(reported.incidentId, session))!;
    assert.equal(incident.application?.code, 'BROWSER_RESOURCE_ERROR'); assert.equal(incident.application?.path, '/shop');
    assert.equal(incident.application?.httpStatus, null); assert.equal(incident.diagnosis.recommendedAction, null);
    assert.ok(!JSON.stringify(incident).includes('assetUrl')); assert.ok(incident.evidence.every(item => !item.data || !('url' in item.data)));
  });
});

test('foreign incidents and live runs cannot be attached through reporting metadata', async () => {
  await withReporter(async (store, reporter, session) => {
    const otherSession = randomUUID(); const input = { source: 'api', code: 'API_HTTP_ERROR', path: '/health' };
    const foreign = await reporter.report(otherSession, input);
    await assert.rejects(() => reporter.report(session, { ...input, existingIncidentId: foreign.incidentId }), (error: unknown) => error instanceof WorkflowError && error.status === 404);
    const foreignLive = liveRun('target-a', 'failed', '2026-10-13T10:00:00.000Z'); store.saveLiveRun(otherSession, foreignLive);
    await assert.rejects(() => reporter.report(session, { source: 'live', code: 'LIVE_CHECK_FAILED', path: '/health', liveRunId: foreignLive.id }), (error: unknown) => error instanceof WorkflowError && error.status === 404);
    assert.equal((await store.listIncidents(session)).incidents.length, 0);
    assert.equal(await reporter.resolve(session, foreign.incidentId, { source: 'observer', observerCheckId: randomUUID() }), false);
  });
});

test('only a fresh owned passing check for the same target can resolve a live incident', async () => {
  await withReporter(async (store, reporter, session) => {
    const original = liveRun('target-a', 'failed', '2026-10-13T10:00:00.000Z'); store.saveLiveRun(session, original);
    const reported = await reporter.report(session, { source: 'live', code: 'LIVE_CHECK_FAILED', path: '/health', liveRunId: original.id, eventId: original.id });
    const wrongTarget = liveRun('target-b', 'passed', '2026-10-13T11:00:00.000Z'); store.saveLiveRun(session, wrongTarget);
    assert.equal(await reporter.resolve(session, reported.incidentId, { source: 'live', verificationRunId: wrongTarget.id }), false);
    const stale = liveRun('target-a', 'passed', '2026-10-13T09:00:00.000Z'); store.saveLiveRun(session, stale);
    assert.equal(await reporter.resolve(session, reported.incidentId, { source: 'live', verificationRunId: stale.id }), false);
    const failed = liveRun('target-a', 'failed', '2026-10-13T11:00:00.000Z'); store.saveLiveRun(session, failed);
    assert.equal(await reporter.resolve(session, reported.incidentId, { source: 'live', verificationRunId: failed.id }), false);
    const passing = liveRun('target-a', 'passed', '2026-10-13T11:00:00.000Z'); store.saveLiveRun(session, passing);
    assert.equal(await reporter.resolve(session, reported.incidentId, { source: 'live', verificationRunId: passing.id }), true);
    const resolved = (await store.getIncident(reported.incidentId, session))!;
    assert.equal(resolved.status, 'resolved'); assert.equal(resolved.application?.verification?.verificationRunId, passing.id);
    assert.equal(resolved.recovery, null); assert.equal(resolved.diagnosis.recommendedAction, null);
    const newFailure = await reporter.report(session, { source: 'live', code: 'LIVE_CHECK_FAILED', path: '/health', liveRunId: original.id });
    assert.equal(newFailure.created, true); assert.notEqual(newFailure.incidentId, reported.incidentId);
  });
});

test('different configured live targets that share a route remain separate Investigation incidents', async () => {
  await withReporter(async (store, reporter, session) => {
    const targetA = liveRun('target-a', 'failed', '2026-10-13T10:00:00.000Z');
    const targetB = liveRun('target-b', 'failed', '2026-10-13T10:00:00.000Z');
    store.saveLiveRun(session, targetA); store.saveLiveRun(session, targetB);
    const common = { source: 'live', code: 'LIVE_CHECK_FAILED', path: '/health', httpStatus: 503 };
    const reportA = await reporter.report(session, { ...common, liveRunId: targetA.id });
    const reportB = await reporter.report(session, { ...common, liveRunId: targetB.id });
    assert.notEqual(reportA.incidentId, reportB.incidentId);
    assert.equal((await store.listIncidents(session)).incidents.length, 2);
  });
});

test('observer authentication errors retain manual login requirement and cannot resolve through general checks', async () => {
  await withReporter(async (store, reporter, session) => {
    const reported = await reporter.report(session, { source: 'observer', code: 'OBSERVER_AUTHENTICATION_FAILED', path: '/api/live/observer/synthetic-workflow',
      observerCheckKey: 'synthetic_workflow', observerCheckId: randomUUID(), requiresManualLogin: true, observedAt: '2026-10-13T10:00:00.000Z' });
    const incident = (await store.getIncident(reported.incidentId, session))!;
    assert.equal(incident.application?.requiresManualLogin, true); assert.equal(incident.application?.firstSeenAt, '2026-10-13T10:00:00.000Z');
    assert.equal(await reporter.resolve(session, reported.incidentId, { source: 'observer', observerCheckId: randomUUID() }), false);
    assert.equal((await store.getIncident(reported.incidentId, session))?.status, 'open');
  });
});

test('observer history remains idempotent after recent check IDs churn out of the bounded event window', async () => {
  await withReporter(async (store, reporter, session) => {
    const input = { source: 'observer', code: 'OBSERVER_CHECK_FAILED', path: '/health' };
    const initial = await reporter.report(session, { ...input, eventId: randomUUID() });
    const historical = { ...input, eventId: randomUUID(), observerIncidentId: randomUUID() };
    await reporter.report(session, historical);
    for (let index = 0; index < 140; index++) await reporter.report(session, { ...input, eventId: randomUUID() });
    const before = (await store.getIncident(initial.incidentId, session))!;
    assert.ok(!before.application?.recentEventIds.includes(historical.eventId));
    assert.deepEqual(before.application?.observerIncidentIds, [historical.observerIncidentId]);
    const retry = await reporter.report(session, historical);
    assert.equal(retry.incidentId, initial.incidentId); assert.equal(retry.occurrenceCount, before.application!.occurrenceCount);
    assert.equal(await reporter.resolve(session, initial.incidentId, { source: 'observer', observerCheckId: randomUUID() }), true);
    const afterResolution = await reporter.report(session, { ...historical, eventId: randomUUID() });
    assert.equal(afterResolution.incidentId, initial.incidentId); assert.equal(afterResolution.created, false);
    assert.equal((await store.listIncidents(session)).incidents.length, 1);
  });
});

test('observer infrastructure errors distinguish monitor failure from measured website failure', async () => {
  await withReporter(async (store, reporter, session) => {
    for (const code of ['OBSERVER_UNAVAILABLE', 'OBSERVER_MONITOR_ERROR']) {
      const reported = await reporter.report(session, { source: 'observer', code, path: '/api/live/observer' });
      const incident = (await store.getIncident(reported.incidentId, session))!;
      assert.ok(incident.title.includes('observer')); assert.ok(incident.diagnosis.summary.includes('not established'));
      assert.equal(incident.diagnosis.recommendedAction, null);
    }
  });
});

test('a mutable observer history category does not re-import an old occurrence or block fresh measured checks', async () => {
  await withReporter(async (store, reporter, session) => {
    const history = { source: 'observer', code: 'OBSERVER_MONITOR_ERROR', path: '/shop', observerCheckKey: 'storefront',
      eventId: randomUUID(), observerIncidentId: randomUUID() };
    const initial = await reporter.report(session, history);
    const changedHistory = await reporter.report(session, { ...history, code: 'OBSERVER_CHECK_FAILED' });
    assert.equal(changedHistory.incidentId, initial.incidentId); assert.equal(changedHistory.occurrenceCount, 1);
    const newCheck = await reporter.report(session, { source: 'observer', code: 'OBSERVER_CHECK_FAILED', path: '/shop', observerCheckKey: 'storefront', eventId: randomUUID() });
    assert.notEqual(newCheck.incidentId, initial.incidentId); assert.equal(newCheck.created, true);
    assert.equal((await store.listIncidents(session)).incidents.length, 2);
  });
});

test('storage failure rejects reporting, and retry can later record a real incident', async () => {
  await withReporter(async (store, reporter, session) => {
    const saveIncident = store.saveIncident.bind(store); let unavailable = true;
    store.saveIncident = (targetSession, incident) => { if (unavailable) throw new Error('Private database credential unavailable'); saveIncident(targetSession, incident); };
    const input = { source: 'api', code: 'INTERNAL_ERROR', path: '/api/shop/orders', eventId: randomUUID() };
    await assert.rejects(() => reporter.report(session, input));
    assert.equal((await store.listIncidents(session)).incidents.length, 0);
    unavailable = false;
    const success = await reporter.report(session, input); assert.ok(success.incidentId); assert.equal(success.created, true);
    assert.equal((await store.listIncidents(session)).incidents.length, 1);
  });
});
