import { createHash, randomUUID } from 'node:crypto';
import {
  APPLICATION_ERROR_CODES, APPLICATION_ERROR_SOURCES, OBSERVER_CHECK_KEYS,
  type ApplicationErrorCode, type ApplicationErrorSource, type ErrorReport,
  type ErrorReportResult, type Evidence, type Incident, type Run, type StepResult,
} from '@bizplus/shared';
import type { DataStore } from '../database/types.js';
import { WorkflowError } from '../engine/workflow.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKFLOW = 'application-errors';
const MAX_EVIDENCE = 40;
const MAX_EVENT_IDS = 128;
const descriptions: Record<ApplicationErrorSource, { title: string; summary: string; guidance: string }> = {
  api: { title: 'Application request failed', summary: 'An application request could not complete successfully.', guidance: 'Inspect the request category and HTTP status. Correct the input or repair the affected service, then repeat the same action yourself. This incident has no automatic repair.' },
  browser: { title: 'Browser error detected', summary: 'The browser reported an application runtime or communication error.', guidance: 'Check the affected page and application code, restore the connection if needed, then repeat the affected action in the browser. This incident has no automatic repair.' },
  payment: { title: 'Checkout error detected', summary: 'The controlled checkout reported a payment or checkout error.', guidance: 'Inspect the Test Mode provider and the original order before retrying. A reported payment error does not prove that funds were charged. Payment details and signatures were not recorded here. This incident has no automatic repair.' },
  live: { title: 'Live website check failed', summary: 'A live website check failed a configured expectation.', guidance: 'Open the linked live test to inspect its measured checks. For an isolated lab fault, use its approved restore and verification flow. For an owned site, repair the site yourself and run fresh verification. Login requires credentials entered by the human.' },
  observer: { title: 'Independent observer check failed', summary: 'The independent observer reported a failed website or browser check.', guidance: 'Open the independent observer to inspect the matching check. Repair the affected site or dependency and let the same check run again. The observer cannot submit or recover login credentials.' },
};

/** Map an arbitrary server code to a fixed vocabulary without persisting its raw value. */
export function applicationErrorCode(value: unknown): ApplicationErrorCode {
  return typeof value === 'string' && APPLICATION_ERROR_CODES.includes(value as ApplicationErrorCode)
    ? value as ApplicationErrorCode : 'API_HTTP_ERROR';
}

/**
 * Route templates retain useful location evidence without retaining URL queries, hash
 * fragments, credentials, user IDs, provider order IDs, or arbitrary path segments.
 */
export function safeErrorPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) return '/:unrecognized';
  let path: string;
  try {
    const candidate = new URL(value, 'https://bizplus.invalid');
    path = candidate.pathname.replace(/\/+$/, '') || '/';
  } catch { return '/:unrecognized'; }
  if (['/', '/login', '/shop', '/live-tests', '/workflows', '/incidents', '/recovery', '/investigation', '/dashboard', '/health', '/ready'].includes(path)) return path;
  if (/^\/(incidents|recovery)\/[^/]+$/.test(path)) return path.replace(/\/[^/]+$/, '/:id');
  if (/^\/api\/(workflows|runs|incidents|metrics|login|errors)$/.test(path)) return path;
  if (/^\/api\/login\/config$/.test(path)) return path;
  if (/^\/api\/shop\/(config|products|orders|webhook)$/.test(path)) return path;
  if (/^\/api\/live\/(targets|lab|runs|observer)$/.test(path)) return path;
  if (/^\/api\/live\/observer\/(storefront-browser|synthetic-workflow)$/.test(path)) return path;
  if (/^\/api\/(runs|incidents)\/[^/]+$/.test(path)) return path.replace(/\/[^/]+$/, '/:id');
  if (/^\/api\/incidents\/[^/]+\/recover$/.test(path)) return '/api/incidents/:id/recover';
  if (/^\/api\/shop\/orders\/[^/]+(?:\/verify)?$/.test(path)) return path.endsWith('/verify') ? '/api/shop/orders/:id/verify' : '/api/shop/orders/:id';
  if (/^\/api\/live\/runs\/[^/]+(?:\/(recover|verify))?$/.test(path)) return path.endsWith('/recover') ? '/api/live/runs/:id/recover' : path.endsWith('/verify') ? '/api/live/runs/:id/verify' : '/api/live/runs/:id';
  if (/^\/test-site\/[^/]+(?:\/api\/(login|catalog|confirmation))?$/.test(path)) return path.replace(/^\/test-site\/[^/]+/, '/test-site/:session');
  return path.startsWith('/api/') ? '/api/:unrecognized' : '/:unrecognized';
}

