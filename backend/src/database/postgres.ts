import { Pool, type PoolClient } from 'pg';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { CommerceOrder, Incident, IncidentList, LiveRun, Run } from '@bizplus/shared';
import { AMOUNT_MINOR } from './store.js';
import type { DataStore, MetricsAggregate, PaymentRow, SandboxOrder, StoredLog } from './types.js';
import { diagnoseLiveRun } from '../live/diagnosis.js';

export interface PostgresOptions { caCert?: string; ssl?: boolean; poolSize?: number }
export class PostgresStore implements DataStore {
  readonly driver = 'postgres' as const;
  readonly pool: Pool;
  constructor(connectionString: string, options: PostgresOptions = {}) {
    let url: URL;
    try { url = new URL(connectionString); }
    catch { throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL. Keep its value in server settings.'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must be a PostgreSQL connection URL.');
    // pg URL SSL parameters replace an explicit ssl object; remove them so certificate validation cannot be weakened.
    for (const key of [...url.searchParams.keys()]) if (key.toLowerCase().startsWith('ssl') || key.toLowerCase()==='uselibpqcompat') url.searchParams.delete(key);
    const ca = options.caCert?.replace(/\\n/g, '\n');
    if (ca && !ca.includes('-----BEGIN CERTIFICATE-----')) throw new Error('DATABASE_CA_CERT must contain a PEM certificate.');
    if (options.ssl === false && (!['localhost','127.0.0.1','[::1]'].includes(url.hostname) || (url.searchParams.has('host') && !['localhost','127.0.0.1','::1','[::1]'].includes(url.searchParams.get('host')!)))) throw new Error('Unencrypted PostgreSQL is allowed only for explicit loopback test databases.');
    this.pool = new Pool({ connectionString: url.toString(), max: options.poolSize ?? 4, connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 10_000, statement_timeout: 15_000, ssl: options.ssl === false ? false : { rejectUnauthorized: true, ...(ca ? { ca } : {}) } });
    this.pool.on('error', error => console.error('PostgreSQL connection error:', error.message));
  }
  async initialize(): Promise<void> {
    const sql = await readFile(new URL('../../migrations/001_private_schema.sql', import.meta.url), 'utf8');
    await this.transaction(async client => { await client.query(sql); });
    const interrupted = (await this.pool.query("SELECT session_id,data FROM bizplus.live_runs WHERE status IN ('queued','running')")).rows;
    for (const row of interrupted) {
      const run = row.data as LiveRun;
      run.status = 'failed'; run.error = 'The backend restarted before this website test completed.'; run.message = run.error;
      run.completedAt = new Date().toISOString();
      run.assertions.push({ code: 'REQUEST_COMPLETED', expected: 'Completed website response', actual: 'Interrupted by backend restart', passed: false });
      run.evidence.events ??= [];
      run.evidence.events.push({ id:randomUUID(), kind:'log', timestamp:run.completedAt, message:'The monitoring backend restarted before this preserved check completed.', data:{monitorRestarted:true} });
      run.diagnosis = diagnoseLiveRun(run); run.incidentStatus = 'open';
      await this.saveLiveRun(row.session_id,run);
    }
  }
  async checkReadiness(): Promise<void> {
    await this.pool.query('SELECT id FROM bizplus.commerce_orders LIMIT 1');
    await this.pool.query('SELECT id FROM bizplus.live_runs LIMIT 1');
  }
  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await operation(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async saveRun(session: string, run: Run): Promise<void> {
    const result = await this.pool.query(`INSERT INTO bizplus.runs(id,session_id,status,created_at,data) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data WHERE bizplus.runs.session_id=excluded.session_id RETURNING id`, [run.id,session,run.status,run.createdAt,JSON.stringify(run)]);
    if (!result.rowCount) throw new Error('Run ownership does not match');
  }
  async getRun(id: string, session?: string): Promise<Run | null> {
    const result = session ? await this.pool.query('SELECT data FROM bizplus.runs WHERE id=$1 AND session_id=$2', [id,session]) : await this.pool.query('SELECT data FROM bizplus.runs WHERE id=$1', [id]);
    return result.rows[0]?.data ?? null;
  }
  async sessionForRun(id: string): Promise<string | null> { return (await this.pool.query('SELECT session_id FROM bizplus.runs WHERE id=$1',[id])).rows[0]?.session_id ?? null; }
  async listRuns(session: string): Promise<Run[]> { return (await this.pool.query('SELECT data FROM bizplus.runs WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 500',[session])).rows.map(row => row.data as Run); }
  async metricsAggregates(session: string): Promise<MetricsAggregate> {
    const runs = (await this.pool.query(`SELECT COUNT(*)::int AS "totalRuns", COUNT(*) FILTER(WHERE status='passed')::int AS "passedRuns",
      COUNT(*) FILTER(WHERE status='failed')::int AS "failedRuns", COALESCE(AVG((data->>'durationMs')::numeric) FILTER(WHERE status IN ('passed','failed')),0)::float8 AS "averageDurationMs"
      FROM bizplus.runs WHERE session_id=$1`,[session])).rows[0];
    const incidents = (await this.pool.query(`SELECT COUNT(*) FILTER(WHERE status<>'resolved')::int AS "openIncidents",
      COUNT(*) FILTER(WHERE data->'recovery'->>'status'='verified' OR data->'manualRecovery'->>'status'='verified')::int AS "verifiedRecoveries",
      COALESCE(AVG(CASE WHEN data->'recovery'->>'status'='verified' THEN (data->'recovery'->>'durationMs')::numeric WHEN data->'manualRecovery'->>'status'='verified' THEN (data->'manualRecovery'->>'durationMs')::numeric END),0)::float8 AS "averageRecoveryMs"
      FROM bizplus.incidents WHERE session_id=$1`,[session])).rows[0];
    return { ...runs,...incidents,averageDurationMs: Math.round(runs.averageDurationMs),averageRecoveryMs: Math.round(incidents.averageRecoveryMs) } as MetricsAggregate;
  }
  async unfinishedRuns(): Promise<{ session: string; run: Run }[]> { return (await this.pool.query("SELECT session_id,data FROM bizplus.runs WHERE status IN ('queued','running')")).rows.map(row => ({session:row.session_id,run:row.data})); }
  async saveIncident(session: string, incident: Incident): Promise<void> {
    const result = await this.pool.query(`INSERT INTO bizplus.incidents(id,run_id,session_id,fingerprint,status,created_at,data) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data WHERE bizplus.incidents.session_id=excluded.session_id RETURNING id`,[incident.id,incident.runId,session,incident.fingerprint,incident.status,incident.createdAt,JSON.stringify(incident)]);
    if (!result.rowCount) throw new Error('Incident ownership does not match');
  }
  async getIncident(id: string, session: string): Promise<Incident | null> {
    const incident = (await this.pool.query('SELECT data FROM bizplus.incidents WHERE id=$1 AND session_id=$2',[id,session])).rows[0]?.data as Incident | undefined;
    if (!incident) return null;
    incident.relatedIncidentIds = (await this.pool.query('SELECT id FROM bizplus.incidents WHERE session_id=$1 AND fingerprint=$2 AND id<>$3 ORDER BY created_at DESC LIMIT 100',[session,incident.fingerprint,id])).rows.map(row => row.id);
    return incident;
  }
  async listIncidents(session: string): Promise<IncidentList> {
    const incidents = (await this.pool.query('SELECT data FROM bizplus.incidents WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 500',[session])).rows.map(row => row.data as Incident);
    const grouped = new Map<string,Incident[]>();
    for (const incident of incidents) grouped.set(incident.fingerprint,[...(grouped.get(incident.fingerprint) ?? []),incident]);
    for (const incident of incidents) incident.relatedIncidentIds = (grouped.get(incident.fingerprint) ?? []).filter(i => i.id!==incident.id).map(i => i.id);
    return { incidents,groups: [...grouped.entries()].map(([fingerprint,group]) => ({fingerprint,title:group[0]!.title,count:group.length,incidentIds:group.map(i => i.id)})) };
  }
  async recoverInterruptedIncidents(): Promise<void> {
    const rows = (await this.pool.query("SELECT session_id,data FROM bizplus.incidents WHERE status='recovering'")).rows;
    for (const row of rows) {
      const incident = row.data as Incident; incident.status = 'open';
      incident.evidence.push({id:randomUUID(),kind:'recovery',timestamp:new Date().toISOString(),message:'Recovery was interrupted by backend restart. Approval can be retried safely.'});
      await this.saveIncident(row.session_id,incident);
    }
  }
  async log(runId: string, message: string): Promise<void> { await this.pool.query('INSERT INTO bizplus.logs(id,run_id,timestamp,message) VALUES($1,$2,$3,$4)',[randomUUID(),runId,new Date().toISOString(),message]); }
  async logs(runId: string): Promise<StoredLog[]> { return (await this.pool.query('SELECT id,timestamp,message FROM bizplus.logs WHERE run_id=$1 ORDER BY timestamp,id',[runId])).rows as StoredLog[]; }
  async checkout(runId: string, paused: boolean): Promise<PaymentRow> {
    return this.transaction(async client => {
      await client.query('SELECT id FROM bizplus.runs WHERE id=$1 FOR UPDATE',[runId]);
      const existing = (await client.query('SELECT order_id,transaction_id,amount_minor FROM bizplus.payments WHERE run_id=$1',[runId])).rows[0] as PaymentRow | undefined;
      if (existing) return existing;
      const orderId = randomUUID(); const transactionId = randomUUID();
      await client.query('INSERT INTO bizplus.payments(transaction_id,order_id,run_id,idempotency_key,amount_minor) VALUES($1,$2,$3,$4,$5)',[transactionId,orderId,runId,`checkout:${runId}`,AMOUNT_MINOR]);
      await client.query('INSERT INTO bizplus.orders(id,run_id,transaction_id,amount_minor,confirmed) VALUES($1,$2,$3,$4,$5)',[orderId,runId,transactionId,AMOUNT_MINOR,paused?0:1]);
      await client.query('INSERT INTO bizplus.receipt_jobs(order_id,state) VALUES($1,$2)',[orderId,paused?'paused':'complete']);
      if (!paused) await client.query('INSERT INTO bizplus.confirmations(order_id,created_at) VALUES($1,$2)',[orderId,new Date().toISOString()]);
      return {order_id:orderId,transaction_id:transactionId,amount_minor:AMOUNT_MINOR};
    });
  }
  async order(orderId: string, runId: string): Promise<SandboxOrder | null> {
    const row = (await this.pool.query(`SELECT o.id,o.transaction_id,o.amount_minor,o.confirmed,j.state FROM bizplus.orders o
      JOIN bizplus.receipt_jobs j ON j.order_id=o.id WHERE o.id=$1 AND o.run_id=$2`,[orderId,runId])).rows[0];
    return row ? {orderId:row.id,transactionId:row.transaction_id,amountMinor:row.amount_minor,confirmed:row.confirmed===1,workerState:row.state} : null;
  }
  async resumeWorker(orderId: string, runId: string): Promise<void> {
    await this.transaction(async client => {
      const order = (await client.query('SELECT id FROM bizplus.orders WHERE id=$1 AND run_id=$2 FOR UPDATE',[orderId,runId])).rows[0];
      if (!order) throw new Error('Original sandbox order no longer exists');
      await client.query("UPDATE bizplus.receipt_jobs SET state='complete' WHERE order_id=$1",[orderId]);
      await client.query('INSERT INTO bizplus.confirmations(order_id,created_at) VALUES($1,$2) ON CONFLICT(order_id) DO NOTHING',[orderId,new Date().toISOString()]);
      await client.query('UPDATE bizplus.orders SET confirmed=1 WHERE id=$1',[orderId]);
    });
    await this.log(runId,`Receipt worker resumed for existing order ${orderId}; checkout was not repeated.`);
  }
  async paymentCount(runId: string): Promise<number> { return (await this.pool.query('SELECT COUNT(*)::int AS count FROM bizplus.payments WHERE run_id=$1',[runId])).rows[0].count; }
  async prune(before: string): Promise<void> { await this.pool.query("DELETE FROM bizplus.runs WHERE created_at<$1 AND status NOT IN ('queued','running') AND id NOT IN (SELECT run_id FROM bizplus.incidents WHERE status='recovering')",[before]); }
  async saveCommerceOrder(session: string, order: CommerceOrder): Promise<void> {
    const result = await this.pool.query(`INSERT INTO bizplus.commerce_orders(id,session_id,checkout_key,status,razorpay_order_id,razorpay_payment_id,created_at,updated_at,data)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET status=excluded.status,razorpay_order_id=excluded.razorpay_order_id,
      razorpay_payment_id=excluded.razorpay_payment_id,updated_at=excluded.updated_at,data=excluded.data
      WHERE bizplus.commerce_orders.session_id=excluded.session_id AND bizplus.commerce_orders.checkout_key=excluded.checkout_key RETURNING id`,[order.id,session,order.checkoutKey,order.status,order.razorpayOrderId,order.razorpayPaymentId,order.createdAt,order.updatedAt,JSON.stringify(order)]);
    if (!result.rowCount) throw new Error('Commerce order ownership or checkout key does not match');
  }
  async getCommerceOrder(id: string, session: string): Promise<CommerceOrder | null> { return (await this.pool.query('SELECT data FROM bizplus.commerce_orders WHERE id=$1 AND session_id=$2',[id,session])).rows[0]?.data ?? null; }
  async getCommerceOrderByCheckoutKey(session: string, key: string): Promise<CommerceOrder | null> { return (await this.pool.query('SELECT data FROM bizplus.commerce_orders WHERE session_id=$1 AND checkout_key=$2',[session,key])).rows[0]?.data ?? null; }
  async getCommerceOrderByProviderId(id: string): Promise<{ session: string; order: CommerceOrder } | null> {
    const row = (await this.pool.query('SELECT session_id,data FROM bizplus.commerce_orders WHERE razorpay_order_id=$1 OR razorpay_payment_id=$1',[id])).rows[0];
    return row ? {session:row.session_id,order:row.data} : null;
  }
  async listCommerceOrders(session: string): Promise<CommerceOrder[]> { return (await this.pool.query('SELECT data FROM bizplus.commerce_orders WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',[session])).rows.map(row => row.data); }
  async saveLiveRun(session: string, run: LiveRun): Promise<void> {
    const result = await this.pool.query(`INSERT INTO bizplus.live_runs(id,session_id,status,created_at,data) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data WHERE bizplus.live_runs.session_id=excluded.session_id RETURNING id`,[run.id,session,run.status,run.startedAt,JSON.stringify(run)]);
    if (!result.rowCount) throw new Error('Live run ownership does not match');
  }
  async getLiveRun(id: string, session: string): Promise<LiveRun | null> { return (await this.pool.query('SELECT data FROM bizplus.live_runs WHERE id=$1 AND session_id=$2',[id,session])).rows[0]?.data ?? null; }
  async listLiveRuns(session: string): Promise<LiveRun[]> { return (await this.pool.query('SELECT data FROM bizplus.live_runs WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',[session])).rows.map(row => row.data); }
  async close(): Promise<void> { await this.pool.end(); }
}
