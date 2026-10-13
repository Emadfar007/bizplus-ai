import { writeFile,mkdir } from 'node:fs/promises';
import { dirname,resolve } from 'node:path';
import { argument,loadLocalEnvironment,readSnapshot } from './sqlite-snapshot.js';

loadLocalEnvironment();
const source = argument('--source') ?? process.env.SOURCE_SQLITE_PATH;
if (!source) throw new Error('Supply --source <SQLite file> or SOURCE_SQLITE_PATH. The source is opened read-only.');
const output = resolve(argument('--output') ?? `.local/bizplus-sqlite-snapshot-${Date.now()}.json`);
const snapshot = readSnapshot(source);
await mkdir(dirname(output),{recursive:true});
await writeFile(output,JSON.stringify(snapshot,null,2),{flag:'wx'});
console.log(JSON.stringify({status:'exported',output,counts:Object.fromEntries(Object.entries(snapshot.tables).map(([table,rows])=>[table,rows!.length]))},null,2));
