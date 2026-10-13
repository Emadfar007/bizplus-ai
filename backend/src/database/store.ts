import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CommerceOrder, Incident, IncidentList, LiveRun, Run } from '@bizplus/shared';
import type { DataStore, PaymentRow } from './types.js';
import { diagnoseLiveRun } from '../live/diagnosis.js';

type JsonRow = { data: string };
export const AMOUNT_MINOR = 129900;
export const PRODUCT_ID = 'BP-HEADSET';

export class Store implements DataStore {
  readonly driver = 'sqlite' as const;
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_session ON runs(session_id, created_at);
      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY, run_id TEXT UNIQUE NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS incidents_session ON incidents(session_id, created_at);
      CREATE TABLE IF NOT EXISTS payments (
        transaction_id TEXT PRIMARY KEY, order_id TEXT UNIQUE NOT NULL,
        run_id TEXT UNIQUE NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        idempotency_key TEXT UNIQUE NOT NULL, amount_minor INTEGER NOT NULL CHECK(amount_minor > 0)
      );
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY, run_id TEXT UNIQUE NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        transaction_id TEXT UNIQUE NOT NULL REFERENCES payments(transaction_id) ON DELETE CASCADE,
        amount_minor INTEGER NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0 CHECK(confirmed IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS receipt_jobs (
        order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK(state IN ('paused','complete'))
      );
      CREATE TABLE IF NOT EXISTS confirmations (
        order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS logs (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        timestamp TEXT NOT NULL, message TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commerce_orders (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, checkout_key TEXT NOT NULL,
        status TEXT NOT NULL, razorpay_order_id TEXT UNIQUE, razorpay_payment_id TEXT UNIQUE,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL,
        UNIQUE(session_id,checkout_key)
      );
      CREATE INDEX IF NOT EXISTS commerce_orders_session ON commerce_orders(session_id, created_at);
      CREATE TABLE IF NOT EXISTS live_runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS live_runs_session ON live_runs(session_id,created_at);
    `);
  }
  initialize(): void {
    const rows = this.db.prepare("SELECT session_id,data FROM live_runs WHERE status IN ('queued','running')").all() as { session_id: string; data: string }[];
    for (const row of rows) {
      const run = JSON.parse(row.data) as LiveRun;
      run.status = 'failed'; run.error = 'The backend restarted before this website test completed.'; run.message = run.error;
      run.completedAt = new Date().toISOString();
      run.assertions.push({ code: 'REQUEST_COMPLETED', expected: 'Completed website response', actual: 'Interrupted by backend restart', passed: false });
      run.evidence.events ??= [];
      run.evidence.events.push({ id:randomUUID(), kind:'log', timestamp:run.completedAt, message:'The monitoring backend restarted before this preserved check completed.', data:{monitorRestarted:true} });
      run.diagnosis = diagnoseLiveRun(run); run.incidentStatus = 'open';
      this.saveLiveRun(row.session_id,run);
    }
  }

  checkReadiness(): void {
    // Exercise the actual connection and the tables used by customer orders.
    this.db.prepare('SELECT id FROM commerce_orders LIMIT 1').all();
    this.db.prepare('SELECT id FROM live_runs LIMIT 1').all();
  }

  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  saveRun(session: string, run: Run): void {
    this.db.prepare(`INSERT INTO runs(id,session_id,status,created_at,data) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data`).run(
      run.id, session, run.status, run.createdAt, JSON.stringify(run));
  }
  getRun(id: string, session?: string): Run | null {
    const row = (session
      ? this.db.prepare('SELECT data FROM runs WHERE id=? AND session_id=?').get(id, session)
      : this.db.prepare('SELECT data FROM runs WHERE id=?').get(id)) as JsonRow | undefined;
    return row ? JSON.parse(row.data) as Run : null;
  }
  sessionForRun(id: string): string | null {
    const row = this.db.prepare('SELECT session_id FROM runs WHERE id=?').get(id) as { session_id: string } | undefined;
    return row?.session_id ?? null;
  }
  listRuns(session: string): Run[] {
    return (this.db.prepare('SELECT data FROM runs WHERE session_id=? ORDER BY created_at DESC,rowid DESC LIMIT 500').all(session) as JsonRow[])
      .map(row => JSON.parse(row.data) as Run);
  }
  metricsAggregates(session: string): { totalRuns: number; passedRuns: number; failedRuns: number; averageDurationMs: number; openIncidents: number; verifiedRecoveries: number; averageRecoveryMs: number } {
    const runs = this.db.prepare(`SELECT COUNT(*) AS totalRuns,
      COALESCE(SUM(CASE WHEN status='passed' THEN 1 ELSE 0 END),0) AS passedRuns,
      COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) AS failedRuns,
      COALESCE(AVG(CASE WHEN status IN ('passed','failed') THEN json_extract(data,'$.durationMs') END),0) AS averageDurationMs
      FROM runs WHERE session_id=? AND COALESCE(json_extract(data,'$.workflowId'),'')<>'application-errors'`).get(session) as { totalRuns: number; passedRuns: number; failedRuns: number; averageDurationMs: number };
    const incidents = this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN status<>'resolved' THEN 1 ELSE 0 END),0) AS openIncidents,
      COALESCE(SUM(CASE WHEN json_extract(data,'$.recovery.status')='verified' OR json_extract(data,'$.manualRecovery.status')='verified' OR (status='resolved' AND json_extract(data,'$.application.verification.source') IN ('live','observer')) THEN 1 ELSE 0 END),0) AS verifiedRecoveries,
      COALESCE(AVG(CASE WHEN json_extract(data,'$.recovery.status')='verified' THEN json_extract(data,'$.recovery.durationMs') WHEN json_extract(data,'$.manualRecovery.status')='verified' THEN json_extract(data,'$.manualRecovery.durationMs') END),0) AS averageRecoveryMs
      FROM incidents WHERE session_id=?`).get(session) as { openIncidents: number; verifiedRecoveries: number; averageRecoveryMs: number };
    return { ...runs, ...incidents, averageDurationMs: Math.round(runs.averageDurationMs), averageRecoveryMs: Math.round(incidents.averageRecoveryMs) };
  }
  unfinishedRuns(): { session: string; run: Run }[] {
    return (this.db.prepare("SELECT session_id,data FROM runs WHERE status IN ('running','queued')").all() as { session_id: string; data: string }[])
      .map(row => ({ session: row.session_id, run: JSON.parse(row.data) as Run }));
  }
  saveIncident(session: string, incident: Incident): void {
    this.db.prepare(`INSERT INTO incidents(id,run_id,session_id,fingerprint,status,created_at,data) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data`).run(
      incident.id, incident.runId, session, incident.fingerprint, incident.status, incident.createdAt, JSON.stringify(incident));
  }
  getIncident(id: string, session: string): Incident | null {
    const row = this.db.prepare('SELECT data FROM incidents WHERE id=? AND session_id=?').get(id, session) as JsonRow | undefined;
    if (!row) return null;
    const incident = JSON.parse(row.data) as Incident;
    incident.relatedIncidentIds = this.relatedIds(session, incident.fingerprint, id);
    return incident;
  }
  listIncidents(session: string): IncidentList {
    const incidents = (this.db.prepare('SELECT data FROM incidents WHERE session_id=? ORDER BY created_at DESC,rowid DESC LIMIT 500').all(session) as JsonRow[])
      .map(row => JSON.parse(row.data) as Incident);
    const grouped = new Map<string, Incident[]>();
    for (const incident of incidents) grouped.set(incident.fingerprint, [...(grouped.get(incident.fingerprint) ?? []), incident]);
    for (const incident of incidents) incident.relatedIncidentIds = (grouped.get(incident.fingerprint) ?? []).filter(other => other.id !== incident.id).map(other => other.id);
    return { incidents, groups: [...grouped.entries()].map(([fingerprint, group]) => ({ fingerprint, title: group[0]!.title, count: group.length, incidentIds: group.map(i => i.id) })) };
  }
  private relatedIds(session: string, fingerprint: string, exclude: string): string[] {
    return (this.db.prepare('SELECT id FROM incidents WHERE session_id=? AND fingerprint=? AND id<>? ORDER BY created_at DESC LIMIT 100').all(session, fingerprint, exclude) as { id: string }[]).map(row => row.id);
  }
  recoverInterruptedIncidents(): void {
    const rows = this.db.prepare("SELECT session_id,data FROM incidents WHERE status='recovering'").all() as { session_id: string; data: string }[];
    for (const row of rows) {
      const incident = JSON.parse(row.data) as Incident;
      incident.status = 'open';
      incident.evidence.push({ id: randomUUID(), kind: 'recovery', timestamp: new Date().toISOString(), message: 'Recovery was interrupted by backend restart. Approval can be retried safely.' });
      this.saveIncident(row.session_id, incident);
    }
  }
  log(runId: string, message: string): void {
    this.db.prepare('INSERT INTO logs(id,run_id,timestamp,message) VALUES(?,?,?,?)').run(randomUUID(), runId, new Date().toISOString(), message);
  }
  logs(runId: string): { id: string; timestamp: string; message: string }[] {
    return this.db.prepare('SELECT id,timestamp,message FROM logs WHERE run_id=? ORDER BY rowid').all(runId) as unknown as { id: string; timestamp: string; message: string }[];
  }
  checkout(runId: string, paused: boolean): PaymentRow {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT order_id,transaction_id,amount_minor FROM payments WHERE run_id=?').get(runId) as PaymentRow | undefined;
      if (existing) return existing;
      const orderId = randomUUID(); const transactionId = randomUUID();
      this.db.prepare('INSERT INTO payments(transaction_id,order_id,run_id,idempotency_key,amount_minor) VALUES(?,?,?,?,?)').run(transactionId, orderId, runId, `checkout:${runId}`, AMOUNT_MINOR);
      this.db.prepare('INSERT INTO orders(id,run_id,transaction_id,amount_minor,confirmed) VALUES(?,?,?,?,?)').run(orderId, runId, transactionId, AMOUNT_MINOR, paused ? 0 : 1);
      this.db.prepare('INSERT INTO receipt_jobs(order_id,state) VALUES(?,?)').run(orderId, paused ? 'paused' : 'complete');
      if (!paused) this.db.prepare('INSERT INTO confirmations(order_id,created_at) VALUES(?,?)').run(orderId, new Date().toISOString());
      return { order_id: orderId, transaction_id: transactionId, amount_minor: AMOUNT_MINOR };
    });
  }
  order(orderId: string, runId: string): { orderId: string; transactionId: string; amountMinor: number; confirmed: boolean; workerState: string } | null {
    const row = this.db.prepare(`SELECT o.id,o.transaction_id,o.amount_minor,o.confirmed,j.state
      FROM orders o JOIN receipt_jobs j ON j.order_id=o.id WHERE o.id=? AND o.run_id=?`).get(orderId, runId) as
      { id: string; transaction_id: string; amount_minor: number; confirmed: number; state: string } | undefined;
    return row ? { orderId: row.id, transactionId: row.transaction_id, amountMinor: row.amount_minor, confirmed: row.confirmed === 1, workerState: row.state } : null;
  }
  resumeWorker(orderId: string, runId: string): void {
    this.transaction(() => {
      const order = this.order(orderId, runId);
      if (!order) throw new Error('Original sandbox order no longer exists');
      this.db.prepare("UPDATE receipt_jobs SET state='complete' WHERE order_id=?").run(orderId);
      this.db.prepare('INSERT INTO confirmations(order_id,created_at) VALUES(?,?) ON CONFLICT(order_id) DO NOTHING').run(orderId, new Date().toISOString());
      this.db.prepare('UPDATE orders SET confirmed=1 WHERE id=?').run(orderId);
    });
    this.log(runId, `Receipt worker resumed for existing order ${orderId}; checkout was not repeated.`);
  }
  paymentCount(runId: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS count FROM payments WHERE run_id=?').get(runId) as { count: number }).count);
  }
  prune(before: string): void {
    this.db.prepare("DELETE FROM runs WHERE created_at<? AND status NOT IN ('queued','running') AND id NOT IN (SELECT run_id FROM incidents WHERE status='recovering')").run(before);
  }
  saveCommerceOrder(session: string, order: CommerceOrder): void {
    const result = this.db.prepare(`INSERT INTO commerce_orders(id,session_id,checkout_key,status,razorpay_order_id,razorpay_payment_id,created_at,updated_at,data)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,razorpay_order_id=excluded.razorpay_order_id,
      razorpay_payment_id=excluded.razorpay_payment_id,updated_at=excluded.updated_at,data=excluded.data
      WHERE commerce_orders.session_id=excluded.session_id AND commerce_orders.checkout_key=excluded.checkout_key`).run(
      order.id, session, order.checkoutKey, order.status, order.razorpayOrderId, order.razorpayPaymentId, order.createdAt, order.updatedAt, JSON.stringify(order));
    if (result.changes !== 1) throw new Error('Commerce order ownership or checkout key does not match');
  }
  getCommerceOrder(id: string, session: string): CommerceOrder | null {
    const row = this.db.prepare('SELECT data FROM commerce_orders WHERE id=? AND session_id=?').get(id, session) as JsonRow | undefined;
    return row ? JSON.parse(row.data) as CommerceOrder : null;
  }
  getCommerceOrderByCheckoutKey(session: string, key: string): CommerceOrder | null {
    const row = this.db.prepare('SELECT data FROM commerce_orders WHERE session_id=? AND checkout_key=?').get(session, key) as JsonRow | undefined;
    return row ? JSON.parse(row.data) as CommerceOrder : null;
  }
  getCommerceOrderByProviderId(id: string): { session: string; order: CommerceOrder } | null {
    const row = this.db.prepare('SELECT session_id,data FROM commerce_orders WHERE razorpay_order_id=? OR razorpay_payment_id=?').get(id, id) as { session_id: string; data: string } | undefined;
    return row ? { session: row.session_id, order: JSON.parse(row.data) as CommerceOrder } : null;
  }
  listCommerceOrders(session: string): CommerceOrder[] {
    return (this.db.prepare('SELECT data FROM commerce_orders WHERE session_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100').all(session) as JsonRow[]).map(row => JSON.parse(row.data) as CommerceOrder);
  }
  saveLiveRun(session: string, run: LiveRun): void {
    const result = this.db.prepare(`INSERT INTO live_runs(id,session_id,status,created_at,data) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data WHERE live_runs.session_id=excluded.session_id`).run(run.id, session, run.status, run.startedAt, JSON.stringify(run));
    if (result.changes !== 1) throw new Error('Live run ownership does not match');
  }
  getLiveRun(id: string, session: string): LiveRun | null {
    const row = this.db.prepare('SELECT data FROM live_runs WHERE id=? AND session_id=?').get(id, session) as JsonRow | undefined;
    return row ? JSON.parse(row.data) as LiveRun : null;
  }
  listLiveRuns(session: string): LiveRun[] {
    return (this.db.prepare('SELECT data FROM live_runs WHERE session_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100').all(session) as JsonRow[]).map(row => JSON.parse(row.data) as LiveRun);
  }
  close(): void { this.db.close(); }
}
