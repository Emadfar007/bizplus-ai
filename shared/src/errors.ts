/** Only categorical error metadata belongs in Investigation; never submit request bodies or raw exceptions. */
export const APPLICATION_ERROR_SOURCES = ['browser', 'api', 'payment', 'live', 'observer'] as const;
export type ApplicationErrorSource = typeof APPLICATION_ERROR_SOURCES[number];
export const APPLICATION_ERROR_CODES = [
  'API_HTTP_ERROR', 'API_TIMEOUT', 'API_NETWORK_ERROR', 'API_INVALID_RESPONSE',
  'BROWSER_RUNTIME_ERROR', 'BROWSER_UNHANDLED_REJECTION', 'BROWSER_RENDER_ERROR', 'BROWSER_VALIDATION_ERROR', 'BROWSER_RESOURCE_ERROR',
  'PAYMENT_CHECKOUT_LOAD_FAILED', 'PAYMENT_FAILED',
  'LIVE_CHECK_FAILED', 'OBSERVER_CHECK_FAILED', 'OBSERVER_MONITOR_ERROR', 'OBSERVER_UNAVAILABLE', 'OBSERVER_AUTHENTICATION_FAILED',
  'INVALID_REQUEST', 'INVALID_JSON', 'BODY_TOO_LARGE', 'NOT_FOUND', 'RATE_LIMITED',
  'INTERNAL_ERROR', 'LOGIN_REJECTED', 'INVALID_LOGIN_REQUEST', 'DATABASE_UNAVAILABLE',
  'RAZORPAY_NOT_CONFIGURED', 'PROVIDER_UNAVAILABLE', 'PAYMENT_SIGNATURE_INVALID',
  'PAYMENT_MISMATCH', 'CAPTURE_NOT_CONFIRMED', 'ORDER_CREATION_FAILED', 'ORDER_CREATION_UNKNOWN',
] as const;
export type ApplicationErrorCode = typeof APPLICATION_ERROR_CODES[number];
export const OBSERVER_CHECK_KEYS = ['availability', 'readiness', 'storefront', 'storefront_browser', 'synthetic_workflow'] as const;
export type ObserverCheckKey = typeof OBSERVER_CHECK_KEYS[number];
export interface ErrorReport {
  source: ApplicationErrorSource;
  code?: ApplicationErrorCode;
  /** Alias accepted for callers that classify runtime failures by kind. */
  kind?: ApplicationErrorCode;
  path?: string;
  httpStatus?: number;
  eventId?: string;
  liveRunId?: string;
  observerCheckId?: string;
  observerIncidentId?: string;
  observerCheckKey?: ObserverCheckKey;
  observedAt?: string;
  requiresManualLogin?: boolean;
  existingIncidentId?: string;
}
export interface ErrorReportResult {
  incidentId: string;
  runId: string;
  created: boolean;
  occurrenceCount: number;
  code: ApplicationErrorCode;
}
export interface ApplicationIncidentContext {
  source: ApplicationErrorSource;
  code: ApplicationErrorCode;
  path: string;
  httpStatus: number | null;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** A bounded recent UUID window makes retried reports idempotent, including after restart. */
  recentEventIds: string[];
  liveRunId?: string;
  observerCheckId?: string;
  /** Observer history IDs have their own bounded window so frequent check UUIDs cannot evict them. */
  observerIncidentIds?: string[];
  observerCheckKey?: ObserverCheckKey;
  requiresManualLogin?: boolean;
  verification?: { source: 'live' | 'observer'; completedAt: string; verificationRunId?: string; observerCheckId?: string };
}
