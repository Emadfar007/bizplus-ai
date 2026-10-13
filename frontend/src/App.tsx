import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Activity, ArrowRight, ArrowUpRight, Check, CheckCircle2, ChevronRight, CircleDot, FileSearch, FlaskConical, GitBranch, Globe2, LayoutDashboard, Loader2, LockKeyhole, Menu, RefreshCw, RotateCcw, ShieldCheck, ShoppingBag, Sparkles, Terminal, TriangleAlert, X } from 'lucide-react';
import type { Incident } from '@bizplus/shared';
import { useWorkspace, type Workspace } from './hooks/useWorkspace';
import { api } from './services/api';
import { Badge, EmptyState, EvidencePanel, IncidentSummary, Journey, MetricRow, RunList, ScenarioControl, SectionLabel, shortId, StepComparison, time, TrendPanel } from './components/UI';
import Shop from './pages/Shop';
import LiveTests from './pages/LiveTests';
import Login from './pages/Login';
import LoginRecovery from './components/LoginRecovery';

function Brand() { return <Link to="/" className="brand"><span className="brand-mark"><Activity size={27}/></span><span>BizPlus <strong>AI</strong><small>BUSINESS RELIABILITY</small></span></Link>; }
const NAVIGATION = [{ to: '/', title: 'Overview', icon: LayoutDashboard }, { to: '/login', title: 'Login', icon: LockKeyhole }, { to: '/workflows', title: 'Workflows', icon: GitBranch }, { to: '/incidents', title: 'Investigation', icon: FileSearch }, { to: '/recovery', title: 'Recovery', icon: ShieldCheck }, { to: '/shop', title: 'Storefront', icon: ShoppingBag }, { to: '/live-tests', title: 'Live tests', icon: Globe2 }];

