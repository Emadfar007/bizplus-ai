import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowRight, ArrowUpRight, Check, CheckCircle2, Clock3, ExternalLink, FileSearch, Globe2, Loader2, Play, Radio, RefreshCw, ShieldCheck, Timer, TriangleAlert, X } from 'lucide-react';
import type { LiveRun, LiveTarget } from '@bizplus/shared';
import type { Workspace } from '../hooks/useWorkspace';
import { Badge, duration, EmptyState, SectionLabel, shortId, time } from '../components/UI';
import { liveApi } from '../services/live';

const LatencyChart = lazy(() => import('../components/LatencyChart'));
function hostname(url: string) { try { return new URL(url).hostname; } catch { return url; } }
export default function LiveTests({ workspace }: { workspace: Workspace }) {
  const session = workspace.session;
  const [targets, setTargets] = useState<LiveTarget[]>([]);
  const [runs, setRuns] = useState<LiveRun[]>([]);
  const [selectedTarget, setSelectedTarget] = useState('');
  const [selectedRun, setSelectedRun] = useState<LiveRun | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [auto, setAuto] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const alive = useRef(true);
  const selectedIdRef = useRef<string | null>(null);
  const requestBusy = useRef(false);
  const startRef = useRef<() => Promise<void>>(async () => {});
  selectedIdRef.current = runId;
  const current = useCallback(() => alive.current && workspace.isCurrentSession(session), [session, workspace.isCurrentSession]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const refresh = useCallback(async () => {
    try {
      const result = await liveApi.runs(session);
      if (!current()) return;
      setRuns(result.runs); setLastUpdated(new Date());
      let id = selectedIdRef.current;
      if (!id && result.runs[0]) { id = result.runs[0].id; selectedIdRef.current = id; setRunId(id); setSelectedRun(result.runs[0]); }
      if (id) {
        const recent = result.runs.find(item => item.id === id);
        if (recent) setSelectedRun(recent);
        else {
          const detail = await liveApi.run(session, id);
          if (current() && selectedIdRef.current === id) setSelectedRun(detail);
        }
      }
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : 'Live measurements could not be retrieved.'); }
  }, [session, current]);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const results = await Promise.allSettled([liveApi.targets(session), liveApi.runs(session)]);
    if (!current()) return;
    if (results[0].status === 'fulfilled') {
      const result = results[0].value; setTargets(result.targets); setConfigured(result.configured);
      setSelectedTarget(previous => result.targets.some(item => item.id === previous) ? previous : result.targets[0]?.id || '');
    }
    if (results[1].status === 'fulfilled') {
      setRuns(results[1].value.runs);
      if (!selectedIdRef.current && results[1].value.runs[0]) { const first = results[1].value.runs[0]; selectedIdRef.current = first.id; setRunId(first.id); setSelectedRun(first); }
    }
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') setError(failure.reason instanceof Error ? failure.reason.message : 'The live test setup is unavailable.');
    setLoading(false);
  }, [session, current]);
  useEffect(() => { if (workspace.connection === 'ready') void load(); }, [workspace.connection, load]);
  useEffect(() => {
    if (workspace.connection !== 'ready') return;
    let cancelled = false, polling = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() { if (cancelled || polling) return; polling = true; try { if (!document.hidden) await refresh(); } finally { polling = false; } if (!cancelled) timer = setTimeout(poll, 2000); }
    timer = setTimeout(poll, 2000);
    const visibility = () => { if (!document.hidden) { clearTimeout(timer); void poll(); } };
    document.addEventListener('visibilitychange', visibility);
    return () => { cancelled = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [workspace.connection, refresh]);
  const active = starting || runs.some(run => run.status === 'running' || run.status === 'queued') || selectedRun?.status === 'running' || selectedRun?.status === 'queued';
  async function start() {
    if (!current() || requestBusy.current || active || !configured || !selectedTarget || workspace.connection !== 'ready') return;
    requestBusy.current = true; setStarting(true); setError(null);
    try {
      const result = await liveApi.start(session, selectedTarget);
      if (!current()) return;
      selectedIdRef.current = result.runId; setRunId(result.runId);
      const detail = await liveApi.run(session, result.runId);
      if (!current()) return;
      if (selectedIdRef.current === result.runId) setSelectedRun(detail);
      await refresh();
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : 'The live test could not start.'); }
    finally { if (current()) { requestBusy.current = false; setStarting(false); } }
  }
  startRef.current = start;
  useEffect(() => {
    if (!auto) return;
    const interval = setInterval(() => { if (!document.hidden) void startRef.current(); }, 30000);
    return () => clearInterval(interval);
  }, [auto]);
  async function select(id: string) {
    selectedIdRef.current = id; setRunId(id); setError(null);
    const stored = runs.find(item => item.id === id);
    if (stored) { setSelectedRun(stored); return; }
    try { const detail = await liveApi.run(session, id); if (current() && selectedIdRef.current === id) setSelectedRun(detail); }
    catch (cause) { if (current() && selectedIdRef.current === id) setError(cause instanceof Error ? cause.message : 'Unable to inspect this live test.'); }
  }
  const completed = runs.filter(run => run.status === 'passed' || run.status === 'failed');
  const passed = completed.filter(run => run.status === 'passed').length;
  const average = completed.length ? completed.reduce((sum, run) => sum + run.durationMs, 0) / completed.length : 0;
  const target = targets.find(item => item.id === selectedTarget);
  const points = [...completed].reverse().map(run => ({ runId: run.id, timestamp: run.startedAt, durationMs: run.durationMs, passed: run.status === 'passed' }));
  return <>
    <section className="live-hero"><div><SectionLabel><Radio size={13}/> LIVE WEBSITE CHECKS</SectionLabel><h1>Outside the sandbox.<br/><span>Inside your field of view.</span></h1><p>Make an actual HTTPS request to an approved website. Check its response and content, record the timing, and inspect the evidence that came back.</p><div className="live-hero-note"><Globe2 size={15}/><span>Only server-configured, owned targets can be tested.</span></div></div><div className="live-globe" aria-hidden="true"><Globe2 size={116} strokeWidth={.7}/><span className="globe-signal"><Activity size={22}/></span><div>REAL REQUESTS<span>REAL MEASUREMENTS</span></div></div></section>
    {error ? <div className="feedback error" role="alert"><TriangleAlert size={18}/><span>{error}</span><button className="text-button" onClick={() => void load()}>Retry</button><button className="icon-button" aria-label="Dismiss live test error" onClick={() => setError(null)}><X size={16}/></button></div> : null}
    <div className="metric-row live-metrics"><div className="metric"><div className="metric-title"><span>Live success rate</span><ShieldCheck size={16} className="cyan"/></div><strong>{completed.length ? `${Math.round(passed / completed.length * 100)}%` : '—'}</strong><span className="metric-foot">{completed.length ? `${passed} of ${completed.length} completed checks` : 'Awaiting the first live check'}</span></div><div className="metric"><div className="metric-title"><span>Average response time</span><Timer size={16} className="blue"/></div><strong>{completed.length ? duration(average) : '—'}</strong><span className="metric-foot">Measured from real HTTPS responses</span></div><div className="metric"><div className="metric-title"><span>Failed checks</span><TriangleAlert size={16} className="amber"/></div><strong>{completed.length ? completed.length - passed : '0'}</strong><span className="metric-foot">Status or content assertions failed</span></div><div className="metric"><div className="metric-title"><span>Approved targets</span><Globe2 size={16} className="cyan"/></div><strong>{loading ? '—' : targets.length}</strong><span className="metric-foot">Controlled by the server allowlist</span></div></div>
    <div className="live-main-grid"><section className="panel live-target-panel"><div className="panel-header"><div><SectionLabel>MONITORED WEBSITES</SectionLabel><h2>Choose an approved target</h2></div><Globe2 size={21} className="muted"/></div>{loading && !targets.length ? <EmptyState icon={Loader2} title="Loading approved targets">The server decides which sites this demo can test.</EmptyState> : targets.length ? <div className="live-target-list">{targets.map(item => <button key={item.id} disabled={active} aria-pressed={item.id === selectedTarget} className={`live-target ${item.id === selectedTarget ? 'selected' : ''}`} onClick={() => setSelectedTarget(item.id)}><span className="live-target-icon"><Globe2 size={19}/></span><span><strong>{item.name}</strong><small>{hostname(item.url)}</small><code>{item.url}</code></span><span className="radio-dot"/></button>)}</div> : <EmptyState icon={Globe2} title="No live targets configured">The operator must add an approved, owned HTTPS website to the server configuration before a live test can run.</EmptyState>}{target ? <div className="live-target-assertions"><span><Check size={13}/> Expected HTTP {target.expectedStatus}</span>{target.containsText ? <span><FileSearch size={13}/> Content includes <code>{target.containsText}</code></span> : <span><FileSearch size={13}/> Status and timing check</span>}</div> : null}<div className="live-execution-controls"><button className="primary-button" disabled={!configured || !selectedTarget || active || workspace.connection !== 'ready'} onClick={() => void start()}>{active ? <Loader2 className="spin" size={17}/> : <Play size={16} fill="currentColor"/>}{starting ? 'Starting live check…' : active ? 'Live check in progress…' : 'Run live test'}<ArrowRight size={16}/></button><label className="auto-control"><span><Clock3 size={15}/><span>Check every 30 seconds<small>Visible tab only · one active run</small></span></span><button type="button" role="switch" aria-checked={auto} aria-label="Auto-run approved live target every 30 seconds" className={`switch ${auto ? 'on' : ''}`} disabled={!configured || workspace.connection !== 'ready'} onClick={() => setAuto(!auto)}><span/></button></label></div></section>
    <section className="panel live-result"><div className="panel-header"><div><SectionLabel>THE ACTUAL RESPONSE</SectionLabel><h2>Latest selected check</h2></div>{selectedRun ? <Badge status={selectedRun.status}/> : <Badge status="idle">Ready</Badge>}</div>{selectedRun ? <><div className="live-result-url"><Globe2 size={15}/><code>{selectedRun.url}</code><a href={selectedRun.url} target="_blank" rel="noreferrer" aria-label="Open tested target"><ExternalLink size={14}/></a></div><div className="live-response-overview"><div><span>HTTP STATUS</span><strong className={selectedRun.status === 'passed' ? 'cyan' : selectedRun.status === 'failed' ? 'danger-text' : ''}>{selectedRun.httpStatus ?? '—'}</strong></div><div><span>RESPONSE TIME</span><strong>{selectedRun.completedAt ? duration(selectedRun.durationMs) : 'Checking…'}</strong></div><div><span>RESPONSE SIZE</span><strong>{selectedRun.completedAt ? `${selectedRun.evidence.responseBytes.toLocaleString()} B` : '—'}</strong></div></div><p className="live-result-message">{selectedRun.message || 'The server is requesting the approved endpoint…'}</p>{selectedRun.error ? <p className="live-result-error"><TriangleAlert size={14}/>{selectedRun.error}</p> : null}<div className="live-result-assertions">{selectedRun.assertions.map(assertion => <div key={assertion.code} className={assertion.passed ? 'passed' : 'failed'}>{assertion.passed ? <CheckCircle2 size={17}/> : <X size={17}/>}<span><strong>{assertion.code.replace(/_/g, ' ').toLowerCase()}</strong><small>Expected: {assertion.expected}<br/>Observed: {assertion.actual}</small></span></div>)}</div><div className="panel-footer"><span>{time(selectedRun.startedAt)} · Real HTTPS request</span><span>RUN {shortId(selectedRun.id)}</span></div></> : <EmptyState icon={Activity} title="Start with a real response">Choose an approved target and run a live check to see its status, timing, and assertions here.</EmptyState>}</section></div>
    <div className="live-secondary-grid"><section className="panel trend-panel"><div className="panel-header"><div><SectionLabel>LIVE PERFORMANCE HISTORY</SectionLabel><h2>Response duration</h2></div><span className="small-meta">{completed.length} completed checks</span></div>{points.length ? <Suspense fallback={<div className="chart-loading"><Loader2 size={21} className="spin"/></div>}><LatencyChart points={points}/></Suspense> : <EmptyState icon={Timer} title="Measure your first baseline">Charts populate from completed live requests, with no seeded timings.</EmptyState>}</section><section className="panel"><div className="panel-header"><div><SectionLabel>SESSION EXECUTIONS</SectionLabel><h2>Recent live checks</h2></div><button className="text-button" onClick={() => void refresh()}><RefreshCw size={13}/> Refresh</button></div>{runs.length ? <div className="runs-list live-runs-list">{runs.slice(0, 8).map(run => <button key={run.id} className={`run-item ${run.id === selectedRun?.id ? 'selected' : ''}`} onClick={() => void select(run.id)}><span className={`run-status-icon ${run.status}`}>{run.status === 'passed' ? <Check size={15}/> : run.status === 'failed' ? <X size={15}/> : <Loader2 size={15} className="spin"/>}</span><span className="run-description"><strong>{targets.find(item => item.id === run.targetId)?.name || hostname(run.url)}</strong><small>{time(run.startedAt)} · {run.httpStatus === null ? run.status : `HTTP ${run.httpStatus}`}</small></span><span className="run-time">{run.completedAt ? duration(run.durationMs) : 'Running'}</span><ArrowUpRight size={15}/></button>)}</div> : <EmptyState icon={Radio} title="No live checks yet">Your website measurements are separate from the injected sandbox failures.</EmptyState>}</section></div>
    {selectedRun?.completedAt ? <section className="panel live-evidence"><div className="panel-header"><div><SectionLabel>RESPONSE EVIDENCE</SectionLabel><h2>{selectedRun.evidence.title || 'Captured response excerpt'}</h2></div>{selectedRun.fingerprint ? <span className="live-fingerprint"><FileSearch size={13}/>{selectedRun.fingerprint}</span> : null}</div><pre>{selectedRun.evidence.excerpt || 'No response body was captured for this request.'}</pre><div className="panel-footer"><span>Response excerpts are displayed as text.</span><span>{lastUpdated ? `SYNCED ${time(lastUpdated.toISOString())}` : 'Awaiting refresh'}</span></div></section> : null}
  </>;
}
