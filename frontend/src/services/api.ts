import type { Health, Incident, IncidentList, Metrics, RecoveryResult, Run, Scenario, Workflow } from '@bizplus/shared';
import { linkedIncidentId, notifyApiReachable, reportError, setErrorReportingSession } from './errors';

export const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const SESSION_KEY = 'bizplus.demo-session.v1';
let memorySession: string | null = null;
export function readSession(): string {
  try {
    const existing = localStorage.getItem(SESSION_KEY);
    if (existing && /^[0-9a-f-]{36}$/i.test(existing)) { memorySession = existing; setErrorReportingSession(existing); return existing; }
  } catch { /* A private browser may deny local storage. */ }
  if (memorySession) { setErrorReportingSession(memorySession); return memorySession; }
  return newSession();
}
export function newSession(): string {
  const id = crypto.randomUUID();
  memorySession = id; setErrorReportingSession(id);
  try { localStorage.setItem(SESSION_KEY, id); } catch { /* Keep the current session in memory. */ }
  return id;
}
export class RequestError extends Error {
  /** Prevent a rejected API promise from being recorded again as a browser failure. */
  reportedToInvestigation = false;
  constructor(message: string, public status: number, public code?: string, public incidentId?: string) { super(message); }
}
export async function captureRequestError(error: RequestError, path: string, session: string): Promise<RequestError> {
  error.reportedToInvestigation = true;
  error.incidentId = linkedIncidentId(error.incidentId);
  if (error.incidentId || path.split('?')[0] === '/api/errors') return error;
  const result = await reportError(session, { source: 'api', code: error.status ? 'API_HTTP_ERROR' : error.code === 'TIMEOUT' ? 'API_TIMEOUT' : error.code === 'INVALID_RESPONSE' ? 'API_INVALID_RESPONSE' : 'API_NETWORK_ERROR', path, ...(error.status ? { httpStatus: error.status } : {}) });
  error.incidentId = result.incidentId;
  return error;
}
export async function request<T>(path: string, session: string, init: RequestInit = {}, timeoutMs = 15000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init, signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Demo-Session': session, ...init.headers },
    });
    const data = await response.json().catch(() => null);
    // An HTTP rejection still proves that the backend connection has returned.
    notifyApiReachable(session);
    if (!response.ok) throw new RequestError(data?.error || `The API returned HTTP ${response.status}.`, response.status, data?.code, linkedIncidentId(data?.incidentId));
    if (data === null && response.status !== 204) throw new RequestError('The backend returned an unreadable response. Please retry.', 0, 'INVALID_RESPONSE');
    return data as T;
  } catch (error) {
    const failure = error instanceof RequestError ? error : error instanceof DOMException && error.name === 'AbortError' ? new RequestError('The backend took too long to respond. Please retry.', 0, 'TIMEOUT') : new RequestError('The backend could not be reached. Check that the API is running, then retry.', 0, 'NETWORK');
    throw await captureRequestError(failure, path, session);
  } finally { clearTimeout(timer); }
}
export const api = {
  health: (session: string) => request<Health>('/health', session, {}, 10000),
  workflows: (session: string) => request<Workflow[] | { workflows: Workflow[] }>('/api/workflows', session),
  metrics: (session: string) => request<Metrics>('/api/metrics', session),
  incidents: (session: string) => request<IncidentList>('/api/incidents', session),
  incident: (session: string, id: string) => request<Incident>(`/api/incidents/${encodeURIComponent(id)}`, session),
  run: (session: string, id: string) => request<Run>(`/api/runs/${encodeURIComponent(id)}`, session),
  start: (session: string, scenario: Scenario) => request<{ runId: string }>('/api/runs', session, { method: 'POST', body: JSON.stringify({ workflowId: 'commerce-checkout', scenario }) }),
  recover: (session: string, id: string) => request<Incident | RecoveryResult | { incident: Incident }>(`/api/incidents/${encodeURIComponent(id)}/recover`, session, { method: 'POST', body: JSON.stringify({ action: 'resume_receipt_worker', approved: true }) }, 30000),
};
