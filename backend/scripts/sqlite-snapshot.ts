import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Pool } from 'pg';

export const TABLE_COLUMNS = {
  runs: ['id','session_id','status','created_at','data'],
  payments: ['transaction_id','order_id','run_id','idempotency_key','amount_minor'],
  orders: ['id','run_id','transaction_id','amount_minor','confirmed'],
  receipt_jobs: ['order_id','state'],
  confirmations: ['order_id','created_at'],
  logs: ['id','run_id','timestamp','message'],
  incidents: ['id','run_id','session_id','fingerprint','status','created_at','data'],
  commerce_orders: ['id','session_id','checkout_key','status','razorpay_order_id','razorpay_payment_id','created_at','updated_at','data'],
  live_runs: ['id','session_id','status','created_at','data'],
} as const;
export type SnapshotTable = keyof typeof TABLE_COLUMNS;
export function loadLocalEnvironment(): void {
  const path = fileURLToPath(new URL('../../.local/integrations.env',import.meta.url));
  if (existsSync(path)) process.loadEnvFile(path);
}
export function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index+1];
  if (!value || value.startsWith('--')) throw new Error(`Provide a value after ${name}.`);
  return value;
}
export function readSnapshot(inputPath: string) {
  const source = resolve(inputPath);
  if (!existsSync(source)) throw new Error('Source SQLite file does not exist.');
  const db = new DatabaseSync(source,{readOnly:true});
  try {
    db.exec('BEGIN');
    const tables: Partial<Record<SnapshotTable,Record<string,unknown>[]>> = {};
    for (const [table,columns] of Object.entries(TABLE_COLUMNS)) {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      tables[table as SnapshotTable] = db.prepare(`SELECT ${columns.join(',')} FROM ${table}`).all();
    }
    db.exec('COMMIT');
    return {format:'bizplus-sqlite-snapshot-v1',exportedAt:new Date().toISOString(),source,tables};
  } finally { db.close(); }
}
export async function copySnapshot(pool: Pool,snapshot: ReturnType<typeof readSnapshot>): Promise<Record<string,number>> {
  const client = await pool.connect(); const inserted: Record<string,number> = {};
  try {
    await client.query('BEGIN');
    for (const [table,columns] of Object.entries(TABLE_COLUMNS)) {
      inserted[table] = 0;
      for (const row of snapshot.tables[table as SnapshotTable] ?? []) {
        const result = await client.query(`INSERT INTO bizplus.${table}(${columns.join(',')}) VALUES(${columns.map((_,index)=>`$${index+1}`).join(',')}) ON CONFLICT DO NOTHING`,columns.map(column=>row[column]));
        inserted[table] += result.rowCount ?? 0;
      }
    }
    await client.query('COMMIT'); return inserted;
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
