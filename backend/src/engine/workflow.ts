import { randomUUID } from 'node:crypto';
import { SCENARIOS } from '@bizplus/shared';
import type { Assertion, Evidence, Health, Metrics, RecoveryResult, Run, Scenario, StepResult, Workflow } from '@bizplus/shared';
import { AMOUNT_MINOR, PRODUCT_ID } from '../database/store.js';
import type { DataStore } from '../database/types.js';
import { createIncident } from '../diagnosis/rules.js';

const specs = [
  { id: 'login', name: 'Login', method: 'POST', path: '/sandbox/login', expected: 'Authenticated synthetic session token' },
  { id: 'inventory', name: 'Inventory', method: 'GET', path: '/sandbox/inventory', expected: 'Requested product is available at the expected price' },
  { id: 'cart', name: 'Cart', method: 'POST', path: '/sandbox/cart', expected: 'One product with matching amount and quantity' },
  { id: 'checkout', name: 'Checkout', method: 'POST', path: '/sandbox/checkout', expected: 'Exactly one simulated payment with matching amount' },
  { id: 'confirmation', name: 'Order confirmation', method: 'GET', path: '/sandbox/orders/:orderId', expected: 'Confirmed original order with matching amount and transaction' },
];
export const WORKFLOW: Workflow = {
  id: 'commerce-checkout', name: 'Customer checkout journey',
  description: 'Verify the business outcome across login, inventory, cart, payment, and order confirmation.',
  steps: specs.map(({ id, name, expected }) => ({ id, name, expected })), scenarios: SCENARIOS,
};
export class WorkflowError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export interface EngineOptions {
  stepTimeoutMs: number;
  recoveryVerificationFault?: (run: Run) => boolean;
}

function blankStep(spec: typeof specs[number]): StepResult {
  return { ...spec, status: 'pending', actual: 'Waiting to run', durationMs: 0, httpStatus: null, startedAt: null, completedAt: null, assertions: [], evidence: [] };
}
function evidence(kind: Evidence['kind'], message: string, data?: Record<string, unknown>): Evidence {
  return { id: randomUUID(), kind, timestamp: new Date().toISOString(), message, ...(data ? { data } : {}) };
}
function assertion(code: string, expected: string, actual: unknown, passed: boolean): Assertion {
  return { code, expected, actual: typeof actual === 'string' ? actual : JSON.stringify(actual) ?? 'undefined', passed };
}
type Payload = Record<string, unknown>;
const asObject = (value: unknown): Payload => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Payload : {};
const stepPassed = (step: StepResult): boolean => step.status === 'passed';
const stepFailed = (step: StepResult): boolean => step.status === 'failed';

export class Engine {
  private baseUrl = '';
  private activeRuns = new Map<string, Promise<void>>();
  private activeRunIds = new Map<string, string>();
  private activeRecoveries = new Map<string, Promise<RecoveryResult>>();
  readonly health: Health;
  constructor(readonly store: DataStore, readonly nonce: string, private options: EngineOptions, historyPolicy: Health['historyPolicy']) {
    this.health = { status: 'ok', app: 'BizPlus AI', instanceId: randomUUID(), instanceStartedAt: new Date().toISOString(), historyPolicy, diagnosis: 'rules' };
  }
  async initialize(): Promise<void> {
    const store = this.store;
    await store.recoverInterruptedIncidents();
    for (const { session, run } of await store.unfinishedRuns()) {
      const failed = run.steps.find(s => s.status === 'running') ?? run.steps.find(s => s.status === 'pending');
      if (failed) {
        failed.status = 'failed'; failed.errorCategory = 'interrupted'; failed.actual = 'Backend restarted during execution'; failed.completedAt = new Date().toISOString();
        failed.evidence.push(evidence('log', failed.actual));
        for (const step of run.steps) if (step.status === 'pending') { step.status = 'skipped'; step.actual = 'Skipped after interruption'; }
        run.status = 'failed'; run.completedAt = new Date().toISOString(); run.paymentCount = await store.paymentCount(run.id);
        const incident = createIncident(run, failed); run.incidentId = incident.id;
        await store.saveRun(session, run); await store.saveIncident(session, incident);
      }
    }
  }
  setBaseUrl(url: string): void { this.baseUrl = url; }