export default function App() {
  const workspace = useWorkspace();
  const [menuOpen, setMenuOpen] = useState(false);
  const [compactView, setCompactView] = useState(() => window.matchMedia('(max-width:980px)').matches);
  const [resetDialog, setResetDialog] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const storefrontView = location.pathname.startsWith('/shop');
  const liveView = location.pathname.startsWith('/live-tests');
  const investigate = (id: string) => navigate(`/incidents/${id}`);
  const historyPolicy = workspace.metrics?.historyPolicy || workspace.health?.historyPolicy;
  const historyLabel = historyPolicy === 'cloud' ? 'Cloud history · saved in PostgreSQL' : historyPolicy === 'temporary' ? 'Temporary history · resets when the hosted service restarts' : historyPolicy === 'local' ? 'Local history · saved on this machine' : 'History status available when the engine connects';
  const routeTitle = NAVIGATION.find(item => item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to))?.title || 'Workspace';
  const closeMenu = () => {
    setMenuOpen(false);
    requestAnimationFrame(() => menuTriggerRef.current?.focus());
  };
  useEffect(() => {
    const media = window.matchMedia('(max-width:980px)');
    const update = () => { setCompactView(media.matches); if (!media.matches) setMenuOpen(false); };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      window.scrollTo({ top:0, left:0, behavior:'instant' });
      const target = mainRef.current?.querySelector<HTMLElement>('h1') || mainRef.current;
      target?.setAttribute('tabindex', '-1');
      target?.focus({ preventScroll: true });
    });
    document.title = `${routeTitle} · BizPlus AI`;
    return () => cancelAnimationFrame(frame);
  }, [location.pathname, routeTitle]);
  useEffect(() => {
    if (!menuOpen || !compactView) return;
    sidebarRef.current?.querySelector<HTMLButtonElement>('.sidebar-close')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeMenu(); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>('a[href],button:not(:disabled)') || []).filter(item => item.getClientRects().length);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [menuOpen, compactView]);
  useEffect(() => {
    if (!resetDialog) return;
    const priorFocus = document.activeElement as HTMLElement | null;
    const controls = modalRef.current?.querySelectorAll<HTMLButtonElement>('button');
    controls?.[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setResetDialog(false);
      if (event.key === 'Tab' && controls?.length) {
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); requestAnimationFrame(() => { if (priorFocus?.getClientRects().length && !priorFocus.closest('[inert]')) priorFocus.focus(); else (menuTriggerRef.current?.getClientRects().length ? menuTriggerRef.current : mainRef.current)?.focus(); }); };
  }, [resetDialog]);
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <span className="sr-only" role="status" aria-live="polite">{routeTitle}</span>
    {menuOpen ? <button className="sidebar-scrim" aria-label="Close menu" onClick={closeMenu}/> : null}
    <aside ref={sidebarRef} id="workspace-navigation" inert={resetDialog || compactView && !menuOpen} role={compactView && menuOpen ? 'dialog' : undefined} aria-modal={compactView && menuOpen ? true : undefined} aria-label="Workspace navigation" className={`sidebar ${menuOpen ? 'mobile-open' : ''}`}>
      <Brand/><button className="sidebar-close icon-button" aria-label="Close menu" onClick={closeMenu}><X size={20}/></button>
      <nav aria-label="Main navigation">{['Monitor', 'Explore'].map((group, index) => <div className="navigation-group" key={group}><SectionLabel>{group}</SectionLabel>{NAVIGATION.slice(index === 0 ? 0 : 5, index === 0 ? 5 : NAVIGATION.length).map(item => <NavLink key={item.to} to={item.to} end={item.to === '/'} onClick={() => setMenuOpen(false)} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><item.icon size={20} strokeWidth={1.8}/><span>{item.title}</span>{item.to === '/incidents' && workspace.metrics?.openIncidents ? <span className="nav-count">{workspace.metrics.openIncidents}</span> : null}</NavLink>)}</div>)}</nav>
      <div className="sidebar-engine"><strong>Evidence you can trust.</strong><p>Every diagnosis links to the response and logs.</p><span className="engine-label"><CircleDot size={14}/> Rules-based diagnosis</span></div>
      <div className="sidebar-bottom"><div><span className="sidebar-dot"/>{historyPolicy === 'cloud' ? 'Cloud history' : historyPolicy === 'local' ? 'Local history' : 'Temporary hosted history'}</div><button className="secondary-button" disabled={workspace.active} onClick={() => { setMenuOpen(false); setResetDialog(true); }}><RotateCcw size={16}/> Fresh demo session</button><code>SESSION {shortId(workspace.session)}</code></div>
    </aside>
    <div className="main-shell" inert={resetDialog || compactView && menuOpen}>
      <header className="topbar"><div className="breadcrumb"><button ref={menuTriggerRef} className="mobile-menu icon-button" aria-label="Open menu" aria-expanded={menuOpen} aria-controls="workspace-navigation" onClick={() => setMenuOpen(true)}><Menu size={20}/></button><span>Demo workspace</span><ChevronRight size={14}/><strong>{routeTitle}</strong></div><div className="topbar-right"><span className="demo-tag"><FlaskConical size={14}/>{storefrontView ? 'RAZORPAY TEST MODE' : liveView ? 'LIVE HTTPS' : 'SANDBOX'}</span><span className={`connection-status ${workspace.connection}`}><span/>{workspace.connection === 'ready' ? 'Engine online' : workspace.connection === 'connecting' ? 'Waking engine' : 'Engine offline'}</span></div></header>
      <main ref={mainRef} id="main-content" tabIndex={-1}>
        {workspace.connection !== 'ready' ? <div className={`connection-banner ${workspace.connection}`} role="status">{workspace.connection === 'connecting' ? <Loader2 size={18} className="spin"/> : <TriangleAlert size={18}/>}<div><strong>{workspace.connection === 'connecting' ? 'Connecting to the monitoring engine…' : 'The monitoring engine is unavailable'}</strong><p>{workspace.connection === 'connecting' ? 'Free hosting may take about a minute to wake. We’ll retry for up to two minutes; tests unlock when it is ready.' : 'Confirm the backend is running, or retry the connection. You can also use the local presentation fallback.'}</p></div>{workspace.connection === 'offline' ? <button className="secondary-button" onClick={workspace.reconnect}><RefreshCw size={14}/> Retry connection</button> : null}</div> : null}
        {workspace.error ? <div className="feedback error" role="alert"><TriangleAlert size={18}/><span>{workspace.error}</span><button className="text-button" onClick={() => void workspace.refresh()}>Retry</button><button className="icon-button" aria-label="Dismiss error" onClick={workspace.clearError}><X size={16}/></button></div> : null}
        {workspace.notice ? <div className="feedback notice" role="status"><CheckCircle2 size={18}/><span>{workspace.notice}</span><button className="icon-button" aria-label="Dismiss message" onClick={workspace.clearNotice}><X size={16}/></button></div> : null}
        <Routes>
          <Route path="/" element={<Overview workspace={workspace} investigate={investigate}/>}/>
          <Route path="/login" element={<Login key={workspace.session} workspace={workspace}/>}/>
          <Route path="/workflows" element={<Workflows workspace={workspace} investigate={investigate}/>}/>
          <Route path="/incidents" element={<Investigation workspace={workspace}/>}/>
          <Route path="/incidents/:id" element={<Investigation workspace={workspace}/>}/>
          <Route path="/recovery" element={<Recovery workspace={workspace}/>}/>
          <Route path="/recovery/:id" element={<Recovery workspace={workspace}/>}/>
          <Route path="/shop" element={<Shop key={workspace.session} workspace={workspace}/>}/>
          <Route path="/live-tests" element={<LiveTests key={workspace.session} workspace={workspace}/>}/>
          <Route path="*" element={<EmptyState title="This view could not be found"><Link to="/">Return to the overview</Link></EmptyState>}/>
        </Routes>
        <footer className="app-footer"><span><ShieldCheck size={13}/>{storefrontView ? 'Razorpay Test Mode. Store orders are separate from synthetic runs.' : liveView ? 'Approved owned websites. Actual HTTPS checks. Measured outcomes.' : 'Synthetic data. Simulated payments. Verified outcomes.'}</span><span>{historyLabel} <span className="footer-separator">/</span> {workspace.lastUpdated ? `Synced ${workspace.lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Waiting for connection'}</span></footer>
      </main>
    </div>
    {resetDialog ? <div className="modal-backdrop" onClick={() => setResetDialog(false)}><div ref={modalRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="reset-title" onClick={event => event.stopPropagation()}><span className="modal-icon"><RotateCcw size={23}/></span><h2 id="reset-title">Start a fresh demo?</h2><p>A new session gives you an empty dashboard and independent test transactions. Previous runs and orders remain in their existing session; this starts an independent demo.</p><div className="modal-actions"><button className="secondary-button" onClick={() => setResetDialog(false)}>Keep this session</button><button className="primary-button" onClick={() => { workspace.resetSession(); navigate('/'); setResetDialog(false); }}>Start fresh <ArrowRight size={15}/></button></div></div></div> : null}
  </div>;
}

function DemoGuide({ stage = 1 }: { stage?: number }) {
  const labels = ['Run test', 'Investigate', 'Approve', 'Verified'];
  return <ol className="demo-guide" aria-label="Demo journey">{labels.map((label, index) => <li key={label} className={index + 1 === stage ? 'current' : index + 1 < stage ? 'complete' : ''} aria-current={index + 1 === stage ? 'step' : undefined}><span>{index + 1 < stage ? <Check size={14}/> : index + 1}</span><strong>{label}</strong></li>)}</ol>;
}
function Overview({ workspace, investigate }: { workspace: Workspace; investigate: (id: string) => void }) {
  const latestIncident = workspace.incidentList.incidents.find(item => item.status !== 'resolved');
  return <>
    <PageHeading eyebrow="BUSINESS RELIABILITY" title="Business monitor" description="Start with a healthy test, then try a failure. We’ll guide you from detection to verified recovery."/>
    <DemoGuide/>
    {latestIncident ? <div className="attention-banner"><TriangleAlert size={20}/><div><strong>{latestIncident.title}</strong><p>{workspace.metrics?.openIncidents || 1} open incident{(workspace.metrics?.openIncidents || 1) === 1 ? '' : 's'} · Evidence is ready to inspect.</p></div><button className="secondary-button" onClick={() => investigate(latestIncident.id)}>Investigate <ArrowRight size={16}/></button></div> : null}
    <div className="primary-grid"><ScenarioControl workspace={workspace}/><Journey run={workspace.run} workflowName={workspace.workflows[0]?.name} onInvestigate={investigate}/></div>
    <MetricRow metrics={workspace.metrics}/>
    <div className="secondary-grid"><TrendPanel metrics={workspace.metrics}/><RunList runs={workspace.metrics?.recentRuns || []} selectedId={workspace.run?.id} onSelect={id => void workspace.selectRun(id)}/></div>
    {workspace.incidentList.incidents.length ? <section className="incident-strip"><div className="section-heading"><h2>Signals to investigate</h2><Link to="/incidents" className="text-button">All incidents <ArrowUpRight size={16}/></Link></div>{workspace.incidentList.incidents.slice(0, 2).map(incident => <IncidentSummary key={incident.id} incident={incident} onOpen={() => investigate(incident.id)}/>)}</section> : null}
  </>;
}
function Workflows({ workspace, investigate }: { workspace: Workspace; investigate: (id: string) => void }) {
  return <><PageHeading eyebrow="WORKFLOW EXPLORER" title="Customer checkout journey" description="Every step sends a real HTTP request to the commerce sandbox. Select a completed step to inspect what was expected and what happened."/><div className="workflow-definition"><span className="workflow-icon"><GitBranch size={24}/></span><div><h2>{workspace.workflows[0]?.name || 'Commerce checkout'}</h2><p>Authentication → available stock → cart → simulated payment → confirmed order</p></div><Badge status="idle">5 sequential steps</Badge></div><DemoGuide/><div className="primary-grid"><ScenarioControl workspace={workspace}/><Journey run={workspace.run} workflowName={workspace.workflows[0]?.name} onInvestigate={investigate}/></div>{workspace.run ? <div className="run-metadata"><span>RUN <code>{workspace.run.id}</code></span><span>TRANSACTION <code>{workspace.run.transactionId || 'Not created'}</code></span><span>PAYMENTS <strong>{workspace.run.paymentCount}</strong></span></div> : null}<div className="secondary-grid"><TrendPanel metrics={workspace.metrics}/><RunList runs={workspace.metrics?.recentRuns || []} selectedId={workspace.run?.id} onSelect={id => void workspace.selectRun(id)}/></div></>;
}
function PageHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) { return <div className="page-heading"><SectionLabel>{eyebrow}</SectionLabel><h1>{title}</h1><p>{description}</p></div>; }

function useSelectedIncident(workspace: Workspace) {
  const { id } = useParams();
  const [remote, setRemote] = useState<{ incident: Incident; session: string } | null>(null);
  const [missing, setMissing] = useState(false);
  const incidents = workspace.incidentList.incidents;
  const selected = incidents.find(item => item.id === id) || (!id ? incidents.find(item => item.id === workspace.run?.incidentId) || incidents[0] : null);
  useEffect(() => {
    setRemote(null); setMissing(false);
    if (!id || selected || workspace.connection !== 'ready') return;
    let cancelled = false;
    const requestedSession = workspace.session;
    api.incident(requestedSession, id).then(incident => { if (!cancelled && workspace.isCurrentSession(requestedSession)) setRemote({ incident, session: requestedSession }); }).catch(() => { if (!cancelled && workspace.isCurrentSession(requestedSession)) setMissing(true); });
    return () => { cancelled = true; };
  }, [id, !!selected, workspace.connection, workspace.session, workspace.isCurrentSession]);
  return { incident: selected || (remote?.session === workspace.session && remote.incident.id === id ? remote.incident : null), missing, id };
}
function Investigation({ workspace }: { workspace: Workspace }) {
  const { incident, missing, id } = useSelectedIncident(workspace);
  const navigate = useNavigate();
  return <><PageHeading eyebrow="INCIDENT INVESTIGATION" title="Investigate the outcome" description="Inspect responses and assertions, connect recurring failures, and separate observed facts from possible causes."/><DemoGuide stage={2}/>{workspace.incidentList.incidents.length ? <div className="incident-selector">{workspace.incidentList.incidents.map(item => <button key={item.id} aria-pressed={item.id === incident?.id} className={item.id === incident?.id ? 'selected' : ''} onClick={() => navigate(`/incidents/${item.id}`)}><Badge status={item.status}/><span>{item.title}</span><code>{shortId(item.id)}</code></button>)}</div> : null}{incident ? <>
    <div className={`incident-heading ${incident.status}`}><span className="large-status-icon">{incident.status === 'resolved' ? <ShieldCheck size={25}/> : <TriangleAlert size={25}/>}</span><div><SectionLabel>INCIDENT {shortId(incident.id)}</SectionLabel><h2>{incident.title}</h2><p>Detected at {time(incident.createdAt)} · Workflow run {shortId(incident.runId)}</p></div><Badge status={incident.status}/></div>
    <div className="diagnosis-grid"><section className="panel diagnosis-panel"><div className="panel-header"><div><SectionLabel>EVIDENCE-LINKED EXPLANATION</SectionLabel><h2>Diagnosis</h2></div><span className="rules-tag"><Sparkles size={13}/> Rules-based diagnosis</span></div><p className="diagnosis-summary">{incident.diagnosis.summary}</p><div className="facts-causes"><div><h3><CheckCircle2 size={16}/> Observed facts</h3>{incident.diagnosis.observedFacts.map((fact, index) => <p key={index}><span/> {fact}</p>)}</div><div><h3><FileSearch size={16}/> Possible causes</h3>{incident.diagnosis.possibleCauses.map((cause, index) => <p key={index}><span/> {cause}</p>)}<small>Possible causes are hypotheses; the evidence determines what is confirmed.</small></div></div><div className="evidence-references"><span>SUPPORTING EVIDENCE</span>{incident.diagnosis.evidenceIds.map(item => <a key={item} href="#captured-evidence"><FileSearch size={12}/>{shortId(item)}</a>)}</div></section><section className="panel action-panel"><div className="panel-header"><div><SectionLabel>SAFE NEXT STEP</SectionLabel><h2>{incident.status === 'resolved' ? 'Outcome recovered' : incident.login ? 'Manual login recovery' : incident.diagnosis.recommendedAction ? 'Recovery available' : 'Investigation required'}</h2></div><ShieldCheck size={21} className="cyan"/></div><p>{incident.diagnosis.guidance}</p>{incident.login ? <><div className="safe-action"><LockKeyhole size={15}/><span>You control this login<small>Only your successful retry can resolve it</small></span></div><button className="primary-button" onClick={() => navigate(`/recovery/${incident.id}`)}>{incident.status === 'resolved' ? 'View login verification' : 'Enter correct credentials'}<ArrowRight size={16}/></button></> : incident.diagnosis.recommendedAction ? <><div className="safe-action"><Check size={15}/><span>Use the original order<small>Checkout will not be repeated</small></span></div><button className="primary-button" onClick={() => navigate(`/recovery/${incident.id}`)}>{incident.status === 'resolved' ? 'View verified recovery' : 'Review recovery'}<ArrowRight size={16}/></button></> : <div className="guidance-note"><Terminal size={17}/><span>This failure needs investigation. No automatic recovery is offered.</span></div>}</section></div>
    <details className="technical-details"><summary>Technical details & related failures</summary><div className="fingerprint-panel"><div><GitBranch size={18}/><span><strong>Failure fingerprint</strong><code>{incident.fingerprint}</code></span></div><span className="small-meta">{incident.relatedIncidentIds.length} related incident{incident.relatedIncidentIds.length === 1 ? '' : 's'} in this session</span></div>{incident.relatedIncidentIds.length ? <div className="related-incidents">{incident.relatedIncidentIds.map(relatedId => <button className="text-button" key={relatedId} onClick={() => navigate(`/incidents/${relatedId}`)}><FileSearch size={14}/>{shortId(relatedId)}<ArrowUpRight size={13}/></button>)}</div> : null}</details><div id="captured-evidence"><EvidencePanel evidence={incident.evidence}/></div>
  </> : <EmptyState icon={FileSearch} title={missing ? 'This incident is unavailable' : id && workspace.connection === 'ready' ? 'Loading incident…' : 'No incidents to investigate'}>{missing ? 'This incident belongs to another session or hosted history has reset. Run a new test to collect fresh evidence.' : 'Run either failure scenario to see the failed assertion, response evidence, and diagnosis here.'}<Link to="/" className="text-button">Go to the demo <ArrowRight size={15}/></Link></EmptyState>}</>;
}
function Recovery({ workspace }: { workspace: Workspace }) {
  const { incident, missing } = useSelectedIncident(workspace);
  const navigate = useNavigate();
  const currentSourceRun = workspace.run?.id === incident?.runId ? workspace.run : null;
  const [sourceRun, setSourceRun] = useState(currentSourceRun);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState(false);
  const [sourceRetry, setSourceRetry] = useState(0);
  useEffect(() => {
    setSourceError(false);
    if (!incident) { setSourceRun(null); setSourceLoading(false); return; }
    if (currentSourceRun) { setSourceRun(currentSourceRun); setSourceLoading(false); return; }
    let cancelled = false;
    const requestedSession = workspace.session;
    setSourceLoading(true);
    api.run(requestedSession, incident.runId).then(run => { if (!cancelled && workspace.isCurrentSession(requestedSession)) setSourceRun(run); }).catch(() => { if (!cancelled && workspace.isCurrentSession(requestedSession)) { setSourceRun(null); setSourceError(true); } }).finally(() => { if (!cancelled && workspace.isCurrentSession(requestedSession)) setSourceLoading(false); });
    return () => { cancelled = true; };
  }, [incident?.runId, currentSourceRun, workspace.session, workspace.isCurrentSession, sourceRetry]);
  const recovery = incident?.recovery;
  const matchedRun = sourceRun?.id === incident?.runId ? sourceRun : null;
  const failedStep = matchedRun?.steps.find(step => step.id === incident?.failedStepId);
  const eligible = !!incident?.diagnosis.recommendedAction;
  if (incident?.login) return <LoginRecovery key={`${workspace.session}:${incident.id}`} workspace={workspace} incident={incident} originalStep={failedStep} loading={sourceLoading} evidenceError={sourceError} onRetryEvidence={() => setSourceRetry(value => value + 1)}/>;
  return <><PageHeading eyebrow="VERIFIED RECOVERY" title="Verify the recovery" description="Approve one controlled action, then verify the original order. The failed execution remains intact for comparison."/><DemoGuide stage={incident?.status === 'resolved' ? 4 : 3}/>{workspace.incidentList.incidents.length ? <div className="incident-selector">{workspace.incidentList.incidents.map(item => <button key={item.id} aria-pressed={item.id === incident?.id} className={item.id === incident?.id ? 'selected' : ''} onClick={() => navigate(`/recovery/${item.id}`)}><Badge status={item.status}/><span>{item.title}</span><code>{shortId(item.id)}</code></button>)}</div> : null}{incident ? <><div className={`recovery-banner ${incident.status}`}><div className="large-status-icon">{incident.status === 'resolved' ? <ShieldCheck size={26}/> : <RotateCcw size={24}/>}</div><div><SectionLabel>{incident.status === 'resolved' ? 'RECOVERY VERIFIED' : 'CONTROLLED REMEDIATION'}</SectionLabel><h2>{incident.status === 'resolved' ? 'Original order confirmed. One payment.' : eligible ? 'Resume the confirmation worker.' : 'This failure has no safe recovery action.'}</h2><p>{incident.status === 'resolved' ? 'The business assertion passed after recovery. Checkout was never repeated.' : incident.diagnosis.guidance}</p></div><Badge status={incident.status}/></div>
    {sourceLoading ? <div className="feedback notice" role="status"><Loader2 size={18} className="spin"/> Loading the original evidence…</div> : sourceError ? <div className="feedback error" role="alert"><TriangleAlert size={18}/><span>The original execution could not be loaded.</span><button className="secondary-button" onClick={() => setSourceRetry(value => value + 1)}>Retry evidence</button></div> : null}<div className="recovery-grid"><section className="panel approval-panel"><div className="panel-header"><div><SectionLabel>APPROVAL REQUIRED</SectionLabel><h2>Recovery action</h2></div><ShieldCheck size={20} className="cyan"/></div><div className="recovery-action-title"><span><RotateCcw size={19}/></span><strong>{eligible ? 'Resume receipt worker' : 'Investigate checkout service'}</strong></div><p>{eligible ? 'Resume only this transaction’s paused confirmation worker and retrieve the original order again.' : 'The checkout returned HTTP 500 before payment. Inspect the error evidence and service logs, then run a fresh test when the service is healthy.'}</p><div className="recovery-guardrails">{eligible ? <><span><Check size={14}/> Original order preserved</span><span><Check size={14}/> No repeat checkout</span><span><Check size={14}/> Unique payment key enforced</span></> : <><span><Check size={14}/> No payment was created</span><span><Check size={14}/> Confirmation was skipped</span></>}</div>{eligible ? <button className="primary-button" disabled={workspace.connection !== 'ready' || workspace.active || sourceLoading || sourceError || !matchedRun || incident.status === 'resolved' || incident.status === 'recovering' || !!matchedRun && ['running', 'queued'].includes(matchedRun.status)} onClick={() => void workspace.recover(incident.id)}>{workspace.recovering || incident.status === 'recovering' ? <Loader2 className="spin" size={17}/> : incident.status === 'resolved' ? <CheckCircle2 size={17}/> : <ShieldCheck size={17}/>} {incident.status === 'resolved' ? 'Recovery verified' : workspace.recovering ? 'Verifying original order…' : 'Approve recovery'}{incident.status !== 'resolved' && !workspace.recovering ? <ArrowRight size={16}/> : null}</button> : <button className="secondary-button" onClick={() => navigate(`/incidents/${incident.id}`)}>View investigation <ArrowUpRight size={15}/></button>}<small className="approval-note">Approval is an explicit demo action. Only this owned sandbox transaction can be changed.</small></section><div className="comparison-grid"><StepComparison label="BEFORE · ORIGINAL FAILURE" step={failedStep} variant="before"/><StepComparison label="AFTER · RECOVERY VERIFICATION" step={recovery?.verification} variant="after"/></div></div>
    <div className="transaction-proof"><div><span>ORIGINAL ORDER</span><code>{recovery?.originalOrderId || matchedRun?.orderId || 'Not created'}</code></div><div><span>PAYMENTS BEFORE</span><strong>{recovery?.paymentCountBefore ?? matchedRun?.paymentCount ?? '—'}</strong></div><div><span>PAYMENTS AFTER</span><strong>{recovery ? recovery.paymentCountAfter : '—'}</strong></div><div><span>VERIFICATION</span><strong className={recovery?.status === 'verified' ? 'cyan' : ''}>{recovery?.status === 'verified' ? 'Passed' : recovery?.status === 'failed' ? 'Failed · incident open' : 'Awaiting approval'}</strong></div></div>{recovery ? <EvidencePanel evidence={recovery.evidence}/> : null}
  </> : <EmptyState icon={ShieldCheck} title={missing ? 'This incident is unavailable' : 'Recovery begins with an incident'}>Run the missing-confirmation scenario, inspect its evidence, and approve the controlled recovery here.<Link to="/" className="text-button">Run the demo <ArrowRight size={15}/></Link></EmptyState>}</>;
}
