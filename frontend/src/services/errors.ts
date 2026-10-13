/** Safe operational events only. Never pass credentials, responses or exception text here. */
export type ErrorSource = 'api' | 'browser' | 'payment' | 'live' | 'observer';
export interface ErrorReport {
  source: ErrorSource;
  code: string;
  path: string;
  httpStatus?: number;
}
export interface ErrorReportResult { incidentId?: string }
export interface PendingErrorReport extends ErrorReport { eventId: string; createdAt: number; message: string }
interface QueuedReport extends ErrorReport { session: string; eventId: string; createdAt: number }

const ERROR_API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const QUEUE_KEY = 'bizplus.safe-errors.v1';
const MAX_QUEUE = 40;
const MAX_AGE = 24 * 60 * 60 * 1000;
const DEDUPE_MS = 30000;
const REPORT_TIMEOUT = 2500;
const SESSION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCES = new Set<ErrorSource>(['api', 'browser', 'payment', 'live', 'observer']);
const CODES = new Set([
  'API_HTTP_ERROR', 'API_TIMEOUT', 'API_NETWORK_ERROR', 'API_INVALID_RESPONSE',
  'BROWSER_RUNTIME_ERROR', 'BROWSER_UNHANDLED_REJECTION', 'BROWSER_RENDER_ERROR', 'BROWSER_VALIDATION_ERROR', 'BROWSER_RESOURCE_ERROR',
  'NOT_FOUND',
  'PAYMENT_CHECKOUT_LOAD_FAILED', 'PAYMENT_FAILED',
]);
const ROUTE_PARTS = new Set(['api', 'health', 'errors', 'login', 'config', 'shop', 'products', 'orders', 'verify', 'recover', 'incidents', 'recovery', 'workflows', 'metrics', 'runs', 'live', 'targets', 'lab', 'observer', 'live-tests']);
const PUBLIC_MESSAGES: Record<string, string> = {
  API_HTTP_ERROR: 'The backend rejected a request.',
  API_TIMEOUT: 'The backend took too long to respond.',
  API_NETWORK_ERROR: 'The backend could not be reached.',
  API_INVALID_RESPONSE: 'The backend returned an unreadable response.',
  BROWSER_RUNTIME_ERROR: 'An unexpected browser error interrupted the page.',
  BROWSER_UNHANDLED_REJECTION: 'A browser operation did not complete.',
  BROWSER_RENDER_ERROR: 'The page could not be displayed.',
  BROWSER_VALIDATION_ERROR: 'The submitted input did not meet the required validation.',
  BROWSER_RESOURCE_ERROR: 'A resource needed by this page could not load.',
  NOT_FOUND: 'The requested page was not found.',
  PAYMENT_CHECKOUT_LOAD_FAILED: 'The payment checkout could not load.',
  PAYMENT_FAILED: 'The payment provider rejected the test payment.',
};
let reportingSession = '';
let installed = false;
let queue: QueuedReport[] = [];
const inFlight = new Map<string, Promise<ErrorReportResult>>();
const recent = new Map<string, { createdAt: number; eventId: string; incidentId?: string }>();
const sendingTimes = new Map<string, number[]>();
const subscribers = new Set<() => void>();
let flushing = false;

/** Routes identify the failing operation; queries and fragments may contain secrets. */
export function safeErrorPath(path: string): string {
  try {
    const pathname = new URL(path, window.location.origin).pathname;
    // Keep known route names and replace dynamic values rather than storing user input.
    return pathname.split('/').map(part => ROUTE_PARTS.has(part) ? part : part ? ':id' : '').join('/').slice(0, 180) || '/';
  } catch { return '/'; }
}

function saveQueue() {
  queue = queue.filter(item => item.createdAt > Date.now() - MAX_AGE).slice(-MAX_QUEUE);
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); } catch { /* Memory queue remains available. */ }
  for (const listener of subscribers) { try { listener(); } catch { /* UI listeners cannot prevent safe reporting. */ } }
}
function normalizeReport(report: ErrorReport): ErrorReport {
  return {
    source: SOURCES.has(report.source) ? report.source : 'browser',
    code: CODES.has(report.code) ? report.code : 'BROWSER_RUNTIME_ERROR',
    path: safeErrorPath(report.path),
    ...(Number.isInteger(report.httpStatus) && report.httpStatus! >= 100 && report.httpStatus! <= 599 ? { httpStatus: report.httpStatus } : {}),
  };
}
function restoreQueue() {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    if (!Array.isArray(saved)) return;
    queue = saved.slice(-MAX_QUEUE).filter((item): item is QueuedReport => !!item && typeof item === 'object'
      && SESSION_PATTERN.test(item.session) && SESSION_PATTERN.test(item.eventId)
      && Number.isFinite(item.createdAt) && item.createdAt <= Date.now() && item.createdAt > Date.now() - MAX_AGE
      && SOURCES.has(item.source) && CODES.has(item.code) && typeof item.path === 'string')
      .map(item => ({ ...normalizeReport(item), session: item.session, eventId: item.eventId, createdAt: item.createdAt }));
  } catch { /* Invalid or unavailable storage is ignored. */ }
}

