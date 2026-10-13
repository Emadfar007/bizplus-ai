import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { Activity, ArrowRight, ArrowUpRight, Check, CheckCircle2, ChevronDown, ChevronRight, CircleDot, FileSearch, FlaskConical, GitBranch, LayoutDashboard, Loader2, Menu, RefreshCw, RotateCcw, ShieldCheck, Sparkles, Terminal, TriangleAlert, X } from 'lucide-react';
import type { Incident } from '@bizplus/shared';
import { useWorkspace, type Workspace } from './hooks/useWorkspace';
import { api } from './services/api';
import { Badge, EmptyState, EvidencePanel, IncidentSummary, Journey, MetricRow, RunList, ScenarioControl, SectionLabel, shortId, StepComparison, time, TrendPanel } from './components/UI';

function Brand() { return <Link to="/" className="brand"><span className="brand-mark"><Activity size={27}/></span><span>BizPlus <strong>AI</strong><small>BUSINESS RELIABILITY</small></span></Link>; }
const NAVIGATION = [{ to: '/', title: 'Overview', icon: LayoutDashboard }, { to: '/workflows', title: 'Workflows', icon: GitBranch }, { to: '/incidents', title: 'Investigation', icon: FileSearch }, { to: '/recovery', title: 'Recovery', icon: ShieldCheck }];