  async enqueue(session: string, scenario: Scenario): Promise<Run> {
    await this.waitForFinalizingRun(session);
    if (this.activeRuns.has(session)) throw new WorkflowError(409, 'RUN_ACTIVE', 'A workflow is already running for this demo session.');
    if (this.activeRuns.size >= 20) throw new WorkflowError(429, 'RUNNER_BUSY', 'The demo runner is busy. Try again shortly.');
    const run: Run = { id: randomUUID(), workflowId: WORKFLOW.id, scenario, status: 'queued', createdAt: new Date().toISOString(), completedAt: null, durationMs: 0,
      steps: specs.map(blankStep), incidentId: null, orderId: null, transactionId: null, amountMinor: AMOUNT_MINOR, paymentCount: 0 };
    const saved = Promise.resolve(this.store.saveRun(session, run));
    const pending = saved.then(() => this.execute(session, run)).catch(error => console.error('Workflow execution could not persist:', error instanceof Error ? error.message : 'Database operation failed')).finally(() => { this.activeRuns.delete(session); this.activeRunIds.delete(session); });
    this.activeRunIds.set(session,run.id);
    this.activeRuns.set(session, pending);
    await saved;
    return run;
  }

  private async waitForFinalizingRun(session: string): Promise<void> {
    const completion = this.activeRuns.get(session), id = this.activeRunIds.get(session);
    if (!completion || !id) return;
    const persisted = await this.store.getRun(id,session);
    // PostgreSQL can expose its committed final result before the runner's write
    // acknowledgement arrives. Wait for that acknowledgement, rather than reject
    // a new action after the user has already observed a completed run.
    if (persisted?.completedAt && ['passed','failed'].includes(persisted.status)) await completion;
  }

  private async execute(session: string, run: Run): Promise<void> {
    const started = performance.now();
    let token = '';
    try {
      run.status = 'running'; await this.store.saveRun(session, run);
      for (const step of run.steps) {
        step.status = 'running'; step.startedAt = new Date().toISOString(); step.actual = 'HTTP request in progress'; await this.store.saveRun(session, run);
        const payload = step.id === 'login' ? { username: 'demo-shopper' } : step.id === 'cart' ? { productId: PRODUCT_ID, quantity: 1 } : step.id === 'checkout' ? { idempotencyKey: `checkout:${run.id}`, amountMinor: run.amountMinor } : undefined;
        const response = await this.request(run, step, token, payload);
        if (step.id === 'login' && typeof response.token === 'string') token = response.token;
        if (step.id === 'checkout' && stepPassed(step)) { run.orderId = String(response.orderId); run.transactionId = String(response.transactionId); }
        run.paymentCount = await this.store.paymentCount(run.id);
        await this.store.saveRun(session, run);
        if (stepFailed(step)) {
          for (const remaining of run.steps) if (remaining.status === 'pending') { remaining.status = 'skipped'; remaining.actual = `Skipped because ${step.name} failed`; }
          run.status = 'failed';
          const incident = createIncident(run, step); run.incidentId = incident.id;
          await this.store.saveIncident(session, incident);
          break;
        }
      }
      if (run.status === 'running') run.status = 'passed';
    } catch (error) {
      const step = run.steps.find(s => s.status === 'running') ?? run.steps[0]!;
      step.status = 'failed'; step.errorCategory = 'runner_error'; step.actual = error instanceof Error ? error.message : 'Unexpected runner error'; step.completedAt = new Date().toISOString();
      step.evidence.push(evidence('log', step.actual));
      for (const other of run.steps) if (other.status === 'pending') { other.status = 'skipped'; other.actual = 'Skipped after runner failure'; }
      run.status = 'failed'; run.paymentCount = await this.store.paymentCount(run.id);
      const incident = createIncident(run, step); run.incidentId = incident.id; await this.store.saveIncident(session, incident);
    } finally {
      run.durationMs = Math.round(performance.now() - started); run.completedAt = new Date().toISOString(); await this.store.saveRun(session, run);
    }
  }

