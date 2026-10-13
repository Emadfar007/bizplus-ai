import { Link } from 'react-router-dom';
import { ArrowRight, FileSearch, Globe2, ShoppingBag } from 'lucide-react';
import type { Incident } from '@bizplus/shared';
import { Badge, EvidencePanel, SectionLabel, time } from './UI';
import '../investigation.css';

export function incidentDestination(incident: Incident): string {
  const context = incident.application;
  if (context?.source === 'live' && context.liveRunId) return `/live-tests?run=${encodeURIComponent(context.liveRunId)}`;
  if (context?.source === 'observer') return '/live-tests#independent-monitor';
  if (context?.source === 'payment' || context?.path.startsWith('/api/shop') || context?.path === '/shop') return '/shop';
  if (context?.path === '/login' || context?.path.startsWith('/api/login')) return '/login';
  if (context?.path.startsWith('/api/live') || context?.path === '/live-tests') return '/live-tests';
  if (context && ['/workflows','/incidents','/recovery'].includes(context.path)) return context.path;
  return '/';
}

export function ApplicationIncidentAction({ incident }: { incident: Incident }) {
  const context = incident.application!;
  const label = context.source === 'live' ? 'Open live check and verify' : context.source === 'observer' ? 'Open independent monitor' : context.source === 'payment' || context.path.startsWith('/api/shop') || context.path === '/shop' ? 'Review storefront and saved order' : 'Open affected page';
  return <>
    <div className="application-incident-details"><span>Source <strong>{context.source}</strong></span><span>Occurrences <strong>{context.occurrenceCount}</strong></span><span>Last observed <strong>{time(context.lastSeenAt)}</strong></span></div>
    <Link className="primary-button" to={incidentDestination(incident)}>{context.source === 'live' || context.source === 'observer' ? <Globe2 size={17}/> : context.source === 'payment' ? <ShoppingBag size={17}/> : <FileSearch size={17}/>} {label}<ArrowRight size={16}/></Link>
    <p className="application-incident-note">{context.requiresManualLogin ? 'Only a login submitted by you can verify authentication.' : 'Follow the evidence and check the affected operation. Login and payment retries remain under your control.'}</p>
  </>;
}

export default function ApplicationIncidentReview({ incident }: { incident: Incident }) {
  return <>
    <div className="page-heading"><SectionLabel>ERROR INVESTIGATION</SectionLabel><h1>Review the captured error</h1><p>{incident.diagnosis.summary}</p></div>
    <section className="panel application-review"><div className="panel-header"><h2>{incident.title}</h2><Badge status={incident.status}/></div><p>{incident.diagnosis.guidance}</p><ApplicationIncidentAction incident={incident}/><Link className="text-button" to={`/incidents/${incident.id}`}><FileSearch size={16}/> Open original Investigation</Link></section>
    <EvidencePanel evidence={incident.evidence}/>
  </>;
}
