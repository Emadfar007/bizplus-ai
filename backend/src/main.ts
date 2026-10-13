import { startServer } from './app.js';

const port = Number(process.env.PORT ?? '3001');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
const runtime = await startServer({ port });
console.log(`BizPlus AI API listening on port ${port}; ${runtime.engine.health.historyPolicy} history; rules-based diagnosis.`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  runtime.close().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
});
