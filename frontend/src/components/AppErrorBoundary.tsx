import { Component, type ErrorInfo, type ReactNode } from 'react';
import { currentErrorReportingSession, reportError } from '../services/errors';

interface Props { children: ReactNode }
interface State { failed: boolean; incidentId?: string }

/** A rendering failure stays readable; recovery and login remain explicit user actions. */
export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };
  static getDerivedStateFromError(): State { return { failed: true }; }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    const session = currentErrorReportingSession();
    void reportError(session, { source: 'browser', code: 'BROWSER_RENDER_ERROR', path: window.location.pathname }).then(result => {
      if (session === currentErrorReportingSession() && result.incidentId) this.setState({ incidentId: result.incidentId });
    });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="login-page" style={{ minHeight: '100vh', display: 'grid', placeContent: 'center', padding: '2rem' }}>
      <section className="panel" style={{ maxWidth: '36rem', padding: '2rem' }} role="alert">
        <h1>This page could not load</h1>
        <p>BizPlus detected a display error. Review the incident in Investigation, or reload the page when you are ready.</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', marginTop: '1.5rem' }}>
          <a className="primary-button" href={this.state.incidentId ? `/incidents/${this.state.incidentId}` : '/incidents'}>Open Investigation</a>
          <button className="secondary-button" onClick={() => window.location.reload()}>Reload page</button>
        </div>
        <p style={{ fontSize: '0.85rem', marginTop: '1rem' }}>If the backend is offline, this error will be queued until the connection returns.</p>
      </section>
    </main>;
  }
}
