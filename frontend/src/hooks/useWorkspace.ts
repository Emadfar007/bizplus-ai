import { useCallback, useEffect, useRef, useState } from 'react';
import type { Health, IncidentList, Metrics, Run, Scenario, Workflow } from '@bizplus/shared';
import { api, newSession, readSession, RequestError } from '../services/api';
import { linkedIncidentId, setErrorReportingSession } from '../services/errors';

const EMPTY_INCIDENTS: IncidentList = { incidents: [], groups: [] };
function keepCompletedRun(previous: Run | null, current: Run): Run {
  return previous?.id === current.id && ['passed','failed'].includes(previous.status) && ['queued','running'].includes(current.status) ? previous : current;
}
export function useWorkspace() {
  const [session, setSession] = useState(readSession);
  const [health, setHealth] = useState<Health | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'ready' | 'offline'>('connecting');
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [incidentList, setIncidentList] = useState<IncidentList>(EMPTY_INCIDENTS);
  const [run, setRun] = useState<Run | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [scenario, setScenario] = useState<Scenario>('healthy');
  const [starting, setStarting] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const runIdRef = useRef<string | null>(null);
  const sessionRef = useRef(session);
  const sessionGeneration = useRef(0);
  const activeRequest = useRef(false);
  sessionRef.current = session;
  runIdRef.current = runId;
  const isCurrentSession = useCallback((id: string, generation?: number) => sessionRef.current === id && (generation === undefined || sessionGeneration.current === generation), []);

  useEffect(() => { setErrorReportingSession(session); }, [session]);

  useEffect(() => {
    const generation = sessionGeneration.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + 120000;
    setConnection('connecting');
    setHealth(null);
    async function connect() {
      try {
        const data = await api.health(session);
        if (cancelled || !isCurrentSession(session, generation)) return;
        setHealth(data); setConnection('ready');
        const result = await api.workflows(session);
        if (!cancelled && isCurrentSession(session, generation)) setWorkflows(Array.isArray(result) ? result : result.workflows);
      } catch {
        if (cancelled || !isCurrentSession(session, generation)) return;
        if (Date.now() < deadline) timer = setTimeout(connect, 3000);
        else setConnection('offline');
      }
    }
    void connect();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [session, connectionAttempt, isCurrentSession]);

  const refresh = useCallback(async () => {
    const requestedSession = session;
    const generation = sessionGeneration.current;
    if (!isCurrentSession(requestedSession, generation)) return;
    const results = await Promise.allSettled([api.metrics(session), api.incidents(session)]);
    if (!isCurrentSession(requestedSession, generation)) return;
    if (results[0].status === 'fulfilled') setMetrics(results[0].value);
    if (results[1].status === 'fulfilled') setIncidentList(results[1].value);
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected?.status === 'rejected') setError(rejected.reason instanceof Error ? rejected.reason.message : 'Unable to refresh this session.');
    else { setLastUpdated(new Date()); }
    if (results.every(result => result.status === 'rejected' && result.reason instanceof RequestError && result.reason.status === 0)) setConnection('offline');
    let id = runIdRef.current;
    if (!id && results[0].status === 'fulfilled' && results[0].value.recentRuns[0]) {
      const latest = results[0].value.recentRuns[0];
      id = latest.id; runIdRef.current = id; setRunId(id); setRun(latest);
    }
    if (id) {
      try {
        const result = await api.run(session, id);
        if (isCurrentSession(requestedSession, generation) && runIdRef.current === id) setRun(previous => keepCompletedRun(previous, result));
      } catch (cause) {
        if (!isCurrentSession(requestedSession, generation) || runIdRef.current !== id) return;
        if (cause instanceof RequestError && cause.status === 404) {
          runIdRef.current = null;
          setRunId(null); setRun(null);
          setNotice('This run is no longer available. Hosted history may have reset; start a new test.');
        } else setError(cause instanceof Error ? cause.message : 'Unable to retrieve this run.');
      }
    }
  }, [session, isCurrentSession]);

  useEffect(() => {
    if (connection !== 'ready') return;
    const generation = sessionGeneration.current;
    const seen = new Set<string>();
    let cancelled = false;
    let refreshing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reported = (event: Event) => {
      const detail: unknown = (event as CustomEvent).detail;
      if (!detail || typeof detail !== 'object') return;
      const report = detail as { session?: unknown; incidentId?: unknown };
      const incidentId = linkedIncidentId(report.incidentId);
      if (report.session !== session || !incidentId || !isCurrentSession(session, generation) || seen.has(incidentId)) return;
      seen.add(incidentId);
      if (seen.size > 128) seen.delete(seen.values().next().value!);
      // Coalesce bursts. Events caused by this read never recursively trigger it.
      if (refreshing || timer || cancelled) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (cancelled || !isCurrentSession(session, generation)) return;
        refreshing = true;
        void refresh().finally(() => { refreshing = false; });
      }, 150);
    };
    window.addEventListener('bizplus:incident-reported', reported);
    return () => { cancelled = true; if (timer) clearTimeout(timer); window.removeEventListener('bizplus:incident-reported', reported); };
  }, [connection, session, refresh, isCurrentSession]);

  useEffect(() => {
    if (connection !== 'ready') return;
    let cancelled = false;
    let polling = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      if (cancelled || polling) return;
      polling = true;
      try { if (!document.hidden) await refresh(); }
      finally { polling = false; }
      if (!cancelled) timer = setTimeout(poll, 2000);
    }
    const visible = () => { if (!document.hidden && !cancelled) { if (timer) clearTimeout(timer); void poll(); } };
    void poll();
    document.addEventListener('visibilitychange', visible);
    return () => { cancelled = true; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [connection, refresh]);

  // Follow persisted step changes during the short sandbox journey. Full metrics
  // keep their slower refresh cadence so progress does not multiply dashboard reads.
  useEffect(() => {
    if (!runId || !['queued','running'].includes(run?.status || '') || connection !== 'ready') return;
    const generation = sessionGeneration.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function followProgress() {
      try {
        const current = await api.run(session, runId!);
        if (cancelled || !isCurrentSession(session, generation) || runIdRef.current !== runId) return;
        setRun(previous => keepCompletedRun(previous, current));
        if (!['queued','running'].includes(current.status)) return;
      } catch { /* The normal refresh reports connection and retrieval errors. */ }
      if (!cancelled) timer = setTimeout(followProgress, 250);
    }
    void followProgress();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [runId, run?.status, connection, session, isCurrentSession]);

  const active = starting || recovering || run?.status === 'queued' || run?.status === 'running' || !!metrics?.recentRuns.some(item => item.status === 'queued' || item.status === 'running');
  const startRun = useCallback(async () => {
    const generation = sessionGeneration.current;
    if (!isCurrentSession(session, generation) || activeRequest.current || active || connection !== 'ready') return;
    activeRequest.current = true;
    setStarting(true); setError(null); setNotice(null);
    try {
      const result = await api.start(session, scenario);
      if (!isCurrentSession(session, generation)) return;
      runIdRef.current = result.runId;
      setRunId(result.runId);
      const current = await api.run(session, result.runId);
      if (!isCurrentSession(session, generation)) return;
      if (runIdRef.current === result.runId) setRun(previous => keepCompletedRun(previous, current));
      await refresh();
    } catch (cause) { if (isCurrentSession(session, generation)) setError(cause instanceof Error ? cause.message : 'The workflow could not start.'); }
    finally { if (isCurrentSession(session, generation)) { activeRequest.current = false; setStarting(false); } }
  }, [active, connection, refresh, scenario, session, isCurrentSession]);

  const startRef = useRef(startRun);
  startRef.current = startRun;
  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(() => { if (!document.hidden) void startRef.current(); }, 30000);
    return () => clearInterval(timer);
  }, [auto]);

  async function selectRun(id: string) {
    const generation = sessionGeneration.current;
    if (!isCurrentSession(session, generation)) return;
    setRunId(id); runIdRef.current = id; setError(null);
    try {
      const selected = await api.run(session, id);
      if (isCurrentSession(session, generation) && runIdRef.current === id) setRun(previous => keepCompletedRun(previous, selected));
    } catch (cause) {
      if (isCurrentSession(session, generation) && runIdRef.current === id) setError(cause instanceof Error ? cause.message : 'Unable to open this run.');
    }
  }
  async function recover(id: string) {
    const generation = sessionGeneration.current;
    if (!isCurrentSession(session, generation) || recovering || active || activeRequest.current) return;
    activeRequest.current = true; setRecovering(true); setError(null);
    try {
      await api.recover(session, id);
      if (!isCurrentSession(session, generation)) return;
      await refresh();
      if (!isCurrentSession(session, generation)) return;
      const incident = await api.incident(session, id);
      if (isCurrentSession(session, generation)) setNotice(incident.status === 'resolved' ? 'Recovery verified. The original order is confirmed, with no new payment.' : 'Recovery did not pass verification. The incident remains open; review the latest evidence.');
    } catch (cause) { if (isCurrentSession(session, generation)) setError(cause instanceof Error ? cause.message : 'Recovery could not be completed.'); }
    finally { if (isCurrentSession(session, generation)) { activeRequest.current = false; setRecovering(false); } }
  }
  function resetSession() {
    sessionGeneration.current += 1;
    const nextSession = newSession();
    sessionRef.current = nextSession;
    runIdRef.current = null;
    activeRequest.current = false;
    setStarting(false); setRecovering(false); setConnection('connecting'); setHealth(null); setLastUpdated(null);
    setAuto(false); setMetrics(null); setIncidentList(EMPTY_INCIDENTS); setRunId(null); setRun(null);
    setError(null); setSession(nextSession); setNotice('A fresh isolated demo session is ready. Previous runs were not deleted.');
  }
  return { session, health, connection, workflows, metrics, incidentList, run, scenario, setScenario, starting, recovering, error, notice, auto, setAuto, active, lastUpdated, startRun, selectRun, recover, resetSession, isCurrentSession, clearError: () => setError(null), clearNotice: () => setNotice(null), reconnect: () => { setError(null); setConnectionAttempt(value => value + 1); }, refresh };
}
export type Workspace = ReturnType<typeof useWorkspace>;
