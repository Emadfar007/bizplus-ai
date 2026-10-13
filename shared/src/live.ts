import type { Assertion, Evidence } from './index.js';

export const LIVE_FAULTS = ['healthy', 'http_500', 'http_503', 'not_found', 'missing_content', 'empty_body', 'timeout', 'javascript_error', 'button_broken', 'login_401', 'payment_unavailable', 'database_unavailable'] as const;
export type LiveFault = typeof LIVE_FAULTS[number];
export interface LiveTarget { id: string; name: string; url: string; expectedStatus: number; containsText?: string }
export type LiveEvidence = Evidence;
export interface LiveDiagnosis { source: 'rules'; category: string; summary: string; observedFacts: string[]; possibleCauses: string[]; confirmedCause: string | null; solutions: string[]; evidenceIds: string[] }
export interface LiveRecovery { status: 'verified' | 'failed'; verificationRunId: string; completedAt: string }
export interface LiveRun {
  id: string; targetId: string; url: string; status: 'queued' | 'running' | 'passed' | 'failed'; httpStatus: number | null; durationMs: number; startedAt: string; completedAt: string | null; error: string | null; message: string; assertions: Assertion[];
  evidence: { responseBytes: number; title?: string; excerpt?: string; events?: LiveEvidence[] };
  fingerprint: string | null; diagnosis?: LiveDiagnosis; incidentStatus?: 'open' | 'resolved'; recovery?: LiveRecovery; labRevision?: string;
  /** Stable link to the unified Investigation record; avoids replaying imported failures. */
  investigationIncidentId?: string;
}
export interface LiveLabState { sessionId: string; fault: LiveFault; expiresAt: string | null; revision: string; targetId: 'bizplus-fault-lab'; url: string; maxDurationSeconds: number; safety: { isolated: true; syntheticPayments: true } }
export interface LiveMonitoring { enabled: boolean; intervalSeconds: number; scope: 'recent-sessions' | 'independent-owned-targets'; independentObserver: boolean }
export interface LiveTargetList { targets: LiveTarget[]; configured: boolean; monitoring?: LiveMonitoring }
export interface LiveRunList { runs: LiveRun[] }
export interface LiveRecoveryResponse { runId: string; verificationRunId: string; status: 'verified' | 'failed' }
