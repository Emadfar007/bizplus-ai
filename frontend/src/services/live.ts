import type { LiveFault, LiveLabState, LiveRun, LiveRunList, LiveTargetList } from '@bizplus/shared';
import { request } from './api';
export interface ObserverDiagnosis { summary: string; certainty: 'confirmed' | 'unconfirmed'; causes: string[]; solutions: string[] }
export interface ObserverSnapshot {
  enabled: boolean; available: boolean; url?: string; message?: string; status?: string;
  instanceId?: string; origin?: string; intervalMs?: number; historyPolicy?: 'temporary' | 'local';
  browser?: { available: boolean | null; lastError: string | null }; lastCompletedAt?: string | null;
  checks?: { id: string; key: string; label: string; status: 'passed' | 'failed' | 'monitor_error'; completedAt: string; durationMs: number; assertions: { code: string; expected: string; actual: string; passed: boolean }[]; evidence: string[]; diagnosis: ObserverDiagnosis }[];
  incidents?: { id: string; key: string; label: string; status: 'open' | 'resolved'; openedAt: string; lastSeenAt: string; resolvedAt: string | null; diagnosis: ObserverDiagnosis }[];
  limitations?: string[];
}
export const liveApi = {
  targets: (session: string) => request<LiveTargetList>('/api/live/targets', session),
  runs: (session: string) => request<LiveRunList>('/api/live/runs', session),
  run: (session: string, id: string) => request<LiveRun>(`/api/live/runs/${encodeURIComponent(id)}`, session),
  start: (session: string, targetId: string) => request<{ runId: string }>('/api/live/runs', session, { method: 'POST', body: JSON.stringify({ targetId }) }),
  lab: (session: string) => request<LiveLabState>('/api/live/lab', session),
  introduce: (session: string, fault: LiveFault) => request<LiveLabState>('/api/live/lab', session, { method: 'POST', body: JSON.stringify({ fault, approved: true }) }),
  recover: (session: string, runId: string) => request<{ runId: string; verificationRunId: string; status: 'verified' | 'failed' }>(`/api/live/runs/${encodeURIComponent(runId)}/recover`, session, { method: 'POST', body: JSON.stringify({ approved: true }) }, 45000),
  verify: (session: string, runId: string) => request<{ runId: string; verificationRunId: string; status: 'verified' | 'failed' }>(`/api/live/runs/${encodeURIComponent(runId)}/verify`, session, { method: 'POST', body: JSON.stringify({ approved: true }) }, 45000),
  observer: (session: string) => request<ObserverSnapshot>('/api/live/observer', session),
};
