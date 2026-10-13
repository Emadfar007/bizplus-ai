import type { LoginIncidentContext, LoginRecoveryResult } from './login.js';
import type { ApplicationIncidentContext } from './errors.js';
export type Scenario = 'healthy' | 'checkout_500' | 'receipt_order_missing' | 'manual_login' | 'application_error';
export type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
export type RunStatus = 'queued' | 'running' | 'passed' | 'failed';
export type IncidentStatus = 'open' | 'recovering' | 'resolved';
export const SCENARIOS: { id: Scenario; name: string; description: string }[] = [
  { id: 'healthy', name: 'Healthy transaction', description: 'Complete the customer journey and verify the order.' },
  { id: 'checkout_500', name: 'Checkout unavailable', description: 'Inject an HTTP 500 before any simulated payment is created.' },
  { id: 'receipt_order_missing', name: 'Missing confirmation', description: 'HTTP 200 returns, but a paused worker leaves the order confirmation missing.' },
];
export interface Assertion { code: string; expected: string; actual: string; passed: boolean }
export interface Evidence { id: string; kind: 'response' | 'log' | 'assertion' | 'recovery'; timestamp: string; message: string; data?: Record<string, unknown> }
export interface StepResult { id: string; name: string; method: string; path: string; status: StepStatus; expected: string; actual: string; durationMs: number; httpStatus: number | null; startedAt: string | null; completedAt: string | null; assertions: Assertion[]; evidence: Evidence[]; errorCategory?: string }
export interface Workflow { id: string; name: string; description: string; steps: { id: string; name: string; expected: string }[]; scenarios: typeof SCENARIOS }
export interface Run { id: string; workflowId: string; scenario: Scenario; status: RunStatus; createdAt: string; completedAt: string | null; durationMs: number; steps: StepResult[]; incidentId: string | null; orderId: string | null; transactionId: string | null; amountMinor: number; paymentCount: number }
export interface Diagnosis { source: 'rules'; summary: string; observedFacts: string[]; possibleCauses: string[]; evidenceIds: string[]; recommendedAction: 'resume_receipt_worker' | null; guidance: string }
export interface RecoveryResult { id: string; action: 'resume_receipt_worker'; status: 'verified' | 'failed'; approvedAt: string; completedAt: string; durationMs: number; originalOrderId: string | null; paymentCountBefore: number; paymentCountAfter: number; verification: StepResult; evidence: Evidence[] }
export interface Incident { id: string; runId: string; workflowId: string; title: string; status: IncidentStatus; createdAt: string; resolvedAt: string | null; failedStepId: string; fingerprint: string; diagnosis: Diagnosis; evidence: Evidence[]; recovery: RecoveryResult | null; relatedIncidentIds: string[]; login?: LoginIncidentContext; manualRecovery?: LoginRecoveryResult; application?: ApplicationIncidentContext }
export interface FingerprintGroup { fingerprint: string; title: string; count: number; incidentIds: string[] }
export interface IncidentList { incidents: Incident[]; groups: FingerprintGroup[] }
export interface Metrics { totalRuns: number; passedRuns: number; failedRuns: number; successRate: number; averageDurationMs: number; openIncidents: number; verifiedRecoveries: number; averageRecoveryMs: number; recentRuns: Run[]; chart: { runId: string; timestamp: string; durationMs: number; passed: boolean }[]; instanceId: string; instanceStartedAt: string; historyPolicy: 'temporary' | 'local' | 'cloud' }
export interface Health { status: 'ok'; app: 'BizPlus AI'; instanceId: string; instanceStartedAt: string; historyPolicy: 'temporary' | 'local' | 'cloud'; diagnosis: 'rules' }
export interface ApiError { error: string; code: string }
export type { Product, CommerceOrderLine, CommerceOrderStatus, CommerceOrder, CommerceConfig, CommerceCheckout, CommercePaymentVerification } from './commerce.js';
export * from './live.js';
export * from './login.js';
export * from './errors.js';
