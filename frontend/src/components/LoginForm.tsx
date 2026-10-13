import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, FileSearch, LayoutDashboard, Loader2, LockKeyhole, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { LoginConfig, LoginResult } from '@bizplus/shared';
import { loginApi } from '../services/login';
import { reportError } from '../services/errors';
import '../login.css';

export interface LoginFormProps {
  session: string;
  source?: 'login' | 'live_test';
  incidentId?: string;
  labRevision?: string;
  connected?: boolean;
  onCompleted?: (result: LoginResult) => void | Promise<void>;
}

export function LoginForm({ session, source = 'login', incidentId, labRevision, connected = true, onCompleted }: LoginFormProps) {
  const id = useId();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [config, setConfig] = useState<LoginConfig | null>(null);
  const [result, setResult] = useState<LoginResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ username?: string; password?: string }>({});
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const activeRequest = useRef(false);
  const generation = useRef(0);
  const failedIncident = useRef<string | undefined>(undefined);

  useEffect(() => {
    generation.current += 1;
    activeRequest.current = false;
    failedIncident.current = undefined;
    setUsername(''); setPassword(''); setResult(null); setBusy(false); setError(null); setFieldErrors({});
    return () => { generation.current += 1; };
  }, [session, incidentId, source]);

  useEffect(() => {
    let cancelled = false;
    setConfig(null);
    if (connected) void loginApi.config(session).then(value => { if (!cancelled) setConfig(value); }).catch(() => { /* Login remains available while account hints are unavailable. */ });
    return () => { cancelled = true; };
  }, [session, connected]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (activeRequest.current || !connected) return;
    const validation = {
      username: username.trim() ? undefined : 'Enter your username.',
      password: password ? undefined : 'Enter your password.',
    };
    setFieldErrors(validation);
    if (validation.username || validation.password) {
      (validation.username ? usernameRef : passwordRef).current?.focus();
      void reportError(session, { source: 'browser', code: 'BROWSER_VALIDATION_ERROR', path: window.location.pathname });
      return;
    }
    const requestGeneration = generation.current;
    const submittedPassword = password;
    activeRequest.current = true;
    setBusy(true); setError(null); setResult(null); setPassword('');
    try {
      const response = await loginApi.submit(session, {
        username,
        password: submittedPassword,
        source,
        ...(incidentId || failedIncident.current ? { incidentId: incidentId || failedIncident.current } : {}),
        ...(labRevision ? { labRevision } : {}),
      });
      if (generation.current !== requestGeneration) return;
      setResult(response);
      if (response.status === 'rejected' && response.incidentId) failedIncident.current = response.incidentId;
      else if (response.status === 'successful') failedIncident.current = undefined;
      try { void Promise.resolve(onCompleted?.(response)).catch(() => undefined); } catch { /* Workspace refresh does not alter the login result. */ }
      if (response.status === 'rejected') passwordRef.current?.focus();
    } catch (cause) {
      if (generation.current === requestGeneration) setError(cause instanceof Error ? cause.message : 'Unable to complete the login. Please try again.');
    } finally {
      if (generation.current === requestGeneration) { activeRequest.current = false; setBusy(false); }
    }
  }

  const recovery = Boolean(incidentId || failedIncident.current);
  if (source === 'live_test' && result?.status === 'successful') return <div className="login-form-shell login-live-success">
    <span className="login-success-icon"><CheckCircle2 size={28}/></span>
    <h3>Login successful</h3>
    <p>Your credentials were accepted. {result.recovery?.status === 'verified' ? 'Your manual retry verified recovery and resolved the original incident.' : 'Your simple business dashboard is ready.'}</p>
    <div className="login-live-dashboard-links">
      <Link className="secondary-button" to="/"><LayoutDashboard size={17}/> Open dashboard <ArrowRight size={15}/></Link>
      <Link className="secondary-button" to={result.incidentId ? `/incidents/${encodeURIComponent(result.incidentId)}` : '/incidents'}><FileSearch size={17}/> {result.incidentId ? 'View recovered incident' : 'Investigation'}</Link>
    </div>
    <button type="button" className="text-button" onClick={() => { setResult(null); setUsername(''); setPassword(''); failedIncident.current = undefined; }}>Try another login <ArrowRight size={15}/></button>
    <p className="login-privacy-note"><ShieldCheck size={15}/><span>This login was submitted by you and verified by the server.</span></p>
  </div>;

  return <div className="login-form-shell">
    <div className="login-manual-note"><LockKeyhole size={17}/><span>Human controlled login</span></div>
    <form className="login-form" onSubmit={event => void submit(event)} noValidate aria-label={recovery ? 'Manually verify login recovery' : 'Business login'}>
      <div className="login-field">
        <label htmlFor={`${id}-username`}>Username</label>
        <input ref={usernameRef} id={`${id}-username`} name="username" type="text" value={username} disabled={busy || !connected} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={128} required aria-invalid={Boolean(fieldErrors.username)} aria-describedby={fieldErrors.username ? `${id}-username-error` : undefined} onChange={event => { setUsername(event.target.value); setFieldErrors(previous => ({ ...previous, username: undefined })); }}/>
        {fieldErrors.username ? <p id={`${id}-username-error`} className="login-field-error" role="alert">{fieldErrors.username}</p> : null}
      </div>
      <div className="login-field">
        <label htmlFor={`${id}-password`}>Password</label>
        <input ref={passwordRef} id={`${id}-password`} name="password" type="password" value={password} disabled={busy || !connected} autoComplete="off" maxLength={256} required aria-invalid={Boolean(fieldErrors.password)} aria-describedby={fieldErrors.password ? `${id}-password-error` : undefined} onChange={event => { setPassword(event.target.value); setFieldErrors(previous => ({ ...previous, password: undefined })); }}/>
        {fieldErrors.password ? <p id={`${id}-password-error`} className="login-field-error" role="alert">{fieldErrors.password}</p> : null}
      </div>
      <button type="submit" className="primary-button login-submit" disabled={busy || !connected}>{busy ? <Loader2 className="spin" size={18}/> : <LockKeyhole size={17}/>}<span>{busy ? 'Checking credentials…' : recovery ? 'Log in and verify recovery' : 'Log in'}</span>{!busy ? <ArrowRight size={17}/> : null}</button>
      {!connected ? <p className="login-connection-note" role="status">Waiting for the backend connection.</p> : null}
    </form>
    {result?.status === 'rejected' ? <div className="login-result rejected" role="alert"><TriangleAlert size={20}/><div><strong>Invalid username or password</strong><p>The rejected login was recorded. Enter the correct credentials yourself to verify recovery.</p>{result.incidentId ? <Link className="text-button" to={`/incidents/${encodeURIComponent(result.incidentId)}`}><FileSearch size={16}/> Open investigation <ArrowRight size={15}/></Link> : null}</div></div> : null}
    {result?.status === 'successful' ? <div className="login-result successful" role="status"><CheckCircle2 size={20}/><div><strong>Login successful</strong><p>{result.recovery?.status === 'verified' ? 'Your manual retry verified recovery and resolved the original incident.' : 'Your credentials were accepted.'}</p>{result.incidentId ? <Link className="text-button" to={`/incidents/${encodeURIComponent(result.incidentId)}`}><FileSearch size={16}/> View recovered incident <ArrowRight size={15}/></Link> : <Link className="text-button" to="/">Open dashboard <ArrowRight size={15}/></Link>}</div></div> : null}
    {error ? <div className="login-result rejected" role="alert"><TriangleAlert size={20}/><div><strong>Login could not be checked</strong><p>{error}</p></div></div> : null}
    {config?.defaultCredentials && config.username && config.password ? <div className="login-demo-account"><span>CONTROLLED DEMO ACCOUNT</span><p>Username <code>{config.username}</code><br/>Password <code>{config.password}</code></p></div> : config ? <p className="login-account-note">Use the credentials configured for this controlled test account.</p> : null}
    <p className="login-privacy-note"><ShieldCheck size={15}/><span>You type and submit every login. Passwords are cleared after submission and excluded from incident evidence.</span></p>
  </div>;
}

export default LoginForm;
