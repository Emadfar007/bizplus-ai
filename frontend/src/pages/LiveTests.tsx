import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, CheckCircle2, Clock3, ExternalLink, FileSearch, Globe2, Loader2, Play, Radio, RefreshCw, ShieldCheck, Timer, TriangleAlert, X } from 'lucide-react';
import type { LiveFault, LiveLabState, LiveRun, LiveTarget } from '@bizplus/shared';
import type { Workspace } from '../hooks/useWorkspace';
import { Badge, duration, EmptyState, SectionLabel, shortId, time } from '../components/UI';
import { LiveInvestigation, LiveLabControl, LiveTracePanel } from '../components/LiveWorkflow';
import LiveObserver from '../components/LiveObserver';
import { LoginForm } from '../components/LoginForm';
import { liveApi, type ObserverSnapshot } from '../services/live';
import '../live-workflow.css';

const LatencyChart = lazy(() => import('../components/LatencyChart'));
function hostname(url: string) { try { return new URL(url).hostname; } catch { return url; } }
function message(cause: unknown, fallback: string) { return cause instanceof Error ? cause.message : fallback; }

export default function LiveTests({ workspace }: { workspace: Workspace }) {
  const session = workspace.session;
  const [targets, setTargets] = useState<LiveTarget[]>([]);
  const [runs, setRuns] = useState<LiveRun[]>([]);
  const [lab, setLab] = useState<LiveLabState | null>(null);
  const [fault, setFault] = useState<LiveFault>('healthy');
  const [selectedTarget, setSelectedTarget] = useState('');
  const [selectedRun, setSelectedRun] = useState<LiveRun | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<'starting' | 'injecting' | 'restoring' | 'recovering' | null>(null);
  const [auto, setAuto] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [observer, setObserver] = useState<ObserverSnapshot | null>(null);
  const [observerError, setObserverError] = useState<string | null>(null);
  const alive = useRef(true);
  const selectedIdRef = useRef<string | null>(null);
  const requestBusy = useRef(false);
  const startRef = useRef<() => Promise<void>>(async () => {});
  selectedIdRef.current = runId;
  const current = useCallback(() => alive.current && workspace.isCurrentSession(session), [session, workspace.isCurrentSession]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    selectedIdRef.current = null; requestBusy.current = false;
    setRuns([]); setTargets([]); setLab(null); setSelectedRun(null); setRunId(null);
    setSelectedTarget(''); setConfigured(false); setAuto(false); setAction(null);
    setNotice(null); setError(null); setObserver(null); setObserverError(null);
  }, [session]);

  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([liveApi.runs(session), liveApi.lab(session)]);
    if (!current()) return;
    if (results[1].status === 'fulfilled') setLab(results[1].value);
    if (results[0].status === 'rejected') { setError(message(results[0].reason, 'Live measurements could not be retrieved.')); return; }
    const result = results[0].value;
    setRuns(result.runs); setLastUpdated(new Date());
    let id = selectedIdRef.current;
    if (!id && result.runs[0]) { id = result.runs[0].id; selectedIdRef.current = id; setRunId(id); }
    if (id) {
      const recent = result.runs.find(item => item.id === id);
      if (recent) setSelectedRun(recent);
      else {
        try { const detail = await liveApi.run(session, id); if (current() && selectedIdRef.current === id) setSelectedRun(detail); }
        catch (cause) { if (current()) setError(message(cause, 'Unable to inspect this live test.')); }
      }
    }
  }, [session, current]);
  const refreshObserver = useCallback(async () => {
    try { const result = await liveApi.observer(session); if (current()) { setObserver(result); setObserverError(null); } }
    catch (cause) { if (current()) setObserverError(message(cause, 'The independent observer status is unavailable.')); }
  }, [session, current]);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const results = await Promise.allSettled([liveApi.targets(session), liveApi.runs(session), liveApi.lab(session)]);
    if (!current()) return;
    if (results[0].status === 'fulfilled') {
      const result = results[0].value;
      setTargets(result.targets); setConfigured(result.configured);
      setSelectedTarget(previous => result.targets.some(item => item.id === previous) ? previous : result.targets.find(item => item.id === 'bizplus-fault-lab')?.id || result.targets[0]?.id || '');
    }
    if (results[1].status === 'fulfilled') {
      setRuns(results[1].value.runs);
      if (!selectedIdRef.current && results[1].value.runs[0]) { const first = results[1].value.runs[0]; selectedIdRef.current = first.id; setRunId(first.id); setSelectedRun(first); }
    }
    if (results[2].status === 'fulfilled') setLab(results[2].value);
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') setError(message(failure.reason, 'The live test setup is unavailable.'));
    setLoading(false);
  }, [session, current]);
  useEffect(() => { if (workspace.connection === 'ready') void load(); }, [workspace.connection, load]);
  useEffect(() => {
    void refreshObserver();
    const timer = setInterval(() => { if (!document.hidden) void refreshObserver(); }, 15000);
    return () => clearInterval(timer);
  }, [refreshObserver]);
  useEffect(() => {
    if (workspace.connection !== 'ready') return;
    let cancelled = false, polling = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() { if (cancelled || polling) return; polling = true; try { if (!document.hidden) await refresh(); } finally { polling = false; } if (!cancelled) timer = setTimeout(poll, 2000); }
    timer = setTimeout(poll, 2000);
    const visibility = () => { if (!document.hidden) { clearTimeout(timer); void poll(); void refreshObserver(); } };
    document.addEventListener('visibilitychange', visibility);
    return () => { cancelled = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [workspace.connection, refresh, refreshObserver]);

  const active = !!action || runs.some(run => run.status === 'running' || run.status === 'queued') || selectedRun?.status === 'running' || selectedRun?.status === 'queued';
  const connected = workspace.connection === 'ready';
  async function beginRun(targetId: string) {
    const result = await liveApi.start(session, targetId);
    if (!current()) return;
    selectedIdRef.current = result.runId; setRunId(result.runId); setSelectedRun(null);
    const detail = await liveApi.run(session, result.runId);
    if (!current()) return;
    if (selectedIdRef.current === result.runId) setSelectedRun(detail);
    await refresh();
  }
  async function start() {
    if (!current() || requestBusy.current || active || !configured || !selectedTarget || !connected) return;
    requestBusy.current = true; setAction('starting'); setError(null); setNotice(null);
    try { await beginRun(selectedTarget); }
    catch (cause) { if (current()) setError(message(cause, 'The live test could not start.')); }
    finally { if (current()) { requestBusy.current = false; setAction(null); } }
  }
  startRef.current = start;
  useEffect(() => {
    if (!auto) return;
    const interval = setInterval(() => { if (!document.hidden) void startRef.current(); }, 30000);
    return () => clearInterval(interval);
  }, [auto]);
  async function introduce() {
    if (!current() || requestBusy.current || active || !connected || !lab) return;
    requestBusy.current = true; setAction('injecting'); setError(null); setNotice(null); setAuto(false);
    try {
      const state = await liveApi.introduce(session, fault);
      if (!current()) return;
      setLab(state); setSelectedTarget(state.targetId);
      if (fault === 'login_401') {
        setAuto(false);
        setNotice('Login test ready. Enter the username and password yourself. Rejected credentials will appear in Investigation.');
        return;
      }
      await beginRun(state.targetId);
      if (current()) setNotice(fault === 'healthy' ? 'Healthy baseline started. Inspect the completed checks below.' : 'Test fault introduced. The live check is capturing its response and customer journey evidence.');
    } catch (cause) { if (current()) setError(message(cause, 'The test fault could not be introduced.')); }
    finally { if (current()) { requestBusy.current = false; setAction(null); } }
  }
  async function restore() {
    if (!current() || requestBusy.current || active || !connected || !lab) return;
    requestBusy.current = true; setAction('restoring'); setError(null); setNotice(null); setAuto(false);
    try { const state = await liveApi.introduce(session, 'healthy'); if (current()) { setLab(state); setNotice('Test site restored. Use Verify after repair on a failed run to verify and resolve its incident.'); } }
    catch (cause) { if (current()) setError(message(cause, 'The test website could not be restored.')); }
    finally { if (current()) { requestBusy.current = false; setAction(null); } }
  }
  async function verify(recover: boolean) {
    if (!current() || requestBusy.current || active || !connected || !selectedRun) return;
    const failureId = selectedRun.id;
    requestBusy.current = true; setAction('recovering'); setError(null); setNotice(null); setAuto(false);
    try {
      const result = await (recover ? liveApi.recover(session, failureId) : liveApi.verify(session, failureId));
      if (!current()) return;
      setNotice(result.status === 'verified' ? 'Recovery verified with a separate real check. The original failed run remains selected.' : 'The verification check failed. The incident remains open; inspect the latest evidence.');
      await refresh();
    } catch (cause) { if (current()) setError(message(cause, 'The repair could not be verified.')); }
    finally { if (current()) { requestBusy.current = false; setAction(null); } }
  }
  async function select(id: string) {
    selectedIdRef.current = id; setRunId(id); setError(null);
    const stored = runs.find(item => item.id === id);
    if (stored) { setSelectedRun(stored); return; }
    setSelectedRun(null);
    try { const detail = await liveApi.run(session, id); if (current() && selectedIdRef.current === id) setSelectedRun(detail); }
    catch (cause) { if (current() && selectedIdRef.current === id) setError(message(cause, 'Unable to inspect this live test.')); }
  }

  const completed = runs.filter(run => run.status === 'passed' || run.status === 'failed');
  const passed = completed.filter(run => run.status === 'passed').length;
  const average = completed.length ? completed.reduce((sum, run) => sum + run.durationMs, 0) / completed.length : 0;
  const target = targets.find(item => item.id === selectedTarget);
  const points = [...completed].reverse().map(run => ({ runId: run.id, timestamp: run.startedAt, durationMs: run.durationMs, passed: run.status === 'passed' }));
  const verification = runs.find(run => run.id === selectedRun?.recovery?.verificationRunId) || null;
  const canRestore = selectedRun?.targetId === lab?.targetId && selectedRun?.labRevision === lab?.revision && lab?.fault !== 'healthy';

  return <div className="live-page">
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{selectedRun?.completedAt ? `Selected live check ${selectedRun.status}. ${selectedRun.httpStatus === null ? 'No HTTP response' : `HTTP ${selectedRun.httpStatus}`}. Duration ${duration(selectedRun.durationMs)}.` : active ? 'Live check in progress.' : 'Choose a website to run a live check.'}</p>
    <section className="live-hero"><SectionLabel>LIVE WEBSITE CHECKS</SectionLabel><h1>Detect the interruption.<br/>Understand the recovery.</h1><p>Check approved websites and customer journeys, explain failures using captured evidence, and verify the fix. Introduce controlled errors on your isolated test website to see the complete workflow.</p></section>
    {error ? <div className="feedback error" role="alert"><TriangleAlert size={18}/><span>{error}</span><button className="text-button" onClick={() => void load()}>Retry</button><button className="icon-button" aria-label="Dismiss live test error" onClick={() => setError(null)}><X size={16}/></button></div> : null}
    {notice ? <div className="feedback notice" role="status"><CheckCircle2 size={18}/><span>{notice}</span><button className="icon-button" aria-label="Dismiss live test notice" onClick={() => setNotice(null)}><X size={16}/></button></div> : null}
    <div className="metric-row live-metrics"><div className="metric"><div className="metric-title"><span>Live success rate</span><ShieldCheck size={16} className="cyan"/></div><strong>{completed.length ? `${Math.round(passed / completed.length * 100)}%` : '—'}</strong><span className="metric-foot">{completed.length ? `${passed} of ${completed.length} completed checks` : 'Awaiting the first live check'}</span></div><div className="metric"><div className="metric-title"><span>Average check duration</span><Timer size={16} className="blue"/></div><strong>{completed.length ? duration(average) : '—'}</strong><span className="metric-foot">Measured website and journey checks</span></div><div className="metric"><div className="metric-title"><span>Failed checks</span><TriangleAlert size={16} className="amber"/></div><strong>{completed.length ? completed.length - passed : '0'}</strong><span className="metric-foot">HTTP, content or business outcome failures</span></div><div className="metric"><div className="metric-title"><span>Approved targets</span><Globe2 size={16} className="cyan"/></div><strong>{loading ? '—' : targets.length}</strong><span className="metric-foot">Includes the isolated fault lab</span></div></div>
    <LiveLabControl lab={lab} fault={fault} busy={active} connected={connected} onFault={setFault} onIntroduce={() => void introduce()} onRestore={() => void restore()}/>
    {fault === 'login_401' ? <section className="panel login-live-panel"><div className="panel-header"><div><SectionLabel>MANUAL LOGIN TEST</SectionLabel><h2>Try the login yourself</h2></div><ShieldCheck size={20}/></div><LoginForm key={`${session}:live-login`} session={session} source="live_test" labRevision={lab?.fault === 'login_401' ? lab.revision : undefined} connected={connected} onCompleted={() => workspace.refresh()}/></section> : null}
    <div className="live-main-grid"><section className="panel live-target-panel"><div className="panel-header"><div><img src="/assets/figma/live-globe.svg" width={20} height={20} alt="" aria-hidden="true"/><h2>Choose an approved website</h2></div></div>
      {loading && !targets.length ? <EmptyState icon={Loader2} title="Loading approved targets">The server decides which websites can be tested.</EmptyState> : targets.length ? <div className="live-target-list">{targets.map(item => <button key={item.id} disabled={active} aria-pressed={item.id === selectedTarget} className={`live-target ${item.id === selectedTarget ? 'selected' : ''}`} onClick={() => setSelectedTarget(item.id)}><span className="live-target-icon"><Globe2 size={19}/></span><span><strong>{item.name}</strong><small>{hostname(item.url)}</small><code>{item.url}</code></span><span className="radio-dot"/></button>)}</div> : <EmptyState icon={Globe2} title="No live targets available">Reconnect to the backend to load the controlled test website and approved targets.</EmptyState>}
      {target ? <div className="live-target-assertions"><span><Check size={13}/> Expected HTTP {target.expectedStatus}</span>{target.containsText ? <span><FileSearch size={13}/> Content includes <code>{target.containsText}</code></span> : <span><FileSearch size={13}/> Status and timing check</span>}</div> : null}
      <div className="live-execution-controls"><button className="primary-button" disabled={!configured || !selectedTarget || active || !connected} onClick={() => void start()}>{active ? <Loader2 className="spin" size={17}/> : <Play size={16} fill="currentColor"/>}{action === 'recovering' ? 'Verifying repair…' : action ? 'Starting live check…' : active ? 'Live check in progress…' : 'Run live test'}<ArrowRight size={16}/></button><div className="auto-control"><span><Clock3 size={15}/><span>Check every 30 seconds<small>Visible tab only · Independent observer below</small></span></span><button type="button" role="switch" aria-checked={auto} aria-label="Auto-run approved live target every 30 seconds" className={`switch ${auto ? 'on' : ''}`} disabled={!configured || !connected || !!action} onClick={() => setAuto(value => !value)}><span/></button></div></div>
    </section><section className="panel live-result"><div className="panel-header"><h2>The actual response</h2>{selectedRun ? <Badge status={selectedRun.status}/> : <Badge status="idle">{action ? 'Starting' : 'Ready'}</Badge>}</div>
      {selectedRun ? <><div className="live-result-url"><Globe2 size={15}/><code>{selectedRun.url}</code><a href={selectedRun.url} target="_blank" rel="noreferrer" aria-label="Open tested target"><ExternalLink size={14}/></a></div><div className="live-response-overview"><div><span>HTTP STATUS</span><strong className={selectedRun.status === 'passed' ? 'cyan' : selectedRun.status === 'failed' ? 'danger-text' : ''}>{selectedRun.httpStatus ?? '—'}</strong></div><div><span>CHECK DURATION</span><strong>{selectedRun.completedAt ? duration(selectedRun.durationMs) : 'Checking…'}</strong></div><div><span>RESPONSE SIZE</span><strong>{selectedRun.completedAt ? `${selectedRun.evidence.responseBytes.toLocaleString()} B` : '—'}</strong></div></div><p className="live-result-message">{selectedRun.message || 'The server is checking the approved website…'}</p>{selectedRun.error ? <p className="live-result-error"><TriangleAlert size={14}/>{selectedRun.error}</p> : null}<div className="live-result-assertions">{selectedRun.assertions.map(assertion => <div key={assertion.code} className={assertion.passed ? 'passed' : 'failed'}>{assertion.passed ? <CheckCircle2 size={17}/> : <X size={17}/>}<span><strong>{assertion.code.replace(/_/g, ' ').toLowerCase()}</strong><small>Expected: {assertion.expected}<br/>Observed: {assertion.actual}</small></span></div>)}</div><div className="panel-footer"><span>{time(selectedRun.startedAt)} · Website and configured journey checks</span><span>RUN {shortId(selectedRun.id)}</span></div></> : <div className="live-response-empty"><h3>{action ? 'Starting a live check…' : 'Ready for your first check.'}</h3><p>{action ? 'The server is preparing the selected website checks.' : 'The status, duration and assertions appear here after a real request.'}</p><div className="live-response-overview"><div><span>HTTP STATUS</span><strong>—</strong></div><div><span>CHECK DURATION</span><strong>—</strong></div><div><span>RESPONSE SIZE</span><strong>—</strong></div></div></div>}
    </section></div>
    {selectedRun?.diagnosis ? <LiveInvestigation run={selectedRun} verification={verification} canRestore={canRestore} busy={active} connected={connected} onRecover={() => void verify(true)} onVerify={() => void verify(false)} onSelect={id => void select(id)}/> : null}
    {selectedRun ? <LiveTracePanel run={selectedRun}/> : null}
    <LiveObserver observer={observer} error={observerError} onRefresh={() => void refreshObserver()}/>
    <div className="live-secondary-grid"><section className="panel trend-panel"><div className="panel-header"><div><SectionLabel>LIVE PERFORMANCE HISTORY</SectionLabel><h2>Check duration</h2></div><span className="small-meta">{completed.length} completed checks</span></div>{points.length ? <Suspense fallback={<div className="chart-loading"><Loader2 size={21} className="spin"/></div>}><LatencyChart points={points}/></Suspense> : <EmptyState icon={Timer} title="Measure your first baseline">Charts populate from completed live requests and journeys.</EmptyState>}</section><section className="panel"><div className="panel-header"><div><SectionLabel>SESSION EXECUTIONS</SectionLabel><h2>Recent live checks</h2></div><button className="text-button" onClick={() => void refresh()}><RefreshCw size={13}/> Refresh</button></div>{runs.length ? <div className="runs-list live-runs-list">{runs.slice(0, 12).map(run => <button key={run.id} aria-pressed={run.id === selectedRun?.id} aria-label={`Inspect ${run.status} check from ${time(run.startedAt)}, ${run.httpStatus === null ? 'no HTTP status yet' : `HTTP ${run.httpStatus}`}`} className={`run-item ${run.id === selectedRun?.id ? 'selected' : ''}`} onClick={() => void select(run.id)}><span className={`run-status-icon ${run.status}`}>{run.status === 'passed' ? <Check size={15}/> : run.status === 'failed' ? <X size={15}/> : <Loader2 size={15} className="spin"/>}</span><span className="run-description"><strong>{targets.find(item => item.id === run.targetId)?.name || hostname(run.url)}</strong><small>{time(run.startedAt)} · {run.httpStatus === null ? run.status : `HTTP ${run.httpStatus}`}{run.incidentStatus === 'resolved' ? ' · Recovery verified' : ''}</small></span><span className="run-time">{run.completedAt ? duration(run.durationMs) : 'Running'}</span><ArrowUpRight size={15}/></button>)}</div> : <EmptyState icon={Radio} title="No live checks yet">The isolated test website lets you run real checks and deliberate faults safely.</EmptyState>}</section></div>
    {selectedRun?.completedAt ? <section className="panel live-evidence"><div className="panel-header"><div><SectionLabel>RESPONSE EVIDENCE</SectionLabel><h2>{selectedRun.evidence.title || 'Captured response excerpt'}</h2></div>{selectedRun.fingerprint ? <span className="live-fingerprint"><FileSearch size={13}/>{selectedRun.fingerprint}</span> : null}</div><pre>{selectedRun.evidence.excerpt || 'No response body was captured for this request.'}</pre><div className="panel-footer"><span>Response excerpts are displayed as text.</span><span>{lastUpdated ? `SYNCED ${time(lastUpdated.toISOString())}` : 'Awaiting refresh'}</span></div></section> : null}
  </div>;
}
