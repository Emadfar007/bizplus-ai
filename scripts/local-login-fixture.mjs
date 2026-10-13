import { startServer } from '../backend/dist/app.js';

// An isolated local presentation instance: no existing application process or
// database is replaced, and the login uses the public synthetic demo account.
const port = Number(process.env.LOCAL_LOGIN_PORT ?? 3024);
process.env.SERVE_FRONTEND = 'true';
process.env.NODE_ENV = 'development';
process.env.CORS_ORIGIN = `http://127.0.0.1:${port}`;
delete process.env.PUBLIC_APP_URL;
const runtime = await startServer({
  port, host: '127.0.0.1', databasePath: '.local/manual-login-demo.sqlite',
  observer: { url: undefined },
});
console.log(`BizPlus manual login demo: http://127.0.0.1:${port}/login`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await runtime.close(); process.exit(0);
});