function invalid(): never { throw new WorkflowError(400, 'INVALID_ERROR_REPORT', 'Provide only a supported error category and safe location metadata.'); }
function parse(input: unknown): Required<Pick<ErrorReport, 'source' | 'code' | 'path' | 'eventId'>> & Omit<ErrorReport, 'source' | 'code' | 'kind' | 'path' | 'eventId'> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['source', 'code', 'kind', 'path', 'httpStatus', 'eventId', 'liveRunId', 'observerCheckId', 'observerIncidentId', 'observerCheckKey', 'observedAt', 'requiresManualLogin', 'existingIncidentId'].includes(key))) return invalid();
  if (typeof value.source !== 'string' || !APPLICATION_ERROR_SOURCES.includes(value.source as ApplicationErrorSource)) return invalid();
  const code = value.code ?? value.kind ?? 'API_HTTP_ERROR';
  if (typeof code !== 'string' || !APPLICATION_ERROR_CODES.includes(code as ApplicationErrorCode) || (value.code !== undefined && value.kind !== undefined && value.code !== value.kind)) return invalid();
  if (value.path !== undefined && (typeof value.path !== 'string' || value.path.length > 4096)) return invalid();
  // Browser/runtime failures may have HTTP 200 or no HTTP response; success statuses
  // describe context but cannot be misrepresented as an HTTP rejection.
  if (value.httpStatus !== undefined && (!Number.isInteger(value.httpStatus) || Number(value.httpStatus) < 100 || Number(value.httpStatus) > 599)) return invalid();
  for (const key of ['eventId', 'liveRunId', 'observerCheckId', 'observerIncidentId', 'existingIncidentId']) if (value[key] !== undefined && (typeof value[key] !== 'string' || !UUID.test(value[key]))) return invalid();
  if (value.observerCheckKey !== undefined && (typeof value.observerCheckKey !== 'string' || !OBSERVER_CHECK_KEYS.includes(value.observerCheckKey as typeof OBSERVER_CHECK_KEYS[number]))) return invalid();
  if (value.observedAt !== undefined && (typeof value.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt)))) return invalid();
  if (value.requiresManualLogin !== undefined && typeof value.requiresManualLogin !== 'boolean') return invalid();
  return { source: value.source as ApplicationErrorSource, code: code as ApplicationErrorCode, path: safeErrorPath(value.path),
    eventId: typeof value.eventId === 'string' ? value.eventId.toLowerCase() : randomUUID(),
    ...(value.httpStatus === undefined ? {} : { httpStatus: Number(value.httpStatus) }),
    ...(typeof value.liveRunId === 'string' ? { liveRunId: value.liveRunId.toLowerCase() } : {}),
    ...(typeof value.observerCheckId === 'string' ? { observerCheckId: value.observerCheckId.toLowerCase() } : {}),
    ...(typeof value.observerIncidentId === 'string' ? { observerIncidentId: value.observerIncidentId.toLowerCase() } : {}),
    ...(typeof value.observerCheckKey === 'string' ? { observerCheckKey: value.observerCheckKey as typeof OBSERVER_CHECK_KEYS[number] } : {}),
    ...(typeof value.observedAt === 'string' ? { observedAt: value.observedAt } : {}),
    ...(value.requiresManualLogin === true ? { requiresManualLogin: true } : {}),
    ...(typeof value.existingIncidentId === 'string' ? { existingIncidentId: value.existingIncidentId.toLowerCase() } : {}),
  };
}
function event(timestamp: string, message: string, data: Record<string, unknown>, kind: Evidence['kind'] = 'response'): Evidence {
  return { id: randomUUID(), kind, timestamp, message, data };
}
function boundedEvidence(incident: Incident, addition: Evidence[]) {
  const all = [...incident.evidence, ...addition];
  incident.evidence = all.length <= MAX_EVIDENCE ? all : [...all.slice(0, 2), ...all.slice(-(MAX_EVIDENCE - 2))];
  incident.diagnosis.evidenceIds = incident.evidence.map(item => item.id);
}

