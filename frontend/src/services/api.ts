import type { Health, Incident, IncidentList, Metrics, RecoveryResult, Run, Scenario, Workflow } from '@bizplus/shared';

export const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const SESSION_KEY = 'bizplus.demo-session.v1';
export function readSession(): string {
  try {
    const existing = localStorage.getItem(SESSION_KEY);
    if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
  } catch { /* A private browser may deny local storage. */ }
  return newSession();
}
export function newSession(): string {
  const id = crypto.randomUUID();
  try { localStorage.setItem(SESSION_KEY, id); } catch { /* Keep the current session in memory. */ }
  return id;
}
export class RequestError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}
async function request<T>(path: string, session: string, init: RequestInit = {}, timeoutMs = 15000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init, signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Demo-Session': session, ...init.headers },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new RequestError(data?.error || `The API returned HTTP ${response.status}.`, response.status, data?.code);
    return data as T;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') throw new RequestError('The backend took too long to respond. Please retry.', 0, 'TIMEOUT');
    throw new RequestError('The backend could not be reached. Check that the API is running, then retry.', 0, 'NETWORK');
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
