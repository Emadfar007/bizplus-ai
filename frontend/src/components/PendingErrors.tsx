import { useEffect, useState } from 'react';
import { CloudOff, RefreshCw } from 'lucide-react';
import { flushErrorReports, pendingErrorReports, subscribeErrorReports } from '../services/errors';
import { SectionLabel } from './UI';

export function usePendingErrors(session: string) {
  const [pending, setPending] = useState(() => pendingErrorReports(session));
  useEffect(() => {
    setPending(pendingErrorReports(session));
    return subscribeErrorReports(() => setPending(pendingErrorReports(session)));
  }, [session]);
  return pending;
}

export default function PendingErrors({ session, pending }: { session: string; pending: ReturnType<typeof pendingErrorReports> }) {
  if (!pending.length) return null;
  return <section className="panel pending-errors" aria-label="Errors waiting to be saved">
    <div className="panel-header"><div><SectionLabel>CAPTURED ON THIS DEVICE</SectionLabel><h2>{pending.length} error{pending.length === 1 ? '' : 's'} waiting to be saved</h2></div><CloudOff size={22}/></div>
    <p>These errors are visible here while reporting is unavailable. BizPlus will send them to your Investigation history when the connection returns.</p>
    <ul>{pending.map(item => <li key={item.eventId}><strong>{item.message}</strong><span>{item.path} · {item.httpStatus ? `HTTP ${item.httpStatus}` : item.source}</span></li>)}</ul>
    <button className="secondary-button" onClick={() => void flushErrorReports(session)}><RefreshCw size={16}/> Retry saving errors</button>
  </section>;
}