export default function App() {
  const workspace = useWorkspace();
  const [menuOpen, setMenuOpen] = useState(false);
  const [resetDialog, setResetDialog] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const investigate = (id: string) => navigate(`/incidents/${id}`);
  const historyPolicy = workspace.metrics?.historyPolicy || workspace.health?.historyPolicy;
  const historyLabel = historyPolicy === 'temporary' ? 'Temporary history · resets when the hosted service restarts' : historyPolicy === 'local' ? 'Local history · saved on this machine' : 'History status available when the engine connects';
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
    return () => { document.removeEventListener('keydown', keydown); priorFocus?.focus(); };
  }, [resetDialog]);
  return <div className="app-shell">
    {menuOpen ? <button className="sidebar-scrim" aria-label="Close menu" onClick={() => setMenuOpen(false)}/> : null}
    <aside className={`sidebar ${menuOpen ? 'mobile-open' : ''}`}>
      <Brand/><button className="sidebar-close icon-button" aria-label="Close menu" onClick={() => setMenuOpen(false)}><X size={20}/></button>
      <div className="workspace-pill"><span className="workspace-icon">B</span><span><strong>Demo workspace</strong><small>Commerce sandbox</small></span><ChevronDown size={14}/></div>
      <SectionLabel>WORKSPACE</SectionLabel>
      <nav aria-label="Main navigation">{NAVIGATION.map(item => <NavLink key={item.to} to={item.to} end={item.to === '/'} onClick={() => setMenuOpen(false)} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><item.icon size={18}/><span>{item.title}</span>{item.to === '/incidents' && workspace.metrics?.openIncidents ? <span className="nav-count">{workspace.metrics.openIncidents}</span> : null}</NavLink>)}</nav>
      <div className="sidebar-engine"><div className="engine-icon"><Sparkles size={19}/></div><strong>Evidence over guesswork.</strong><p>Every diagnosis points back to captured responses and logs.</p><span className="engine-label"><CircleDot size={12}/> Rules-based engine</span></div>
      <div className="sidebar-bottom"><div><span className="sidebar-dot"/> Owned sandbox only</div><button className="text-button" disabled={workspace.active} onClick={() => setResetDialog(true)}><RotateCcw size={14}/> Fresh demo session</button><code>SESSION {shortId(workspace.session)}</code></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button className="mobile-menu icon-button" aria-label="Open menu" onClick={() => setMenuOpen(true)}><Menu size={20}/></button><span>Workspace</span><ChevronRight size={14}/><strong>Commerce reliability</strong></div><div className="topbar-right"><span className="demo-tag"><FlaskConical size={13}/> LIVE SANDBOX</span><span className={`connection-status ${workspace.connection}`}><span/>{workspace.connection === 'ready' ? 'Backend online' : workspace.connection === 'connecting' ? 'Waking backend' : 'Backend offline'}</span><div className="avatar" title="Your isolated demo session">B</div></div></header>
      <main>
        {workspace.connection !== 'ready' ? <div className={`connection-banner ${workspace.connection}`} role="status">{workspace.connection === 'connecting' ? <Loader2 size={18} className="spin"/> : <TriangleAlert size={18}/>}<div><strong>{workspace.connection === 'connecting' ? 'Connecting to the monitoring engine…' : 'The monitoring engine is unavailable'}</strong><p>{workspace.connection === 'connecting' ? 'Free hosting may take about a minute to wake. We’ll retry for up to two minutes; tests unlock when it is ready.' : 'Confirm the backend is running, or retry the connection. You can also use the local presentation fallback.'}</p></div>{workspace.connection === 'offline' ? <button className="secondary-button" onClick={workspace.reconnect}><RefreshCw size={14}/> Retry connection</button> : null}</div> : null}
        {workspace.error ? <div className="feedback error" role="alert"><TriangleAlert size={18}/><span>{workspace.error}</span><button className="text-button" onClick={() => void workspace.refresh()}>Retry</button><button className="icon-button" aria-label="Dismiss error" onClick={workspace.clearError}><X size={16}/></button></div> : null}
        {workspace.notice ? <div className="feedback notice" role="status"><CheckCircle2 size={18}/><span>{workspace.notice}</span><button className="icon-button" aria-label="Dismiss message" onClick={workspace.clearNotice}><X size={16}/></button></div> : null}
        <Routes>
          <Route path="/" element={<Overview workspace={workspace} investigate={investigate}/>}/>
          <Route path="/workflows" element={<Workflows workspace={workspace} investigate={investigate}/>}/>
          <Route path="/incidents" element={<Investigation workspace={workspace}/>}/>
          <Route path="/incidents/:id" element={<Investigation workspace={workspace}/>}/>
          <Route path="/recovery" element={<Recovery workspace={workspace}/>}/>
          <Route path="/recovery/:id" element={<Recovery workspace={workspace}/>}/>
          <Route path="*" element={<EmptyState title="This view could not be found"><Link to="/">Return to the overview</Link></EmptyState>}/>
        </Routes>
        <footer className="app-footer"><span><ShieldCheck size={13}/> Synthetic data. Simulated payments. Verified outcomes.</span><span>{historyLabel} <span className="footer-separator">/</span> {workspace.lastUpdated ? `Synced ${workspace.lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Waiting for connection'}</span></footer>
      </main>
    </div>
    {resetDialog ? <div className="modal-backdrop" onClick={() => setResetDialog(false)}><div ref={modalRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="reset-title" onClick={event => event.stopPropagation()}><span className="modal-icon"><RotateCcw size={23}/></span><h2 id="reset-title">Start a fresh demo?</h2><p>A new session gives you an empty dashboard and independent test transactions. Your previous session’s runs are retained until the server history resets.</p><div className="modal-actions"><button className="secondary-button" onClick={() => setResetDialog(false)}>Keep this session</button><button className="primary-button" onClick={() => { workspace.resetSession(); navigate('/'); setResetDialog(false); }}>Start fresh <ArrowRight size={15}/></button></div></div></div> : null}
  </div>;
}

function Overview({ workspace, investigate }: { workspace: Workspace; investigate: (id: string) => void }) {
  const latestIncident = workspace.incidentList.incidents.find(item => item.status !== 'resolved');
  const hasMissingConfirmation = latestIncident?.diagnosis.recommendedAction === 'resume_receipt_worker';
  return <>
    <section className={`page-hero ${hasMissingConfirmation ? 'incident-hero' : ''}`}><div className="hero-copy"><SectionLabel><span className="live-dot"/> BUSINESS OUTCOMES, VERIFIED</SectionLabel><h1>{hasMissingConfirmation ? <>HTTP 200.<br/><span>The order is missing.</span></> : <>Every transaction.<br/><span>Every promise, verified.</span></>}</h1><p>{hasMissingConfirmation ? 'Your endpoint returned success. Your customer is still waiting. BizPlus caught the broken confirmation and collected the evidence.' : 'Go beyond an uptime check. Test the complete customer journey, understand failures, and prove the recovery worked.'}</p><div className="hero-foot"><span className="hero-status"><span className={`status-dot ${latestIncident ? 'amber' : 'cyan'}`}/>{workspace.connection !== 'ready' ? 'Waiting for the monitoring engine' : latestIncident ? `${workspace.metrics?.openIncidents || 1} business outcome${(workspace.metrics?.openIncidents || 1) > 1 ? 's' : ''} need attention` : workspace.metrics?.totalRuns ? 'Your completed runs are being measured' : 'Your isolated sandbox is ready'}</span>{latestIncident ? <button className="text-button" onClick={() => investigate(latestIncident.id)}>Open investigation <ArrowRight size={15}/></button> : <span className="small-meta">Login → confirmation</span>}</div></div><div className="outcome-visual" aria-hidden="true"><div className="visual-orbit orbit-1"/><div className="visual-orbit orbit-2"/><div className="visual-orbit orbit-3"/><span className="orbit-node node-1"><Check size={14}/></span><span className="orbit-node node-2"><Check size={14}/></span><span className="orbit-node node-3">{hasMissingConfirmation ? <TriangleAlert size={14}/> : <Check size={14}/>}</span><div className="visual-core"><Activity size={42}/></div><div className="visual-caption"><span>ENDPOINT → OUTCOME</span><strong>{hasMissingConfirmation ? 'Business failure detected' : 'The journey is the signal'}</strong></div></div></section>
    <MetricRow metrics={workspace.metrics}/>
    <div className="primary-grid"><Journey run={workspace.run} workflowName={workspace.workflows[0]?.name} onInvestigate={investigate}/><ScenarioControl workspace={workspace}/></div>
    <div className="secondary-grid"><TrendPanel metrics={workspace.metrics}/><RunList runs={workspace.metrics?.recentRuns || []} selectedId={workspace.run?.id} onSelect={id => void workspace.selectRun(id)}/></div>
    {workspace.incidentList.incidents.length ? <section className="incident-strip"><div className="section-heading"><h2>Signals to investigate</h2><Link to="/incidents" className="text-button">All incidents <ArrowUpRight size={15}/></Link></div>{workspace.incidentList.incidents.slice(0, 2).map(incident => <IncidentSummary key={incident.id} incident={incident} onOpen={() => investigate(incident.id)}/>)}</section> : null}
  </>;
}
function Workflows({ workspace, investigate }: { workspace: Workspace; investigate: (id: string) => void }) {
  return <><PageHeading eyebrow="WORKFLOW EXPLORER" title="Follow the whole journey." description="Every step sends a real HTTP request to the commerce sandbox. Select a completed step to inspect what was expected and what happened."/><div className="workflow-definition"><span className="workflow-icon"><GitBranch size={24}/></span><div><h2>{workspace.workflows[0]?.name || 'Commerce checkout'}</h2><p>Authentication → available stock → cart → simulated payment → confirmed order</p></div><Badge status="idle">5 sequential steps</Badge></div><div className="primary-grid"><Journey run={workspace.run} workflowName={workspace.workflows[0]?.name} onInvestigate={investigate}/><ScenarioControl workspace={workspace}/></div>{workspace.run ? <div className="run-metadata"><span>RUN <code>{workspace.run.id}</code></span><span>TRANSACTION <code>{workspace.run.transactionId || 'Not created'}</code></span><span>PAYMENTS <strong>{workspace.run.paymentCount}</strong></span></div> : null}<div className="secondary-grid"><TrendPanel metrics={workspace.metrics}/><RunList runs={workspace.metrics?.recentRuns || []} selectedId={workspace.run?.id} onSelect={id => void workspace.selectRun(id)}/></div></>;
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
  return <><PageHeading eyebrow="INCIDENT INVESTIGATION" title="Understand what actually failed." description="Inspect responses and assertions, connect recurring failures, and separate observed facts from possible causes."/>{workspace.incidentList.incidents.length ? <div className="incident-selector">{workspace.incidentList.incidents.map(item => <button key={item.id} className={item.id === incident?.id ? 'selected' : ''} onClick={() => navigate(`/incidents/${item.id}`)}><Badge status={item.status}/><span>{item.title}</span><code>{shortId(item.id)}</code></button>)}</div> : null}{incident ? <>
    <div className={`incident-heading ${incident.status}`}><span className="large-status-icon">{incident.status === 'resolved' ? <ShieldCheck size={25}/> : <TriangleAlert size={25}/>}</span><div><SectionLabel>INCIDENT {shortId(incident.id)}</SectionLabel><h2>{incident.title}</h2><p>Detected at {time(incident.createdAt)} · Workflow run {shortId(incident.runId)}</p></div><Badge status={incident.status}/></div>
    <div className="diagnosis-grid"><section className="panel diagnosis-panel"><div className="panel-header"><div><SectionLabel>EVIDENCE-LINKED EXPLANATION</SectionLabel><h2>Diagnosis</h2></div><span className="rules-tag"><Sparkles size={13}/> Rules-based diagnosis</span></div><p className="diagnosis-summary">{incident.diagnosis.summary}</p><div className="facts-causes"><div><h3><CheckCircle2 size={16}/> Observed facts</h3>{incident.diagnosis.observedFacts.map((fact, index) => <p key={index}><span/> {fact}</p>)}</div><div><h3><FileSearch size={16}/> Possible causes</h3>{incident.diagnosis.possibleCauses.map((cause, index) => <p key={index}><span/> {cause}</p>)}<small>Possible causes are hypotheses; the evidence determines what is confirmed.</small></div></div><div className="evidence-references"><span>SUPPORTING EVIDENCE</span>{incident.diagnosis.evidenceIds.map(item => <a key={item} href="#captured-evidence"><FileSearch size={12}/>{shortId(item)}</a>)}</div></section><section className="panel action-panel"><div className="panel-header"><div><SectionLabel>SAFE NEXT STEP</SectionLabel><h2>{incident.status === 'resolved' ? 'Outcome recovered' : incident.diagnosis.recommendedAction ? 'Recovery available' : 'Investigation required'}</h2></div><ShieldCheck size={21} className="cyan"/></div><p>{incident.diagnosis.guidance}</p>{incident.diagnosis.recommendedAction ? <><div className="safe-action"><Check size={15}/><span>Use the original order<small>Checkout will not be repeated</small></span></div><button className="primary-button" onClick={() => navigate(`/recovery/${incident.id}`)}>{incident.status === 'resolved' ? 'View verified recovery' : 'Review recovery'}<ArrowRight size={16}/></button></> : <div className="guidance-note"><Terminal size={17}/><span>This failure needs investigation. No automatic recovery is offered.</span></div>}</section></div>
    <div className="fingerprint-panel"><div><GitBranch size={18}/><span><strong>Failure fingerprint</strong><code>{incident.fingerprint}</code></span></div><span className="small-meta">{incident.relatedIncidentIds.length} related incident{incident.relatedIncidentIds.length === 1 ? '' : 's'} in this session</span></div>{incident.relatedIncidentIds.length ? <div className="related-incidents">{incident.relatedIncidentIds.map(relatedId => <button className="text-button" key={relatedId} onClick={() => navigate(`/incidents/${relatedId}`)}><FileSearch size={14}/>{shortId(relatedId)}<ArrowUpRight size={13}/></button>)}</div> : null}<div id="captured-evidence"><EvidencePanel evidence={incident.evidence}/></div>
  </> : <EmptyState icon={FileSearch} title={missing ? 'This incident is unavailable' : id && workspace.connection === 'ready' ? 'Loading incident…' : 'No incidents to investigate'}>{missing ? 'This incident belongs to another session or hosted history has reset. Run a new test to collect fresh evidence.' : 'Run either failure scenario to see the failed assertion, response evidence, and diagnosis here.'}<Link to="/" className="text-button">Go to the demo <ArrowRight size={15}/></Link></EmptyState>}</>;
}
function Recovery({ workspace }: { workspace: Workspace }) {
  const { incident, missing } = useSelectedIncident(workspace);
  const navigate = useNavigate();
  const [sourceRun, setSourceRun] = useState(workspace.run?.id === incident?.runId ? workspace.run : null);
  useEffect(() => {
    if (!incident) { setSourceRun(null); return; }
    if (workspace.run?.id === incident.runId) { setSourceRun(workspace.run); return; }
    let cancelled = false;
    const requestedSession = workspace.session;
    api.run(requestedSession, incident.runId).then(run => { if (!cancelled && workspace.isCurrentSession(requestedSession)) setSourceRun(run); }).catch(() => { if (!cancelled && workspace.isCurrentSession(requestedSession)) setSourceRun(null); });
    return () => { cancelled = true; };
  }, [incident?.runId, workspace.run, workspace.session, workspace.isCurrentSession]);
  const recovery = incident?.recovery;
  const matchedRun = sourceRun?.id === incident?.runId ? sourceRun : null;
  const failedStep = matchedRun?.steps.find(step => step.id === incident?.failedStepId);
  const eligible = !!incident?.diagnosis.recommendedAction;
  return <><PageHeading eyebrow="VERIFIED RECOVERY" title="A fix is only a fix when it passes." description="Approve one controlled action, then verify the original order. The failed execution remains intact for comparison."/>{workspace.incidentList.incidents.length ? <div className="incident-selector">{workspace.incidentList.incidents.map(item => <button key={item.id} className={item.id === incident?.id ? 'selected' : ''} onClick={() => navigate(`/recovery/${item.id}`)}><Badge status={item.status}/><span>{item.title}</span><code>{shortId(item.id)}</code></button>)}</div> : null}{incident ? <><div className={`recovery-banner ${incident.status}`}><div className="large-status-icon">{incident.status === 'resolved' ? <ShieldCheck size={26}/> : <RotateCcw size={24}/>}</div><div><SectionLabel>{incident.status === 'resolved' ? 'RECOVERY VERIFIED' : 'CONTROLLED REMEDIATION'}</SectionLabel><h2>{incident.status === 'resolved' ? 'Original order confirmed. One payment.' : eligible ? 'Resume the confirmation worker.' : 'This failure has no safe recovery action.'}</h2><p>{incident.status === 'resolved' ? 'The business assertion passed after recovery. Checkout was never repeated.' : incident.diagnosis.guidance}</p></div><Badge status={incident.status}/></div>
    <div className="recovery-grid"><section className="panel approval-panel"><div className="panel-header"><div><SectionLabel>APPROVAL REQUIRED</SectionLabel><h2>Recovery action</h2></div><ShieldCheck size={20} className="cyan"/></div><div className="recovery-action-title"><span><RotateCcw size={19}/></span><strong>{eligible ? 'Resume receipt worker' : 'Investigate checkout service'}</strong></div><p>{eligible ? 'Resume only this transaction’s paused confirmation worker and retrieve the original order again.' : 'The checkout returned HTTP 500 before payment. Inspect the error evidence and service logs, then run a fresh test when the service is healthy.'}</p><div className="recovery-guardrails">{eligible ? <><span><Check size={14}/> Original order preserved</span><span><Check size={14}/> No repeat checkout</span><span><Check size={14}/> Unique payment key enforced</span></> : <><span><Check size={14}/> No payment was created</span><span><Check size={14}/> Confirmation was skipped</span></>}</div>{eligible ? <button className="primary-button" disabled={workspace.connection !== 'ready' || workspace.active || incident.status === 'resolved' || incident.status === 'recovering' || !!matchedRun && ['running', 'queued'].includes(matchedRun.status)} onClick={() => void workspace.recover(incident.id)}>{workspace.recovering || incident.status === 'recovering' ? <Loader2 className="spin" size={17}/> : incident.status === 'resolved' ? <CheckCircle2 size={17}/> : <ShieldCheck size={17}/>} {incident.status === 'resolved' ? 'Recovery verified' : workspace.recovering ? 'Verifying original order…' : 'Approve recovery'}{incident.status !== 'resolved' && !workspace.recovering ? <ArrowRight size={16}/> : null}</button> : <button className="secondary-button" onClick={() => navigate(`/incidents/${incident.id}`)}>View investigation <ArrowUpRight size={15}/></button>}<small className="approval-note">Approval is an explicit demo action. Only this owned sandbox transaction can be changed.</small></section><div className="comparison-grid"><StepComparison label="BEFORE · ORIGINAL FAILURE" step={failedStep} variant="before"/><StepComparison label="AFTER · RECOVERY VERIFICATION" step={recovery?.verification} variant="after"/></div></div>
    <div className="transaction-proof"><div><span>ORIGINAL ORDER</span><code>{recovery?.originalOrderId || matchedRun?.orderId || 'Not created'}</code></div><div><span>PAYMENTS BEFORE</span><strong>{recovery?.paymentCountBefore ?? matchedRun?.paymentCount ?? '—'}</strong></div><div><span>PAYMENTS AFTER</span><strong>{recovery ? recovery.paymentCountAfter : '—'}</strong></div><div><span>VERIFICATION</span><strong className={recovery?.status === 'verified' ? 'cyan' : ''}>{recovery?.status === 'verified' ? 'Passed' : recovery?.status === 'failed' ? 'Failed · incident open' : 'Awaiting approval'}</strong></div></div>{recovery ? <EvidencePanel evidence={recovery.evidence}/> : null}
  </> : <EmptyState icon={ShieldCheck} title={missing ? 'This incident is unavailable' : 'Recovery begins with an incident'}>Run the missing-confirmation scenario, inspect its evidence, and approve the controlled recovery here.<Link to="/" className="text-button">Run the demo <ArrowRight size={15}/></Link></EmptyState>}</>;
}
