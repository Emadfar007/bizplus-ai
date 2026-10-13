import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, FileSearch, Globe2, LayoutDashboard, LockKeyhole, ShieldCheck } from 'lucide-react';
import type { LoginResult } from '@bizplus/shared';
import type { Workspace } from '../hooks/useWorkspace';
import LoginForm from '../components/LoginForm';
import { SectionLabel } from '../components/UI';

export default function Login({ workspace }: { workspace: Workspace }) {
  const [success, setSuccess] = useState<LoginResult | null>(null);
  useEffect(() => setSuccess(null), [workspace.session]);

  function completed(result: LoginResult) {
    if (result.status === 'successful') setSuccess(result);
    void workspace.refresh();
  }

  if (success) return <div className="login-page">
    <section className="login-dashboard panel" aria-labelledby="login-success-title">
      <span className="login-success-icon"><CheckCircle2 size={32}/></span>
      <SectionLabel>BUSINESS DASHBOARD</SectionLabel>
      <h1 id="login-success-title">Login successful</h1>
      <p>Your credentials were accepted. You are ready to review your business.</p>
      {success.recovery?.status === 'verified' ? <div className="login-recovery-proof"><ShieldCheck size={18}/><span>Your manual retry verified recovery. The original login incident is resolved.</span></div> : null}
      <div className="login-dashboard-links">
        <Link className="login-dashboard-link" to="/"><LayoutDashboard size={23}/><span><strong>Overview</strong><small>Business reliability at a glance</small></span><ArrowRight size={18}/></Link>
        <Link className="login-dashboard-link" to={success.incidentId ? `/incidents/${encodeURIComponent(success.incidentId)}` : '/incidents'}><FileSearch size={23}/><span><strong>Investigation</strong><small>{success.incidentId ? 'Review the recovered login incident' : 'Review recorded errors and evidence'}</small></span><ArrowRight size={18}/></Link>
        <Link className="login-dashboard-link" to="/live-tests"><Globe2 size={23}/><span><strong>Live tests</strong><small>Try a controlled login rejection</small></span><ArrowRight size={18}/></Link>
      </div>
      <button type="button" className="secondary-button" onClick={() => setSuccess(null)}><LockKeyhole size={17}/> Try another login</button>
    </section>
  </div>;

  return <div className="login-page">
    <section className="login-heading"><SectionLabel>CONTROLLED LOGIN TEST</SectionLabel><h1>Business login</h1><p>Sign in with a username and password. A rejected login appears in Investigation, where you can verify recovery by signing in again yourself.</p></section>
    <div className="login-page-grid">
      <section className="panel login-panel" aria-labelledby="login-form-title"><div className="panel-header"><h2 id="login-form-title">Log in to BizPlus</h2><LockKeyhole size={20}/></div><LoginForm session={workspace.session} connected={workspace.connection === 'ready'} onCompleted={completed}/></section>
      <aside className="login-explainer"><span className="login-explainer-icon"><ShieldCheck size={26}/></span><h2>You control the login.</h2><p>BizPlus records the outcome and explains the error. Every credential entry and retry stays with you.</p><ol><li><strong>Try a wrong password</strong><span>The form shows an error and creates an incident.</span></li><li><strong>Open Investigation</strong><span>Review the rejected login and its captured evidence.</span></li><li><strong>Retry with correct credentials</strong><span>A successful manual login verifies recovery.</span></li></ol><p className="login-environment-note">This page uses an isolated demo account for controlled testing.</p></aside>
    </div>
  </div>;
}
