import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from '../dist/app.js';

const credentials = fileURLToPath(new URL('../../.local/integrations.env', import.meta.url));
if (existsSync(credentials)) process.loadEnvFile(credentials);
const port = Number(process.env.PORT ?? '3001');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
const runtime = await startServer({
  port,
  databasePath: fileURLToPath(new URL('../data/bizplus.sqlite', import.meta.url)),
});
console.log(`BizPlus local API listening on port ${port}; SQLite explicitly selected for presentation fallback.`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  runtime.close().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
});
