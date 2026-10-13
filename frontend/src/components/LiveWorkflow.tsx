import { CheckCircle2, ExternalLink, FileSearch, FlaskConical, Loader2, ShieldCheck, TriangleAlert, Wrench } from 'lucide-react';
import type { LiveFault, LiveLabState, LiveRun } from '@bizplus/shared';
import { Badge, duration, SectionLabel, shortId, time } from './UI';

const FAULTS: { id: LiveFault; label: string; description: string }[] = [
  { id: 'healthy', label: 'Healthy baseline', description: 'Website, button, login, payment and database checks succeed.' },
  { id: 'http_500', label: 'HTTP 500 · Server error', description: 'The test page returns a controlled server exception.' },
  { id: 'http_503', label: 'HTTP 503 · Service unavailable', description: 'The test page reports a temporary service failure.' },
  { id: 'not_found', label: 'HTTP 404 · Missing route', description: 'The configured test page is unavailable.' },
  { id: 'missing_content', label: 'HTTP 200 · Missing content', description: 'The page loads but its expected content is absent.' },
  { id: 'empty_body', label: 'HTTP 200 · Empty response', description: 'The page returns no response body.' },
  { id: 'timeout', label: 'Response timeout', description: 'The test page takes longer than the 12-second request limit.' },
  { id: 'javascript_error', label: 'Browser JavaScript error', description: 'The page loads, but its browser script throws an error.' },
  { id: 'button_broken', label: 'Broken storefront button', description: 'A button click does not produce the expected cart outcome.' },
  { id: 'login_401', label: 'Login rejected', description: 'The synthetic customer login is rejected with HTTP 401.' },
  { id: 'payment_unavailable', label: 'Payment service unavailable', description: 'A simulated payment dependency returns an error.' },
  { id: 'database_unavailable', label: 'Database unavailable', description: 'A synthetic database dependency fails during the journey.' },
];

