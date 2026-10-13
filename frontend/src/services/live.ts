import type { LiveRun, LiveRunList, LiveTargetList } from '@bizplus/shared';
import { request } from './api';
export const liveApi = {
  targets: (session: string) => request<LiveTargetList>('/api/live/targets', session),
  runs: (session: string) => request<LiveRunList>('/api/live/runs', session),
  run: (session: string, id: string) => request<LiveRun>(`/api/live/runs/${encodeURIComponent(id)}`, session),
  start: (session: string, targetId: string) => request<{ runId: string }>('/api/live/runs', session, { method: 'POST', body: JSON.stringify({ targetId }) }),
};