export interface ErrorVerification { source: 'live' | 'observer'; verificationRunId?: string; observerCheckId?: string }
export interface ErrorReporter {
  report(session: string, input: unknown): Promise<ErrorReportResult>;
  /** Internal verified monitor bridge only; intentionally has no public resolution endpoint. */
  resolve(session: string, incidentId: string, verification: ErrorVerification): Promise<boolean>;
  drain(): Promise<void>;
}

export function createErrorReporter(store: DataStore): ErrorReporter {
  const active = new Map<string, Promise<unknown>>();
  function serialized<T>(session: string, operation: () => Promise<T>): Promise<T> {
    if (!UUID.test(session)) return Promise.reject(new WorkflowError(400, 'SESSION_REQUIRED', 'A valid demo session is required to report this error.'));
    const key = session.toLowerCase();
    const pending = (active.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
    active.set(key, pending);
    void pending.finally(() => { if (active.get(key) === pending) active.delete(key); }).catch(() => undefined);
    return pending;
  }
  function result(incident: Incident, created: boolean): ErrorReportResult {
    return { incidentId: incident.id, runId: incident.runId, created, occurrenceCount: incident.application!.occurrenceCount, code: incident.application!.code };
  }
  async function report(session: string, raw: unknown): Promise<ErrorReportResult> {
    const input = parse(raw);
    return serialized(session, async () => {
      session = session.toLowerCase();
      const relatedLiveRun = input.liveRunId ? await store.getLiveRun(input.liveRunId, session) : null;
      if (input.liveRunId && !relatedLiveRun) throw new WorkflowError(404, 'NOT_FOUND', 'The related live test was not found in this demo session.');
      // Different configured owned websites can share /health. Their server-stored
      // target identity separates incidents without exposing an arbitrary URL origin.
      const fingerprint = `application:${createHash('sha256').update(JSON.stringify([input.source, input.path, input.code, input.httpStatus ?? null,
        ...(relatedLiveRun ? [relatedLiveRun.targetId] : [])])).digest('hex').slice(0, 24)}`;
      const incidents = (await store.listIncidents(session)).incidents;
      const duplicate = incidents.find(incident => incident.application?.recentEventIds.includes(input.eventId)
        || (input.observerIncidentId && incident.application?.observerIncidentIds?.includes(input.observerIncidentId)));
      if (duplicate) {
        // The observer updates failureKind on an existing historical incident as a
        // runner outage becomes a measured site failure. Its stable history ID is
        // still the same imported occurrence; new check UUIDs record new categories.
        const sameObserverHistory = input.source === 'observer' && input.observerIncidentId
          && duplicate.application?.source === 'observer'
          && duplicate.application.observerIncidentIds?.includes(input.observerIncidentId)
          && duplicate.application.path === input.path && duplicate.application.observerCheckKey === input.observerCheckKey;
        if (duplicate.fingerprint !== fingerprint && !sameObserverHistory) throw new WorkflowError(409, 'ERROR_EVENT_REUSED', 'The error event ID already belongs to a different reported error.');
        if (input.observerIncidentId && !duplicate.application!.observerIncidentIds?.includes(input.observerIncidentId)) {
          duplicate.application!.observerIncidentIds = [...(duplicate.application!.observerIncidentIds ?? []), input.observerIncidentId].slice(-100);
          await store.saveIncident(session, duplicate);
        }
        return result(duplicate, false);
      }
      let incident = incidents.find(item => item.status !== 'resolved' && item.application && item.fingerprint === fingerprint);
      if (input.existingIncidentId) {
        const existing = await store.getIncident(input.existingIncidentId, session);
        if (!existing) throw new WorkflowError(404, 'NOT_FOUND', 'The related incident was not found in this demo session.');
        if (!existing.application || existing.fingerprint !== fingerprint || existing.status === 'resolved') throw new WorkflowError(409, 'ERROR_CONTEXT_MISMATCH', 'The related incident does not match this open application error.');
        incident = existing;
      }
      const now = input.observedAt ?? new Date().toISOString();
      const description = input.code === 'BROWSER_VALIDATION_ERROR'
        ? { title: 'Input needs correction', summary: 'The application could not continue because an input did not meet its requirements.', guidance: 'Check the form or cart message and correct the input yourself. Submitted values were not captured. Login credentials remain under the human\'s control; this incident has no automatic repair.' }
        : input.code === 'OBSERVER_UNAVAILABLE'
        ? { title: 'Independent observer unavailable', summary: 'BizPlus could not reach the independent observer. Website behavior was not established by this request.', guidance: 'Check the observer service status and connection, then let BizPlus request a fresh observer status. This error concerns monitoring availability and does not establish a failure on the monitored website.' }
        : input.code === 'OBSERVER_MONITOR_ERROR'
        ? { title: 'Independent observer could not finish a check', summary: 'The independent observer could not complete its monitoring operation. The monitored website behavior is not established.', guidance: 'Inspect the observer configuration, browser runtime, and connection. Restore the monitoring service, then run the same check again. This incident records a monitoring error and does not confirm that the website failed.' }
        : descriptions[input.source];
      const metadata = { source: input.source, code: input.code, path: input.path, httpStatus: input.httpStatus ?? null, eventId: input.eventId,
        ...(input.liveRunId ? { liveRunId: input.liveRunId } : {}), ...(input.observerCheckId ? { observerCheckId: input.observerCheckId } : {}), requestData: 'not captured' };
      const evidence = event(now, description.summary, metadata);
      if (incident) {
        const context = incident.application!;
        context.occurrenceCount += 1; context.firstSeenAt = context.firstSeenAt < now ? context.firstSeenAt : now;
        context.lastSeenAt = context.lastSeenAt > now ? context.lastSeenAt : now;
        const ids = [...context.recentEventIds, input.eventId];
        context.recentEventIds = ids.length <= MAX_EVENT_IDS ? ids : [ids[0]!, ...ids.slice(-(MAX_EVENT_IDS - 1))];
        if (input.liveRunId && !context.liveRunId) context.liveRunId = input.liveRunId;
        if (input.observerCheckId) context.observerCheckId = input.observerCheckId;
        if (input.observerIncidentId) context.observerIncidentIds = [...(context.observerIncidentIds ?? []), input.observerIncidentId].slice(-100);
        if (input.observerCheckKey) context.observerCheckKey = input.observerCheckKey;
        if (input.requiresManualLogin) context.requiresManualLogin = true;
        boundedEvidence(incident, [evidence]);
        await store.saveIncident(session, incident);
        return result(incident, false);
      }
      const runId = randomUUID(); const incidentId = randomUUID();
      const actual = input.httpStatus === undefined ? input.code : `${input.code}; HTTP ${input.httpStatus}`;
      const assertion = { code: 'APPLICATION_OPERATION_COMPLETED', expected: 'The application operation completes without an error', actual, passed: false };
      const assertions = event(now, 'The application reported an unsuccessful operation.', { ...assertion }, 'assertion');
      const step: StepResult = { id: 'application-error', name: description.title, method: 'EVENT', path: input.path, status: 'failed',
        expected: assertion.expected, actual, durationMs: 0, httpStatus: input.httpStatus ?? null, startedAt: now, completedAt: now,
        assertions: [assertion], evidence: [evidence, assertions], errorCategory: input.code };
      const run: Run = { id: runId, workflowId: WORKFLOW, scenario: 'application_error', status: 'failed', createdAt: now, completedAt: now,
        durationMs: 0, steps: [step], incidentId, orderId: null, transactionId: null, amountMinor: 0, paymentCount: 0 };
      incident = { id: incidentId, runId, workflowId: WORKFLOW, title: description.title, status: 'open', createdAt: now, resolvedAt: null,
        failedStepId: step.id, fingerprint, evidence: step.evidence, recovery: null, relatedIncidentIds: [],
        application: { source: input.source, code: input.code, path: input.path, httpStatus: input.httpStatus ?? null, occurrenceCount: 1,
          firstSeenAt: now, lastSeenAt: now, recentEventIds: [input.eventId], ...(input.liveRunId ? { liveRunId: input.liveRunId } : {}), ...(input.observerCheckId ? { observerCheckId: input.observerCheckId } : {}),
          ...(input.observerIncidentId ? { observerIncidentIds: [input.observerIncidentId] } : {}),
          ...(input.observerCheckKey ? { observerCheckKey: input.observerCheckKey } : {}), ...(input.requiresManualLogin ? { requiresManualLogin: true } : {}) },
        diagnosis: { source: 'rules', summary: description.summary,
          observedFacts: [`Error source: ${input.source}.`, `Error category: ${input.code}.`, `Affected route: ${input.path}.`,
            ...(input.httpStatus === undefined ? ['No HTTP response status was reported.'] : [`The reported HTTP response status was ${input.httpStatus}.`]),
            'Request bodies, login credentials, payment signatures, and raw exception messages were not captured.'],
          possibleCauses: ['Inspect the affected operation and its dependency; the error category alone does not confirm a root cause.'],
          evidenceIds: step.evidence.map(item => item.id), recommendedAction: null, guidance: description.guidance } };
      // The incident FK requires its run to exist first. A failed write rejects report,
      // so callers cannot claim an incident was recorded while storage is unavailable.
      await store.saveRun(session, run);
      await store.saveIncident(session, incident);
      return result(incident, true);
    });
  }
  async function resolve(session: string, incidentId: string, verification: ErrorVerification): Promise<boolean> {
    return serialized(session, async () => {
      session = session.toLowerCase();
      if (!UUID.test(incidentId)) return false;
      const incident = await store.getIncident(incidentId, session);
      if (!incident?.application || incident.login || incident.application.requiresManualLogin || incident.application.source !== verification.source) return false;
      if (incident.status === 'resolved') return true;
      if (verification.source === 'live') {
        if (!verification.verificationRunId || !UUID.test(verification.verificationRunId) || !incident.application.liveRunId) return false;
        const original = await store.getLiveRun(incident.application.liveRunId, session);
        const checked = await store.getLiveRun(verification.verificationRunId, session);
        if (!original || !checked || checked.id === original.id || checked.targetId !== original.targetId || checked.status !== 'passed'
          || !checked.assertions.length || checked.assertions.some(item => !item.passed) || checked.startedAt < original.startedAt
          || original.diagnosis?.category === 'authentication') return false;
      } else if (!verification.observerCheckId || !UUID.test(verification.observerCheckId)) return false;
      const completedAt = new Date().toISOString();
      incident.status = 'resolved'; incident.resolvedAt = completedAt;
      incident.application.verification = { source: verification.source, completedAt,
        ...(verification.verificationRunId ? { verificationRunId: verification.verificationRunId } : {}),
        ...(verification.observerCheckId ? { observerCheckId: verification.observerCheckId } : {}) };
      boundedEvidence(incident, [event(completedAt, 'A fresh matching monitor check passed; this incident is resolved.', { source: verification.source,
        ...(verification.verificationRunId ? { verificationRunId: verification.verificationRunId } : {}),
        ...(verification.observerCheckId ? { observerCheckId: verification.observerCheckId } : {}) }, 'recovery')]);
      await store.saveIncident(session, incident);
      return true;
    });
  }
  return { report, resolve, drain: async () => { await Promise.allSettled([...active.values()]); } };
}
