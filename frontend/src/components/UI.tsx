import { lazy, Suspense, useEffect, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUpRight, Check, CheckCircle2, Circle, Clock3, CreditCard, FileCheck2, FileSearch, FlaskConical, Loader2, LockKeyhole, PackageCheck, Play, ShoppingCart, ShieldCheck, Timer, TriangleAlert, X } from 'lucide-react';
import type { Evidence, Incident, Metrics, Run, StepResult, StepStatus } from '@bizplus/shared';
import { SCENARIOS } from '@bizplus/shared';
import type { Workspace } from '../hooks/useWorkspace';

const LatencyChart = lazy(() => import('./LatencyChart'));
export const shortId = (value: string) => value.slice(0, 8);
export const duration = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
export const time = (value: string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export function Badge({ status, children }: { status: string; children?: React.ReactNode }) {
  return <span className={`badge ${status}`}><span className="badge-dot"/>{children || status}</span>;
}
export function SectionLabel({ children }: { children: React.ReactNode }) { return <span className="eyebrow">{children}</span>; }
export function EmptyState({ icon: Icon = FileSearch, title, children }: { icon?: typeof FileSearch; title: string; children: React.ReactNode }) {
  return <div className="empty-state"><div className="empty-icon"><Icon size={23}/></div><strong>{title}</strong><p>{children}</p></div>;
}
export function MetricRow({ metrics }: { metrics: Metrics | null }) {
  const completed = (metrics?.passedRuns || 0) + (metrics?.failedRuns || 0);
  const items = [
    { title: 'Journey success', value: completed ? `${Number(metrics?.successRate || 0).toFixed(0)}%` : '—', foot: completed ? `${metrics?.passedRuns} of ${completed} completed runs` : 'Awaiting the first completed run', icon: ShieldCheck, tone: 'cyan' },
    { title: 'Average journey time', value: completed ? duration(metrics?.averageDurationMs || 0) : '—', foot: 'Measured across completed runs', icon: Timer, tone: 'blue' },
    { title: 'Open incidents', value: metrics ? String(metrics.openIncidents) : '—', foot: 'Business outcomes needing attention', icon: TriangleAlert, tone: metrics?.openIncidents ? 'amber' : 'muted' },
    { title: 'Verified recoveries', value: metrics ? String(metrics.verifiedRecoveries) : '—', foot: metrics?.verifiedRecoveries ? metrics.averageRecoveryMs > 0 ? `Average ${duration(metrics.averageRecoveryMs)} for timed recoveries` : 'Confirmed by a fresh passing check' : 'Resolved only after verification', icon: CheckCircle2, tone: 'cyan' },
  ];
  return <div className="metric-row">{items.map(item => <div className="metric" key={item.title}><div className="metric-title"><span>{item.title}</span><item.icon size={16} className={item.tone}/></div><strong>{item.value}</strong><span className="metric-foot">{item.foot}</span></div>)}</div>;
}
const STEP_ICONS = [LockKeyhole, PackageCheck, ShoppingCart, CreditCard, FileCheck2];
const STEP_NAMES = ['Login', 'Inventory', 'Cart', 'Checkout', 'Confirmation'];
function StepSymbol({ status, index }: { status: StepStatus; index: number }) {
  const Icon = STEP_ICONS[index] || Circle;
  if (status === 'running') return <Loader2 className="spin" size={21}/>;
  if (status === 'failed') return <X size={21}/>;
  if (status === 'passed') return <Check size={21}/>;
  return <Icon size={21}/>;
}
export function Journey({ run, workflowName = 'Commerce checkout', onInvestigate }: { run: Run | null; workflowName?: string; onInvestigate?: (id: string) => void }) {
  const [selected, setSelected] = useState(0);
  const [following, setFollowing] = useState(true);
  const activeStep = run?.steps.findIndex(step => step.status === 'failed' || step.status === 'running') ?? -1;
  useEffect(() => { setFollowing(true); }, [run?.id]);
  useEffect(() => { if (run && following) setSelected(activeStep >= 0 ? activeStep : run.status === 'passed' ? run.steps.length - 1 : 0); }, [run?.id, run?.status, activeStep, following]);
  const manualLogin = run?.workflowId === 'manual-login';
  const applicationError = run?.scenario === 'application_error' || run?.workflowId === 'application-errors';
  const selectedIndex = applicationError && run.steps.length ? Math.min(selected, run.steps.length - 1) : selected;
  const step = run?.steps[selectedIndex];
  const stepNames = manualLogin || applicationError ? run!.steps.map(item => item.name) : STEP_NAMES;
  return <section className="panel journey-panel">
    <div className="panel-header"><div><SectionLabel>{applicationError ? 'ERROR MONITOR' : 'TRANSACTION MONITOR'}</SectionLabel><h2>{applicationError ? 'Application error' : manualLogin ? 'Manual login' : workflowName}</h2></div><Badge status={run?.status || 'idle'}>{applicationError ? run?.status === 'failed' ? 'Error recorded' : run?.status || 'Recorded event' : run?.status === 'passed' ? 'Business outcome verified' : run?.status === 'failed' ? 'Outcome failed' : run?.status || 'Ready to test'}</Badge></div>
    <span className="sr-only" role="status" aria-live="polite">{applicationError ? 'Application error recorded. Captured evidence is ready for investigation.' : run?.status === 'passed' ? manualLogin ? 'Login successful. Server verification passed.' : 'Test passed. All five business checks succeeded.' : run?.status === 'failed' ? 'Test failed. Captured evidence is ready for investigation.' : run?.status === 'running' ? `Test running. ${run.steps[activeStep]?.name || 'Starting workflow'}.` : 'Choose a scenario to start your test.'}</span>
    <div className="journey-steps" aria-label="Workflow execution steps">{stepNames.map((name, index) => {
      const result = run?.steps[index];
      const status = result?.status || 'pending';
      return <button key={result?.id || name} className={`journey-step ${status} ${selectedIndex === index && run ? 'selected' : ''}`} disabled={!run} onClick={() => { setSelected(index); setFollowing(false); }} aria-label={`${name}: ${status}`} aria-pressed={selectedIndex === index && !!run}><span className="step-connector"/><span className="step-icon"><StepSymbol status={status} index={index}/></span><span className="step-name">{name}</span><span className="step-meta">{status === 'passed' || status === 'failed' ? duration(result!.durationMs) : status === 'pending' ? 'Waiting' : status === 'skipped' ? 'Skipped' : 'Checking…'}</span></button>;
    })}</div>
    {run?.status === 'running' && !following ? <button className="text-button follow-step" onClick={() => setFollowing(true)}>Follow the active step <ArrowRight size={16}/></button> : null}
    {step ? <div className={`step-inspector ${step.status}`}>
      <div className="inspector-heading"><span><span className="step-number">{String(selectedIndex + 1).padStart(2, '0')}</span><strong>{step.name}</strong></span><div className="inline-tags">{step.httpStatus !== null ? <span className={`http-tag ${step.httpStatus >= 400 ? 'bad' : ''}`}>HTTP {step.httpStatus}</span> : null}<code>{step.method} {step.path}</code></div></div>
      <div className="expected-actual"><div><span>EXPECTED</span><p>{step.expected}</p></div><ArrowRight size={17}/><div><span>OBSERVED</span><p>{step.actual || (step.status === 'running' ? 'Awaiting the sandbox response…' : step.status === 'skipped' ? 'A required previous step failed.' : 'Not executed yet.')}</p></div></div>
      {step.status === 'failed' && run?.incidentId && onInvestigate ? <button className="text-button danger-text" onClick={() => onInvestigate(run.incidentId!)}>Investigate this incident <ArrowUpRight size={16}/></button> : null}
      {step.assertions.length ? <div className="assertion-strip">{step.assertions.map(assertion => <span key={assertion.code} className={assertion.passed ? 'passed' : 'failed'}>{assertion.passed ? <Check size={13}/> : <X size={13}/>} {assertion.code.replace(/_/g, ' ').toLowerCase()}</span>)}</div> : null}
    </div> : <div className="journey-idle"><div className="inline-icon"><ShieldCheck size={20}/><strong>Your results will appear here.</strong></div><p>Pick a scenario and run the five-step checkout. Every result includes response evidence.</p></div>}
    <div className="panel-footer"><span>{applicationError ? <><TriangleAlert size={13}/> Recorded error · Review the evidence</> : <><FlaskConical size={13}/> Synthetic credentials · Simulated payments</>}</span><span>{run ? `RUN ${shortId(run.id)}` : 'No production systems connected'}</span></div>
  </section>;
}
export function ScenarioControl({ workspace }: { workspace: Workspace }) {
  const icons = [CheckCircle2, TriangleAlert, FileSearch];
  return <section className="panel scenario-panel"><div className="panel-header"><div><SectionLabel>START HERE</SectionLabel><h2>1 · Choose a scenario</h2></div><FlaskConical size={20} className="muted"/></div><div className="scenario-options" aria-label="Test scenario">{SCENARIOS.map((scenario, index) => {
    const Icon = icons[index];
    return <button key={scenario.id} className={`scenario-option ${workspace.scenario === scenario.id ? 'selected' : ''}`} aria-pressed={workspace.scenario === scenario.id} disabled={workspace.active} onClick={() => workspace.setScenario(scenario.id)}><span className={`scenario-icon tone-${index}`}><Icon size={19}/></span><span><strong>{scenario.name}</strong><small>{index === 0 ? 'All five steps complete successfully' : index === 1 ? 'HTTP 500 · Before any payment' : 'HTTP 200 · Business outcome missing'}</small></span><span className="radio-dot"/></button>;
  })}</div><button className="primary-button run-button" disabled={workspace.connection !== 'ready' || workspace.active} onClick={() => void workspace.startRun()}>{workspace.active ? <Loader2 className="spin" size={17}/> : <Play size={17} fill="currentColor"/>}{workspace.starting ? 'Starting test…' : workspace.active ? workspace.recovering ? 'Verifying recovery…' : 'Test in progress…' : 'Run test'}</button><label className="auto-control"><span><Clock3 size={15}/><span>Auto-run every 30 seconds<small>Paused when this tab is hidden</small></span></span><button type="button" role="switch" aria-label="Auto-run every 30 seconds" aria-checked={workspace.auto} className={`switch ${workspace.auto ? 'on' : ''}`} onClick={() => workspace.setAuto(!workspace.auto)} disabled={workspace.connection !== 'ready'}><span/></button></label></section>;
}
export function TrendPanel({ metrics }: { metrics: Metrics | null }) {
  return <section className="panel trend-panel"><div className="panel-header"><div><SectionLabel>MEASURED PERFORMANCE</SectionLabel><h2>Journey duration</h2></div><span className="small-meta"><span className="legend-dot"/> End-to-end · ms</span></div>{metrics?.chart.length ? <Suspense fallback={<div className="chart-loading"><Loader2 className="spin" size={22}/></div>}><LatencyChart points={metrics.chart}/></Suspense> : <EmptyState icon={Timer} title="Your baseline starts with a run">Completed journeys will populate this chart with measured timings.</EmptyState>}</section>;
}
export function RunList({ runs, selectedId, onSelect }: { runs: Run[]; selectedId?: string; onSelect: (id: string) => void }) {
  return <section className="panel runs-panel"><div className="panel-header"><div><SectionLabel>EXECUTION HISTORY</SectionLabel><h2>Recent runs</h2></div><span className="small-meta">{runs.length ? `${runs.length} in this session` : 'Session scoped'}</span></div>{runs.length ? <div className="runs-list">{runs.slice(0, 6).map(run => <button key={run.id} aria-pressed={run.id === selectedId} className={`run-item ${run.id === selectedId ? 'selected' : ''}`} onClick={() => onSelect(run.id)}><span className={`run-status-icon ${run.status}`}>{run.status === 'passed' ? <Check size={15}/> : run.status === 'failed' ? <X size={15}/> : <Loader2 size={15} className="spin"/>}</span><span className="run-description"><strong>{run.scenario === 'manual_login' ? 'Manual login' : run.scenario === 'application_error' ? 'Application error' : SCENARIOS.find(scenario => scenario.id === run.scenario)?.name || run.scenario}</strong><small>{time(run.createdAt)} <span>·</span> {shortId(run.id)}</small></span><span className="run-time">{run.completedAt ? duration(run.durationMs) : 'Running'}</span><ArrowUpRight size={15}/></button>)}</div> : <EmptyState icon={Play} title="No executions yet">Run the healthy scenario to establish a baseline, then inject a failure.</EmptyState>}</section>;
}
export function IncidentSummary({ incident, onOpen }: { incident: Incident; onOpen: () => void }) {
  return <button className={`incident-summary ${incident.status}`} onClick={onOpen}><span className="incident-summary-icon">{incident.status === 'resolved' ? <ShieldCheck size={20}/> : <TriangleAlert size={20}/>}</span><span><strong>{incident.title}</strong><small>{incident.status === 'resolved' ? 'Recovery verified' : 'Needs investigation'} · {time(incident.createdAt)}</small></span><Badge status={incident.status}/><ArrowUpRight size={17}/></button>;
}
export function EvidencePanel({ evidence }: { evidence: Evidence[] }) {
  return <section className="panel evidence-panel"><div className="panel-header"><div><SectionLabel>CAPTURED EVIDENCE</SectionLabel><h2>Evidence timeline</h2></div><span className="small-meta">{evidence.length} records</span></div>{evidence.length ? <div className="evidence-list">{evidence.map((item, index) => <details key={`${item.id}-${index}`} className={`evidence-item ${item.kind}`} open={index === 0}><summary><span className="evidence-mark">{item.kind === 'assertion' ? <ShieldCheck size={15}/> : item.kind === 'recovery' ? <CheckCircle2 size={15}/> : <FileSearch size={15}/>}</span><span><span className="evidence-kind">{item.kind} <code>{shortId(item.id)}</code></span><strong>{item.message}</strong></span><time>{time(item.timestamp)}</time><ArrowDown size={14}/></summary>{item.data ? <pre>{JSON.stringify(item.data, null, 2)}</pre> : <p className="evidence-no-data">No additional structured data in this record.</p>}</details>)}</div> : <EmptyState title="No evidence collected">Evidence appears after the selected workflow step executes.</EmptyState>}</section>;
}
export function StepComparison({ label, step, variant, emptyTitle = 'Order confirmation', emptyStatus = 'Awaiting approved recovery', emptyMessage = 'Approve the safe action to verify the original order confirmation.' }: { label: string; step: StepResult | undefined; variant: 'before' | 'after'; emptyTitle?: string; emptyStatus?: string; emptyMessage?: string }) {
  return <div className={`comparison-card ${variant}`}><SectionLabel>{label}</SectionLabel><div className="comparison-title"><strong>{step?.name || emptyTitle}</strong>{step ? <Badge status={step.status}/> : <Badge status="idle">Not verified</Badge>}</div><div className="comparison-response"><span>HTTP RESPONSE</span><strong>{step?.httpStatus ?? '—'}</strong><span>{step ? duration(step.durationMs) : emptyStatus}</span></div><p>{step?.actual || emptyMessage}</p>{step?.assertions.map(assertion => <div className={`comparison-assertion ${assertion.passed ? 'passed' : 'failed'}`} key={assertion.code}>{assertion.passed ? <CheckCircle2 size={16}/> : <X size={16}/>}<span><strong>{assertion.code.replace(/_/g, ' ').toLowerCase()}</strong><small>{assertion.actual}</small></span></div>)}</div>;
}