export function setErrorReportingSession(session: string) {
  if (SESSION_PATTERN.test(session)) reportingSession = session;
}
export function currentErrorReportingSession() { return reportingSession; }
export function linkedIncidentId(value: unknown): string | undefined {
  return typeof value === 'string' && SESSION_PATTERN.test(value) ? value : undefined;
}
export function pendingErrorReports(session: string): PendingErrorReport[] {
  return queue.filter(item => item.session === session && item.createdAt > Date.now() - MAX_AGE)
    .map(({ session: _session, ...item }) => ({ ...item, message: PUBLIC_MESSAGES[item.code] || PUBLIC_MESSAGES.BROWSER_RUNTIME_ERROR }));
}
export function subscribeErrorReports(listener: () => void): () => void {
  subscribers.add(listener);
  return () => { subscribers.delete(listener); };
}

function maySend(session: string): boolean {
  const times = (sendingTimes.get(session) || []).filter(time => time > Date.now() - 60000);
  if (times.length >= 8) { sendingTimes.set(session, times); return false; }
  times.push(Date.now()); sendingTimes.set(session, times);
  if (sendingTimes.size > 16) sendingTimes.delete(sendingTimes.keys().next().value!);
  return true;
}
function sendReport(item: QueuedReport): Promise<ErrorReportResult> {
  const pending = inFlight.get(item.eventId);
  if (pending) return pending;
  if (!maySend(item.session)) return Promise.resolve({});
  const promise = (async (): Promise<ErrorReportResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REPORT_TIMEOUT);
    try {
      const response = await fetch(`${ERROR_API_BASE}/api/errors`, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Demo-Session': item.session },
        // Explicit allowlist: queue metadata, payloads and exceptions are never sent.
        body: JSON.stringify({ source: item.source, code: item.code, path: item.path, httpStatus: item.httpStatus, eventId: item.eventId }),
      });
      if (!response.ok) return {};
      const result = await response.json().catch(() => null);
      const id = result?.incidentId || result?.incident?.id;
      if (typeof id !== 'string' || !SESSION_PATTERN.test(id)) return {};
      queue = queue.filter(queued => queued.eventId !== item.eventId); saveQueue();
      for (const value of recent.values()) if (value.eventId === item.eventId) value.incidentId = id;
      window.dispatchEvent(new CustomEvent('bizplus:incident-reported', { detail: { session: item.session, incidentId: id } }));
      void flushErrorReports(item.session);
      return { incidentId: id };
    } catch { return {}; }
    finally { clearTimeout(timer); inFlight.delete(item.eventId); }
  })();
  inFlight.set(item.eventId, promise);
  return promise;
}

export async function reportError(session: string, report: ErrorReport): Promise<ErrorReportResult> {
  if (!SESSION_PATTERN.test(session)) return {};
  const safe = normalizeReport(report);
  const fingerprint = `${session}:${safe.source}:${safe.code}:${safe.path}:${safe.httpStatus || 0}`;
  for (const [key, item] of recent) if (item.createdAt < Date.now() - DEDUPE_MS) recent.delete(key);
  const known = recent.get(fingerprint);
  if (known) {
    if (known.incidentId) return { incidentId: known.incidentId };
    const item = queue.find(queued => queued.eventId === known.eventId);
    return item ? sendReport(item) : {};
  }
  const item: QueuedReport = { ...safe, session, eventId: crypto.randomUUID(), createdAt: Date.now() };
  recent.set(fingerprint, { createdAt: item.createdAt, eventId: item.eventId });
  if (recent.size > 128) recent.delete(recent.keys().next().value!);
  queue.push(item); saveQueue();
  return sendReport(item);
}

/** Flush only events belonging to this session; a fresh session never inherits errors. */
export async function flushErrorReports(session: string): Promise<void> {
  if (flushing || !SESSION_PATTERN.test(session) || !queue.some(item => item.session === session)) return;
  flushing = true;
  try {
    saveQueue();
    for (const item of queue.filter(item => item.session === session).slice(0, 8)) {
      const result = await sendReport(item);
      if (!result.incidentId) break;
    }
  } finally { flushing = false; }
}

/** Call after a successful API response: recording errors must not block normal reads. */
export function notifyApiReachable(session: string) { void flushErrorReports(session); }

export function installBrowserErrorReporting(session: string) {
  setErrorReportingSession(session);
  if (installed) return;
  installed = true; restoreQueue();
  window.addEventListener('error', (event: Event) => {
    if (event instanceof ErrorEvent) {
      if (event.error && typeof event.error === 'object' && (linkedIncidentId(event.error.incidentId) || event.error.reportedToInvestigation === true)) return;
      void reportError(reportingSession, { source: 'browser', code: 'BROWSER_RUNTIME_ERROR', path: window.location.pathname });
      return;
    }
    // Resource errors do not bubble. Report the current page, never the asset URL.
    if (!(event.target instanceof HTMLElement) || event.target.matches('script[data-bizplus-razorpay]')) return;
    void reportError(reportingSession, { source: 'browser', code: 'BROWSER_RESOURCE_ERROR', path: window.location.pathname });
  }, true);
  window.addEventListener('unhandledrejection', event => {
    if (event.reason && typeof event.reason === 'object' && (linkedIncidentId(event.reason.incidentId) || event.reason.reportedToInvestigation === true)) return;
    void reportError(reportingSession, { source: 'browser', code: 'BROWSER_UNHANDLED_REJECTION', path: window.location.pathname });
  });
  window.addEventListener('online', () => { void flushErrorReports(reportingSession); });
}