export function LiveLabControl({ lab, fault, busy, connected, onFault, onIntroduce, onRestore }: {
  lab: LiveLabState | null; fault: LiveFault; busy: boolean; connected: boolean;
  onFault: (fault: LiveFault) => void; onIntroduce: () => void; onRestore: () => void;
}) {
  const selected = FAULTS.find(item => item.id === fault)!;
  return <section className="panel live-lab-panel">
    <div className="panel-header"><div><SectionLabel><FlaskConical size={13}/> CONTROLLED TEST WEBSITE</SectionLabel><h2>Introduce a fault. Inspect the result.</h2></div><Badge status={lab?.fault === 'healthy' ? 'passed' : lab ? 'open' : 'idle'}>{lab?.fault === 'healthy' ? 'Healthy' : lab ? 'Fault active' : 'Connecting'}</Badge></div>
    <div className="live-lab-content">
      <div className="live-lab-field"><label htmlFor="live-test-fault">Deliberate test fault</label><select id="live-test-fault" value={fault} disabled={busy || !connected || !lab} onChange={event => onFault(event.target.value as LiveFault)}>{FAULTS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select><p>{selected.description}</p></div>
      <div className="live-lab-actions"><button className="primary-button" disabled={busy || !connected || !lab} onClick={onIntroduce}>{busy ? <Loader2 size={16} className="spin"/> : <FlaskConical size={16}/>} {fault === 'healthy' ? 'Run healthy baseline' : 'Introduce test fault'}</button><button className="secondary-button" disabled={busy || !connected || !lab || lab.fault === 'healthy'} onClick={onRestore}><Wrench size={15}/> Restore test site</button>{lab ? <a className="text-button" href={lab.url} target="_blank" rel="noreferrer">Open this test website <ExternalLink size={13}/></a> : null}</div>
      <div className="live-lab-safety"><ShieldCheck size={17}/><div><strong>Isolated to your demo session · Simulated payments</strong><p>{lab ? `Faults expire automatically after ${lab.maxDurationSeconds} seconds. ` : 'Loading the test website safety settings. '}{lab?.expiresAt ? `Current fault expires at ${time(lab.expiresAt)}. ` : ''}Introducing a fault also runs its checks and captures the failure.</p>{lab && lab.fault !== 'healthy' ? <span>Active fault: {FAULTS.find(item => item.id === lab.fault)?.label || lab.fault}</span> : null}</div></div>
    </div>
  </section>;
}

export function LiveInvestigation({ run, verification, canRestore, busy, connected, onRecover, onVerify, onSelect }: {
  run: LiveRun; verification: LiveRun | null; canRestore: boolean; busy: boolean; connected: boolean;
  onRecover: () => void; onVerify: () => void; onSelect: (runId: string) => void;
}) {
  const diagnosis = run.diagnosis;
  if (!diagnosis) return null;
  const resolved = run.incidentStatus === 'resolved';
  return <section className="panel live-investigation">
    <div className="panel-header"><div><SectionLabel><FileSearch size={13}/> LIVE INCIDENT INVESTIGATION</SectionLabel><h2>Reason, solution and verification</h2></div><Badge status={resolved ? 'resolved' : 'open'}>{resolved ? 'Recovery verified' : 'Needs attention'}</Badge></div>
    <p className="live-diagnosis-summary">{diagnosis.summary}</p>
    <div className="live-diagnosis-grid">
      <div><h3><FileSearch size={15}/> Observed facts</h3><ul>{diagnosis.observedFacts.map((fact, index) => <li key={index}>{fact}</li>)}</ul></div>
      <div><h3><ShieldCheck size={15}/> Confirmed cause</h3><p>{diagnosis.confirmedCause || 'The response establishes the failure, but does not establish the underlying cause. Check the application and dependency logs.'}</p>{diagnosis.possibleCauses.length ? <><h3 className="live-possible-title">Possible causes to investigate</h3><ul>{diagnosis.possibleCauses.map((cause, index) => <li key={index}>{cause}</li>)}</ul></> : null}</div>
      <div><h3><Wrench size={15}/> Solutions to rectify it</h3><ol>{diagnosis.solutions.map((solution, index) => <li key={index}>{solution}</li>)}</ol></div>
    </div>
    <div className="live-repair-actions">{!resolved ? <><button className="primary-button" disabled={busy || !connected} onClick={canRestore ? onRecover : onVerify}>{busy ? <Loader2 size={16} className="spin"/> : <Wrench size={16}/>} {canRestore ? 'Restore test site and verify' : 'Verify after repair'}</button><p>{canRestore ? 'Resets this session’s matching test fault, then repeats the real checks. The incident resolves only when verification passes.' : 'Repair the website using the guidance above, then repeat the checks. The original failure remains in the history.'}</p></> : <p className="live-recovered-note"><CheckCircle2 size={17}/> The original failure is preserved below. A separate successful check verified recovery.</p>}</div>
    {run.recovery ? <div className={`live-verification ${run.recovery.status}`}><span className="live-verification-icon">{run.recovery.status === 'verified' ? <CheckCircle2 size={23}/> : <TriangleAlert size={23}/>}</span><div><strong>{run.recovery.status === 'verified' ? 'Rectification verified' : 'Verification failed · Incident remains open'}</strong><p>{verification ? `${verification.httpStatus === null ? verification.message : `HTTP ${verification.httpStatus}`} · ${duration(verification.durationMs)} · ${verification.assertions.filter(assertion => assertion.passed).length}/${verification.assertions.length} assertions passed` : `Verification recorded at ${time(run.recovery.completedAt)}`}</p><button className="text-button" onClick={() => onSelect(run.recovery!.verificationRunId)}>Inspect verification run {shortId(run.recovery.verificationRunId)} <ExternalLink size={13}/></button></div><Badge status={run.recovery.status}/></div> : null}
    <div className="panel-footer"><span>Evidence-based rules · {diagnosis.confirmedCause ? 'Cause supported by captured telemetry' : 'Causes remain hypotheses until evidence confirms them'}</span><span>INCIDENT RUN {shortId(run.id)}</span></div>
  </section>;
}

export function LiveTracePanel({ run }: { run: LiveRun }) {
  const events = run.evidence.events || [];
  if (!events.length) return null;
  return <section className="panel live-traces"><div className="panel-header"><div><SectionLabel>APPLICATION AND BROWSER EVIDENCE</SectionLabel><h2>Captured events</h2></div><span className="small-meta">{events.length} records</span></div><div className="live-trace-list">{events.map((event, index) => <details key={`${event.id}-${index}`} open={index === 0}><summary><FileSearch size={15}/><span><small>{event.kind} · {time(event.timestamp)}</small><strong>{event.message}</strong></span></summary>{event.data ? <pre>{JSON.stringify(event.data, null, 2)}</pre> : <p>No additional structured data.</p>}</details>)}</div></section>;
}
