import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ErrorReportResult, Incident, IncidentList, LoginResult } from '@bizplus/shared';
import { startServer, type AppOptions } from '../src/app.js';
import { Store } from '../src/database/store.js';

type Runtime = Awaited<ReturnType<typeof startServer>>;
const valid = { username: 'owner', password: 'BizPlus@123' };
async function withRuntime(operation: (runtime: Runtime, session: string) => Promise<void>, options: AppOptions = {}) {
  const runtime = await startServer({ port: 0, databasePath: ':memory:', sandboxLatencyMs: 0, observer: { url: '' },
    rateLimits: { reads: 600, mutationsPerSession: 100, mutationsPerIp: 600 }, ...options });
  try { await operation(runtime, randomUUID()); } finally { await runtime.close(); }
}
async function api(runtime: Runtime, session: string, path: string, body?: unknown) {
  return fetch(`${runtime.baseUrl}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: {
    'X-Demo-Session': session, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function incidents(runtime: Runtime, session: string): Promise<IncidentList> {
  const response = await api(runtime, session, '/api/incidents'); assert.equal(response.status, 200);
  return response.json() as Promise<IncidentList>;
}

test('HTTP errors link to sanitized Investigation evidence and preserve session isolation', async () => {
  await withRuntime(async (runtime, session) => {
    const privateId = 'private-route-secret-391'; const privateQuery = 'private-password-638';
    const response = await api(runtime, session, `/api/runs/${privateId}?password=${privateQuery}`);
    const body = await response.json() as { code: string; incidentId: string };
    assert.equal(response.status, 404); assert.equal(body.code, 'NOT_FOUND'); assert.ok(body.incidentId);
    const incidentResponse = await api(runtime, session, `/api/incidents/${body.incidentId}`);
    assert.equal(incidentResponse.status, 200); const incident = await incidentResponse.json() as Incident;
    assert.equal(incident.application?.source, 'api'); assert.equal(incident.application?.httpStatus, 404);
    assert.equal(incident.application?.path, '/api/runs/:id'); assert.equal(incident.diagnosis.recommendedAction, null);
    const recorded = JSON.stringify({ incident, run: await runtime.store.getRun(incident.runId, session) });
    assert.ok(!recorded.includes(privateId)); assert.ok(!recorded.includes(privateQuery));
    assert.equal(await runtime.store.getIncident(body.incidentId, randomUUID()), null);
  });
});

test('generic backend failures create an incident without storing exception secrets', async () => {
  await withRuntime(async (runtime, session) => {
    const secret = 'private-database-connection-password-593';
    const original = runtime.store.metricsAggregates.bind(runtime.store);
    runtime.store.metricsAggregates = () => { throw new Error(secret); };
    let response: Response;
    try { response = await api(runtime, session, '/api/metrics'); }
    finally { runtime.store.metricsAggregates = original; }
    assert.equal(response.status, 500); const result = await response.json() as { code: string; incidentId: string };
    assert.equal(result.code, 'INTERNAL_ERROR'); assert.ok(result.incidentId);
    const incident = (await runtime.store.getIncident(result.incidentId, session))!;
    assert.equal(incident.application?.code, 'INTERNAL_ERROR'); assert.equal(incident.application?.httpStatus, 500);
    assert.ok(!JSON.stringify({ result, incident }).includes(secret));
  });
});

test('manual login rejection keeps its original incident and human recovery without a duplicate API incident', async () => {
  await withRuntime(async (runtime, session) => {
    const privatePassword = 'private-invalid-password-941';
    const response = await api(runtime, session, '/api/login', { username: 'private-user-628', password: privatePassword });
    assert.equal(response.status, 401); const result = await response.json() as LoginResult;
    assert.ok(result.incidentId); assert.equal(result.code, 'LOGIN_REJECTED');
    const list = await incidents(runtime, session); assert.equal(list.incidents.length, 1);
    assert.equal(list.incidents[0]?.id, result.incidentId); assert.equal(list.incidents[0]?.workflowId, 'manual-login');
    assert.equal(list.incidents[0]?.application, undefined); assert.equal(list.incidents[0]?.login?.manualOnly, true);
    assert.ok(!JSON.stringify(list).includes(privatePassword));
    const recovery = await api(runtime, session, '/api/login', { ...valid, incidentId: result.incidentId });
    assert.equal(recovery.status, 200); const recovered = await recovery.json() as LoginResult;
    assert.equal(recovered.recovery?.actor, 'human'); assert.equal(recovered.recovery?.status, 'verified');
    const after = await incidents(runtime, session); assert.equal(after.incidents.length, 1); assert.equal(after.incidents[0]?.status, 'resolved');
  });
});

test('error reporting endpoint persists safe metadata, idempotent UUID retries and no recovery control', async () => {
  await withRuntime(async (runtime, session) => {
    const event = { source: 'browser', code: 'BROWSER_RUNTIME_ERROR', path: '/login?username=private-user-529#password=private-password-796', eventId: randomUUID() };
    const first = await api(runtime, session, '/api/errors', event);
    assert.equal(first.status, 201); assert.equal(first.headers.get('Cache-Control'), 'no-store'); const firstResult = await first.json() as ErrorReportResult;
    const retry = await api(runtime, session, '/api/errors', event); assert.equal(retry.status, 200);
    const retryResult = await retry.json() as ErrorReportResult;
    assert.equal(retryResult.incidentId, firstResult.incidentId); assert.equal(retryResult.occurrenceCount, 1);
    const list = await incidents(runtime, session); assert.equal(list.incidents.length, 1);
    assert.equal(list.incidents[0]?.application?.path, '/login'); assert.equal(list.incidents[0]?.diagnosis.recommendedAction, null);
    assert.ok(!JSON.stringify(list).includes('private-user-529')); assert.ok(!JSON.stringify(list).includes('private-password-796'));
    const wrongRecovery = await api(runtime, session, `/api/incidents/${firstResult.incidentId}/recover`, { approved: true, action: 'resume_receipt_worker' });
    assert.equal(wrongRecovery.status, 409); const wrongResult = await wrongRecovery.json() as { code: string };
    assert.equal(wrongResult.code, 'RECOVERY_UNSUPPORTED');
    assert.equal((await runtime.store.getIncident(firstResult.incidentId, session))?.status, 'open');
  });
});

test('invalid or malformed reporting requests fail without recursively creating error reports', async () => {
  await withRuntime(async (runtime, session) => {
    for (const payload of [null, [], { source: 'browser', code: 'unknown-private-secret' },
      { source: 'browser', code: 'BROWSER_RUNTIME_ERROR', username: 'private', password: 'private' },
      { source: 'browser', code: 'BROWSER_RUNTIME_ERROR', action: 'reset_login', approved: true }]) {
      const response = await api(runtime, session, '/api/errors', payload);
      assert.equal(response.status, 400); assert.equal((await response.json()).incidentId, undefined);
    }
    const malformed = await fetch(`${runtime.baseUrl}/api/errors`, { method: 'POST', headers: { 'X-Demo-Session': session, 'Content-Type': 'application/json' }, body: '{private-secret' });
    assert.equal(malformed.status, 400); assert.equal((await malformed.json()).incidentId, undefined);
    assert.equal((await incidents(runtime, session)).incidents.length, 0);
    assert.equal((await runtime.store.listRuns(session)).length, 0);
  });
});

test('case and trailing-slash reporting aliases preserve recursion prevention and the independent reporting budget', async () => {
  await withRuntime(async (runtime, session) => {
    for (const path of ['/api/errors/', '/api/ERRORS', '/API/ERRORS/']) {
      const response = await api(runtime, session, path, { source: 'browser', code: 'unsupported-private-value' });
      assert.equal(response.status, 400); assert.equal((await response.json()).incidentId, undefined);
      const malformed = await fetch(`${runtime.baseUrl}${path}`, { method: 'POST', headers: { 'X-Demo-Session': session, 'Content-Type': 'application/json' }, body: '{private-invalid-value' });
      assert.equal(malformed.status, 400); assert.equal((await malformed.json()).incidentId, undefined);
    }
    assert.equal((await runtime.store.listIncidents(session)).incidents.length, 0);
    assert.equal((await runtime.store.listRuns(session)).length, 0);
    assert.equal((await api(runtime, session, '/api/login', valid)).status, 200);
  }, { rateLimits: { reads: 600, mutationsPerSession: 1, mutationsPerIp: 1 } });
});

test('malformed JSON with a valid session produces an incident without storing the invalid body', async () => {
  await withRuntime(async (runtime, session) => {
    const secret = 'private-malformed-password-927';
    const response = await fetch(`${runtime.baseUrl}/api/login?token=private-token-578`, { method: 'POST',
      headers: { 'X-Demo-Session': session, 'Content-Type': 'application/json' }, body: `{"password":"${secret}"` });
    assert.equal(response.status, 400); const result = await response.json() as { code: string; incidentId: string };
    assert.equal(result.code, 'INVALID_JSON'); assert.ok(result.incidentId);
    const incident = (await runtime.store.getIncident(result.incidentId, session))!;
    assert.equal(incident.application?.path, '/api/login'); assert.equal(incident.application?.code, 'INVALID_JSON');
    const recorded = JSON.stringify({ result, incident, run: await runtime.store.getRun(incident.runId, session) });
    assert.ok(!recorded.includes(secret)); assert.ok(!recorded.includes('private-token-578'));
  });
});

test('reporting uses a separate budget and normal API rate rejection appears in Investigation', async () => {
  await withRuntime(async (runtime, session) => {
    const event = { source: 'browser', code: 'BROWSER_RUNTIME_ERROR', path: '/login', eventId: randomUUID() };
    for (let index = 0; index < 20; index++) assert.ok((await api(runtime, session, '/api/errors', event)).ok);
    assert.equal((await api(runtime, session, '/api/login', valid)).status, 200);
    assert.equal((await api(runtime, session, '/api/login', valid)).status, 200);
    const limited = await api(runtime, session, '/api/login', valid); assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('Retry-After'), '60'); const result = await limited.json() as { code: string; incidentId: string };
    assert.equal(result.code, 'RATE_LIMITED'); assert.ok(result.incidentId);
    const rateIncident = (await runtime.store.getIncident(result.incidentId, session))!;
    assert.equal(rateIncident.application?.code, 'RATE_LIMITED'); assert.equal(rateIncident.application?.path, '/api/login');
    assert.equal(rateIncident.application?.httpStatus, 429);
  }, { rateLimits: { reads: 600, mutationsPerSession: 2, mutationsPerIp: 100 } });
});

test('report budget exhaustion returns a plain rate error and cannot recursively report itself', async () => {
  await withRuntime(async (runtime, session) => {
    const event = { source: 'browser', code: 'BROWSER_RUNTIME_ERROR', path: '/login', eventId: randomUUID() };
    for (let index = 0; index < 60; index++) assert.ok((await api(runtime, session, '/api/errors', event)).ok);
    const limited = await api(runtime, session, '/api/errors', event); assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('Retry-After'), '60'); assert.equal((await limited.json()).incidentId, undefined);
    const list = await incidents(runtime, session); assert.equal(list.incidents.length, 1);
    assert.equal(list.incidents[0]?.application?.occurrenceCount, 1);
    assert.equal((await api(runtime, session, '/api/login', valid)).status, 200);
  }, { rateLimits: { reads: 600, mutationsPerSession: 1, mutationsPerIp: 100 } });
});

test('unavailable incident storage preserves the HTTP failure response without a fabricated incident ID', async () => {
  await withRuntime(async (runtime, session) => {
    const store = runtime.store as Store; const saveIncident = store.saveIncident.bind(store);
    store.saveIncident = () => { throw new Error('Private storage password unavailable'); };
    let response: Response;
    try { response = await api(runtime, session, `/api/runs/${randomUUID()}`); }
    finally { store.saveIncident = saveIncident; }
    assert.equal(response.status, 404); const result = await response.json() as { code: string; incidentId?: string };
    assert.equal(result.code, 'NOT_FOUND'); assert.equal(result.incidentId, undefined);
    assert.equal((await runtime.store.listIncidents(session)).incidents.length, 0);
    assert.ok(!JSON.stringify(result).includes('Private storage password'));
  });
});

test('rapid identical HTTP failures share one recorded occurrence and leave independent reporting and mutation budgets available', async () => {
  await withRuntime(async (runtime, session) => {
    const store = runtime.store as Store; const saveIncident = store.saveIncident.bind(store); let incidentWrites = 0;
    store.saveIncident = (targetSession, incident) => { incidentWrites += 1; saveIncident(targetSession, incident); };
    const responses = await Promise.all(Array.from({ length: 80 }, () => api(runtime, session, `/api/runs/${randomUUID()}?token=private-token-218`)));
    assert.ok(responses.every(response => response.status === 404));
    const results = await Promise.all(responses.map(response => response.json() as Promise<{ incidentId: string }>));
    assert.equal(new Set(results.map(result => result.incidentId)).size, 1); assert.ok(results[0]?.incidentId);
    assert.equal(incidentWrites, 1);
    const incident = (await runtime.store.getIncident(results[0]!.incidentId, session))!;
    assert.equal(incident.application?.occurrenceCount, 1); assert.equal(incident.application?.path, '/api/runs/:id');
    assert.ok(!JSON.stringify(incident).includes('private-token-218'));
    const report = await api(runtime, session, '/api/errors', { source: 'browser', code: 'BROWSER_RESOURCE_ERROR', path: '/shop', eventId: randomUUID() });
    assert.equal(report.status, 201); assert.notEqual((await report.json()).incidentId, incident.id);
    assert.equal((await api(runtime, session, '/api/login', valid)).status, 200);
    const distinctError = await api(runtime, session, '/api/login', { username: valid.username });
    assert.equal(distinctError.status, 400); const distinctResult = await distinctError.json() as { incidentId: string };
    assert.ok(distinctResult.incidentId); assert.notEqual(distinctResult.incidentId, incident.id);
    assert.equal((await runtime.store.getIncident(distinctResult.incidentId, session))?.application?.path, '/api/login');
  }, { rateLimits: { reads: 200, mutationsPerSession: 2, mutationsPerIp: 10 } });
});

test('traffic after the read limit is exhausted records one rate incident without repeated database writes', async () => {
  await withRuntime(async (runtime, session) => {
    const store = runtime.store as Store; const saveIncident = store.saveIncident.bind(store); let incidentWrites = 0;
    store.saveIncident = (targetSession, incident) => { incidentWrites += 1; saveIncident(targetSession, incident); };
    const responses = await Promise.all(Array.from({ length: 80 }, () => api(runtime, session, `/api/runs/${randomUUID()}`)));
    const statuses = responses.map(response => response.status);
    assert.equal(statuses.filter(status => status === 404).length, 1); assert.equal(statuses.filter(status => status === 429).length, 79);
    const rateResults = await Promise.all(responses.filter(response => response.status === 429).map(response => response.json() as Promise<{ code: string; incidentId: string }>));
    assert.ok(rateResults.every(result => result.code === 'RATE_LIMITED' && typeof result.incidentId === 'string'));
    assert.equal(new Set(rateResults.map(result => result.incidentId)).size, 1); assert.equal(incidentWrites, 2);
    const incident = (await runtime.store.getIncident(rateResults[0]!.incidentId, session))!;
    assert.equal(incident.application?.occurrenceCount, 1); assert.equal(incident.application?.httpStatus, 429);
    assert.equal(incident.application?.path, '/api/runs/:id');
    const report = await api(runtime, session, '/api/errors', { source: 'browser', code: 'BROWSER_RUNTIME_ERROR', path: '/login', eventId: randomUUID() });
    assert.equal(report.status, 201);
  }, { rateLimits: { reads: 1, mutationsPerSession: 2, mutationsPerIp: 10 } });
});
