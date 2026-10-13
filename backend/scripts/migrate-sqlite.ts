import { argument,loadLocalEnvironment,readSnapshot,copySnapshot } from './sqlite-snapshot.js';
import { PostgresStore } from '../src/database/postgres.js';

loadLocalEnvironment();
const source = argument('--source') ?? process.env.SOURCE_SQLITE_PATH;
if (!source) throw new Error('Supply --source <SQLite file> or SOURCE_SQLITE_PATH. The source is opened read-only.');
const snapshot = readSnapshot(source);
const counts = Object.fromEntries(Object.entries(snapshot.tables).map(([table,rows])=>[table,rows!.length]));
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({status:'dry-run',source:snapshot.source,counts,message:'No cloud writes performed. Add --apply after selecting DATABASE_URL.'},null,2));
} else {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for migration.');
  const target = new PostgresStore(process.env.DATABASE_URL,{caCert:process.env.DATABASE_CA_CERT});
  try {
    await target.initialize();
    const inserted = await copySnapshot(target.pool,snapshot);
    console.log(JSON.stringify({status:'migrated',counts,inserted,message:'Existing cloud rows retained; original SQLite file was not changed.'},null,2));
  } finally { await target.close(); }
}
