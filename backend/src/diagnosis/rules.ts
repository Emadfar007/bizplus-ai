import { createHash, randomUUID } from 'node:crypto';
import type { Diagnosis, Incident, Run, StepResult } from '@bizplus/shared';

export function diagnose(run: Run, step: StepResult): Diagnosis {
  const base = {
    source: 'rules' as const,
    observedFacts: [
      `${step.name} failed after ${step.durationMs} ms.`,
      step.httpStatus === null ? 'No completed HTTP response was captured.' : `The sandbox returned HTTP ${step.httpStatus}.`,
      ...step.assertions.filter(a => !a.passed).map(a => `${a.code}: expected ${a.expected}; observed ${a.actual}.`),
    ],
    evidenceIds: step.evidence.map(e => e.id),
  };
  if (step.errorCategory === 'business_outcome_missing' && run.orderId && run.paymentCount === 1) {
    return { ...base,
      summary: 'Checkout recorded one simulated payment, but the expected order confirmation is missing despite HTTP 200.',
      observedFacts: [...base.observedFacts, 'The sandbox ledger contains exactly one payment for this transaction.', 'The sandbox log records a paused confirmation worker.'],
      possibleCauses: ['The paused sandbox confirmation worker is consistent with the missing business outcome.'],
      recommendedAction: 'resume_receipt_worker',
      guidance: 'Approve resuming the original order’s confirmation worker. Verification reads the same order and checks that the payment count remains one. Checkout is never replayed.',
    };
  }
  if (step.httpStatus === 500) return { ...base,
    summary: 'Checkout returned HTTP 500 before any simulated payment was created.',
    possibleCauses: ['The owned sandbox injected a server failure. In a real service, application or dependency logs would be needed to establish the root cause.'],
    recommendedAction: null,
    guidance: 'Inspect the captured checkout log and service response. Start a separate healthy synthetic run to confirm availability; this incident has no automated recovery action.',
  };
  if (step.errorCategory === 'timeout') return { ...base,
    summary: `${step.name} exceeded the configured request deadline.`,
    possibleCauses: ['A slow service or dependency may have delayed the response. A timeout alone does not establish the underlying cause.'],
    recommendedAction: null,
    guidance: 'Inspect service timings and dependencies. Do not repeat checkout when payment completion is uncertain.',
  };
  if (step.httpStatus === 401) return { ...base,
    summary: 'The sandbox rejected the workflow authentication.', possibleCauses: ['An invalid or missing synthetic session token may explain the response.'],
    recommendedAction: null, guidance: 'Inspect the authentication response and token handoff. Root cause remains unconfirmed.',
  };
  if (step.errorCategory === 'interrupted') return { ...base,
    summary: 'The backend restarted before the workflow completed.', possibleCauses: ['The runner process stopped during execution.'],
    recommendedAction: null, guidance: 'The original run is retained as interrupted. Start a new synthetic run; do not replay payment operations from the old run.',
  };
  return { ...base, summary: `${step.name} did not satisfy the captured response assertions.`,
    possibleCauses: ['An unexpected response, network issue, or changed service contract may explain the failure. The available evidence does not prove a root cause.'],
    recommendedAction: null, guidance: 'Compare expected and actual response evidence, then inspect the owned sandbox logs.',
  };
}

export function createIncident(run: Run, step: StepResult): Incident {
  const failedAssertions = step.assertions.filter(a => !a.passed).map(a => a.code).sort();
  const fingerprint = createHash('sha256').update(JSON.stringify({ workflow: run.workflowId, step: step.id, endpoint: step.path, category: step.errorCategory, status: step.httpStatus, assertions: failedAssertions })).digest('hex').slice(0, 16);
  return {
    id: randomUUID(), runId: run.id, workflowId: run.workflowId,
    title: step.errorCategory === 'business_outcome_missing' ? 'Payment succeeded. Confirmation missing.' : `${step.name} failed`,
    status: 'open', createdAt: new Date().toISOString(), resolvedAt: null,
    failedStepId: step.id, fingerprint, diagnosis: diagnose(run, step),
    evidence: step.evidence, recovery: null, relatedIncidentIds: [],
  };
}