  private async request(run: Run, step: StepResult, token: string, payload?: Payload, forceBadVerification = false): Promise<Payload> {
    const start = performance.now();
    let responseBody: Payload = {};
    const path = step.path.replace(':orderId', encodeURIComponent(run.orderId ?? 'missing'));
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: step.method, headers: { 'Content-Type': 'application/json', 'X-Sandbox-Key': this.nonce, 'X-Sandbox-Run': run.id, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(this.options.stepTimeoutMs),
      });
      step.httpStatus = response.status;
      const raw: unknown = await response.json(); responseBody = asObject(raw);
      if (forceBadVerification) responseBody = { ...responseBody, order: null, testVerificationFailure: true };
      const safeResponse = 'token' in responseBody ? { ...responseBody, token: '[redacted synthetic token]' } : responseBody;
      step.evidence.push(evidence('response', `${step.method} ${path} returned HTTP ${response.status}`, { status: response.status, body: safeResponse }));
      step.assertions = [assertion('HTTP_OK', 'HTTP 200', `HTTP ${response.status}`, response.status === 200), assertion('JSON_OBJECT', 'JSON response object', raw === null ? 'null' : typeof raw, raw !== null && typeof raw === 'object' && !Array.isArray(raw))];
      if (response.status === 200) step.assertions.push(...await this.validate(run, step.id, responseBody));
      step.status = step.assertions.every(a => a.passed) ? 'passed' : 'failed';
      if (step.status === 'failed') step.errorCategory = response.status !== 200 ? 'http_error' : step.id === 'confirmation' && !asObject(responseBody.order).orderId ? 'business_outcome_missing' : 'invalid_response';
      step.actual = step.status === 'passed' ? step.id === 'confirmation' ? 'Original order confirmed; amount and transaction match' : step.id === 'checkout' ? 'One simulated payment recorded' : 'All response assertions passed' : step.assertions.filter(a => !a.passed).map(a => `${a.code}: ${a.actual}`).join('; ');
    } catch (error) {
      const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      step.status = 'failed'; step.errorCategory = timeout ? 'timeout' : 'network_error'; step.actual = timeout ? `Request exceeded ${this.options.stepTimeoutMs} ms deadline` : error instanceof Error ? error.message : 'Request failed';
      step.assertions = [assertion(timeout ? 'REQUEST_DEADLINE' : 'HTTP_RESPONSE', timeout ? `Response within ${this.options.stepTimeoutMs} ms` : 'Completed JSON HTTP response', step.actual, false)];
      step.evidence.push(evidence('log', step.actual));
    }
    step.durationMs = Math.round(performance.now() - start); step.completedAt = new Date().toISOString();
    for (const a of step.assertions) step.evidence.push(evidence('assertion', `${a.code}: ${a.passed ? 'passed' : 'failed'}`, { ...a }));
    const previousLogIds = new Set(step.evidence.map(e => e.id));
    for (const log of await this.store.logs(run.id)) if (!previousLogIds.has(log.id)) step.evidence.push({ ...log, kind: 'log' });
    return responseBody;
  }

  private async validate(run: Run, stepId: string, body: Payload): Promise<Assertion[]> {
    switch (stepId) {
      case 'login': return [assertion('AUTHENTICATED', 'authenticated true', body.authenticated, body.authenticated === true), assertion('SESSION_TOKEN', 'Nonempty synthetic token', typeof body.token === 'string' && body.token.length > 0 ? 'present (redacted)' : 'missing', typeof body.token === 'string' && body.token.length > 0)];
      case 'inventory': return [assertion('PRODUCT_MATCH', PRODUCT_ID, body.productId, body.productId === PRODUCT_ID), assertion('STOCK_AVAILABLE', 'At least one item in stock', body.stock, typeof body.stock === 'number' && body.stock >= 1), assertion('AMOUNT_MATCH', String(run.amountMinor), body.priceMinor, body.priceMinor === run.amountMinor)];
      case 'cart': return [assertion('CART_ID', 'Nonempty cart ID', body.cartId, typeof body.cartId === 'string' && body.cartId.length > 0), assertion('QUANTITY_MATCH', '1', body.quantity, body.quantity === 1), assertion('AMOUNT_MATCH', String(run.amountMinor), body.amountMinor, body.amountMinor === run.amountMinor)];
      case 'checkout': {
        const paymentCount = await this.store.paymentCount(run.id);
        return [assertion('PAYMENT_RECORDED', 'paid true', body.paid, body.paid === true), assertion('ORDER_ID', 'Nonempty order ID', body.orderId, typeof body.orderId === 'string' && body.orderId.length > 0), assertion('TRANSACTION_ID', 'Nonempty transaction ID', body.transactionId, typeof body.transactionId === 'string' && body.transactionId.length > 0), assertion('AMOUNT_MATCH', String(run.amountMinor), body.amountMinor, body.amountMinor === run.amountMinor), assertion('ONE_PAYMENT', '1', paymentCount, paymentCount === 1)];
      }
      case 'confirmation': {
        const order = asObject(body.order);
        return [assertion('ORDER_PRESENT', 'Confirmed order object', body.order, typeof order.orderId === 'string'), assertion('ORDER_MATCH', run.orderId ?? 'Original order ID', order.orderId, order.orderId === run.orderId), assertion('TRANSACTION_MATCH', run.transactionId ?? 'Original transaction ID', order.transactionId, order.transactionId === run.transactionId), assertion('AMOUNT_MATCH', String(run.amountMinor), order.amountMinor, order.amountMinor === run.amountMinor), assertion('ORDER_CONFIRMED', 'confirmed true', order.confirmed, order.confirmed === true)];
      }
      default: return [];
    }
  }

  async recover(session: string, incidentId: string): Promise<RecoveryResult> {
    await this.waitForFinalizingRun(session);
    const incident = await this.store.getIncident(incidentId, session);
    if (!incident) throw new WorkflowError(404, 'NOT_FOUND', 'Incident was not found in this demo session.');
    if (incident.status === 'resolved' && incident.recovery?.status === 'verified') return incident.recovery;
    if (incident.diagnosis.recommendedAction !== 'resume_receipt_worker') throw new WorkflowError(409, 'RECOVERY_UNSUPPORTED', 'This incident has investigation guidance, but no approved automated recovery.');
    const active = this.activeRecoveries.get(incidentId); if (active) return active;
    const run = await this.store.getRun(incident.runId, session);
    if (!run?.orderId || run.paymentCount !== 1) throw new WorkflowError(409, 'RECOVERY_UNSAFE', 'The original order and single payment must exist before recovery.');
    if (this.activeRuns.has(session)) throw new WorkflowError(409, 'RUN_ACTIVE', 'Wait for the current test to finish before approving recovery.');
    const resumed = this.activeRecoveries.get(incidentId); if (resumed) return resumed;
    const pending = this.performRecovery(session, incidentId, run).finally(() => this.activeRecoveries.delete(incidentId));
    this.activeRecoveries.set(incidentId, pending); return pending;
  }

  private async performRecovery(session: string, incidentId: string, run: Run): Promise<RecoveryResult> {
    const started = performance.now(); const approvedAt = new Date().toISOString();
    const incident = (await this.store.getIncident(incidentId, session))!;
    const before = await this.store.paymentCount(run.id);
    incident.status = 'recovering'; await this.store.saveIncident(session, incident);
    const step = blankStep(specs[4]!); step.status = 'running'; step.startedAt = new Date().toISOString();
    let actionError: string | null = null;
    try { await this.store.resumeWorker(run.orderId!, run.id); }
    catch (error) { actionError = error instanceof Error ? error.message : 'Worker could not resume'; }
    if (actionError) {
      step.status = 'failed'; step.actual = actionError; step.errorCategory = 'recovery_error'; step.completedAt = new Date().toISOString(); step.evidence.push(evidence('recovery', actionError));
    } else await this.request(run, step, `sandbox:${run.id}`, undefined, this.options.recoveryVerificationFault?.(run) ?? false);
    const after = await this.store.paymentCount(run.id);
    const ledgerAssertion = assertion('NO_DUPLICATE_PAYMENT', 'Exactly one payment before and after recovery', { before, after }, before === 1 && after === before);
    step.assertions.push(ledgerAssertion); step.evidence.push(evidence('assertion', 'Verify that checkout was not replayed', { ...ledgerAssertion }));
    if (!ledgerAssertion.passed) { step.status = 'failed'; step.actual = 'Payment ledger changed during recovery'; step.errorCategory = 'ledger_integrity'; }
    const result: RecoveryResult = { id: randomUUID(), action: 'resume_receipt_worker', status: stepPassed(step) ? 'verified' : 'failed', approvedAt, completedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started), originalOrderId: run.orderId, paymentCountBefore: before, paymentCountAfter: after, verification: step,
      evidence: [evidence('recovery', 'Approved worker resume for the original sandbox order; checkout was not repeated.', { orderId: run.orderId, paymentCountBefore: before, paymentCountAfter: after }), ...step.evidence] };
    incident.recovery = result; incident.status = result.status === 'verified' ? 'resolved' : 'open'; incident.resolvedAt = result.status === 'verified' ? result.completedAt : null;
    incident.evidence.push(...result.evidence); await this.store.saveIncident(session, incident);
    return result;
  }

  async metrics(session: string): Promise<Metrics> {
    const runs = await this.store.listRuns(session); const completed = runs.filter(r => r.workflowId !== 'application-errors' && (r.status === 'passed' || r.status === 'failed'));
    const aggregate = await this.store.metricsAggregates(session); const completedCount = aggregate.passedRuns + aggregate.failedRuns;
    return { ...aggregate, successRate: completedCount ? Math.round(aggregate.passedRuns / completedCount * 1000) / 10 : 0,
      recentRuns: runs.slice(0, 20), chart: completed.slice(0, 30).reverse().map(r => ({ runId: r.id, timestamp: r.createdAt, durationMs: r.durationMs, passed: r.status === 'passed' })),
      instanceId: this.health.instanceId, instanceStartedAt: this.health.instanceStartedAt, historyPolicy: this.health.historyPolicy };
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.activeRuns.values(), ...this.activeRecoveries.values()]); }
}
