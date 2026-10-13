import { Link } from 'react-router-dom';
import { CheckCircle2, FileSearch, Loader2, LockKeyhole, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { Incident, StepResult } from '@bizplus/shared';
import type { Workspace } from '../hooks/useWorkspace';
import { LoginForm } from './LoginForm';
import { Badge, EvidencePanel, SectionLabel, StepComparison, time } from './UI';

export default function LoginRecovery({ workspace, incident, originalStep, loading, evidenceError, onRetryEvidence }: {
  workspace: Workspace; incident: Incident; originalStep?: StepResult; loading: boolean; evidenceError: boolean; onRetryEvidence: () => void;
}) {
  const recovery = incident.manualRecovery;
  const verified = incident.status === 'resolved' && recovery?.status === 'verified';
  return <>
    <div className="page-heading"><SectionLabel>MANUAL LOGIN RECOVERY</SectionLabel><h1>Recover your login</h1><p>Enter the correct credentials yourself. A successful server check resolves this incident and preserves the original error.</p></div>
    <div className={`recovery-banner ${incident.status}`}>
      <span className="large-status-icon">{verified ? <ShieldCheck size={26}/> : <LockKeyhole size={26}/>}</span>
      <div><SectionLabel>{verified ? 'RECOVERY VERIFIED' : 'YOUR ACTION REQUIRED'}</SectionLabel><h2>{verified ? 'Login successful' : 'Retry with the correct username and password'}</h2><p>{verified ? `Your manual retry passed at ${time(recovery.completedAt)}. The original rejected attempt remains in the evidence.` : 'Login stays under your control. Monitoring cannot enter, change or retry your credentials.'}</p></div>
      <Badge status={incident.status}/>
    </div>
    {loading ? <div className="feedback notice" role="status"><Loader2 size={18} className="spin"/> Loading the original evidence…</div> : evidenceError ? <div className="feedback error" role="alert"><TriangleAlert size={18}/><span>The original execution could not be loaded.</span><button className="secondary-button" onClick={onRetryEvidence}>Retry evidence</button></div> : null}
    <div className="recovery-grid">
      <section className="panel approval-panel"><div className="panel-header"><div><SectionLabel>HUMAN CONTROL</SectionLabel><h2>{verified ? 'Login recovered' : 'Enter credentials to recover'}</h2></div><LockKeyhole size={20}/></div>
        {verified ? <div className="login-recovery-success"><CheckCircle2 size={24}/><strong>Login successful</strong><p>The server verified your manual login before resolving the incident.</p><Link className="primary-button" to="/">Open business dashboard</Link></div> : <LoginForm session={workspace.session} source={incident.login?.source} incidentId={incident.id} labRevision={incident.login?.labRevision} connected={workspace.connection === 'ready'} onCompleted={() => workspace.refresh()}/>}
      </section>
      <div className="comparison-grid"><StepComparison label="BEFORE · REJECTED LOGIN" step={originalStep} variant="before" emptyTitle="Rejected login" emptyStatus="Loading original evidence" emptyMessage="The original rejected login stays in the evidence."/><StepComparison label="AFTER · YOUR MANUAL RETRY" step={recovery?.verification} variant="after" emptyTitle="Manual login verification" emptyStatus="Awaiting your credentials" emptyMessage="Enter the correct username and password yourself to verify recovery."/></div>
    </div>
    <div className="transaction-proof"><div><span>RECOVERY CONTROL</span><strong>You</strong></div><div><span>CREDENTIALS IN EVIDENCE</span><strong>Not recorded</strong></div><div><span>VERIFICATION</span><strong>{verified ? 'Passed' : recovery?.status === 'failed' ? 'Failed · incident open' : 'Awaiting your retry'}</strong></div><div><span>ORIGINAL FAILURE</span><Link to={`/incidents/${incident.id}`} className="text-button"><FileSearch size={14}/> Investigation</Link></div></div>
    {recovery ? <EvidencePanel evidence={recovery.evidence}/> : null}
  </>;
}
