import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync } from 'node:fs';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { dirname, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = resolve(ROOT, '.local');
const ORIGIN = 'http://127.0.0.1:3024';
const APP_URL = `${ORIGIN}/login`;
const STARTUP_PIPE = '\\\\.\\pipe\\bizplus-ai-launch-' + createHash('sha256').update(ROOT.toLowerCase()).digest('hex').slice(0, 20);
const ERROR_FILE = resolve(LOCAL, 'app-launch-error.txt');
const pause = ms => new Promise(done => setTimeout(done, ms));
const session = randomUUID();

async function log(message) {
  await appendFile(resolve(LOCAL, 'app-launch.log'), `${new Date().toISOString()} ${message}\n`);
}

/** Only accept this application's actual health and login page, not a port alone. */
async function ready() {
  try {
    const healthResponse = await fetch(`${ORIGIN}/health`, { signal: AbortSignal.timeout(1800) });
    if (!healthResponse.ok) return false;
    const health = await healthResponse.json();
    if (health.app !== 'BizPlus AI' || health.status !== 'ok' || health.diagnosis !== 'rules') return false;
    const configResponse = await fetch(`${ORIGIN}/api/login/config`, {
      headers: { 'X-Demo-Session': session }, signal: AbortSignal.timeout(1800),
    });
    if (!configResponse.ok || (await configResponse.json()).manualOnly !== true) return false;
    const htmlResponse = await fetch(APP_URL, { signal: AbortSignal.timeout(1800) });
    const html = await htmlResponse.text();
    if (!htmlResponse.ok || !html.includes('id="root"')) return false;
    const assets = [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+\.(?:js|css))["']/g)].map(match => match[1]);
    if (!assets.some(path => path.endsWith('.js'))) return false;
    const results = await Promise.all(assets.map(path => fetch(`${ORIGIN}${path}`, { method: 'HEAD', signal: AbortSignal.timeout(1800) })));
    return results.every(response => response.ok);
  } catch { return false; }
}

async function portInUse() {
  return new Promise(done => {
    const socket = createConnection({ host: '127.0.0.1', port: 3024 });
    const finish = result => { socket.destroy(); done(result); };
    socket.setTimeout(1200, () => finish(true));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function checkBuild() {
  if (process.platform !== 'win32') throw new Error('This desktop launcher is for Windows.');
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('BizPlus AI needs Node.js 24. Install Node.js 24 and open the shortcut again.');
  for (const file of ['backend/dist/app.js', 'shared/dist/index.js', 'frontend/dist/index.html']) {
    if (!existsSync(resolve(ROOT, file))) throw new Error('The local app has not been built. Follow the one-time setup in docs/manual-login.md, then open the shortcut again.');
  }
  const html = await readFile(resolve(ROOT, 'frontend/dist/index.html'), 'utf8');
  const script = /<script[^>]+src=["'](\/assets\/[^"']+\.js)["']/i.exec(html)?.[1];
  const frontend = resolve(ROOT, 'frontend/dist');
  const entry = script && resolve(frontend, `.${script}`);
  if (!entry || !entry.startsWith(`${frontend}${sep}`)) throw new Error('The local frontend build is incomplete. Rebuild it using docs/manual-login.md.');
  if (!(await readFile(entry, 'utf8')).includes(ORIGIN)) throw new Error('This frontend was built for a different API address. Rebuild for http://127.0.0.1:3024 using docs/manual-login.md.');
}

/** Windows releases this exclusive named pipe if a launcher exits or crashes. */
async function acquireLock() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const mutex = createServer(socket => socket.end());
    const acquired = await new Promise((done, reject) => {
      mutex.once('error', error => error.code === 'EADDRINUSE' || error.code === 'EACCES' ? done(false) : reject(error));
      mutex.listen(STARTUP_PIPE, () => done(true));
    });
    if (acquired) return () => new Promise((done, reject) => mutex.close(error => error ? reject(error) : done()));
    await pause(250);
  }
  throw new Error('Another BizPlus AI startup has not finished. Check .local/app-launch.log and try again.');
}

async function startEngine() {
  const out = openSync(resolve(LOCAL, 'app-engine.stdout.log'), 'a');
  const err = openSync(resolve(LOCAL, 'app-engine.stderr.log'), 'a');
  let child;
  try {
    child = spawn(process.execPath, [resolve(ROOT, 'scripts/local-login-fixture.mjs')], {
      cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', out, err],
      env: { ...process.env, LOCAL_LOGIN_PORT: '3024' },
    });
    await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); });
  } finally { closeSync(out); closeSync(err); }
  let exited = false;
  child.once('exit', () => { exited = true; });
  child.unref();
  await writeFile(resolve(LOCAL, 'app-engine.json'), JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), origin: ORIGIN, project: ROOT }, null, 2));
  await log(`Started local engine PID ${child.pid}.`);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await ready()) return child.pid;
    if (exited) throw new Error('The local engine could not start. Details are in .local/app-engine.stderr.log.');
    await pause(300);
  }
  throw new Error('The local engine did not become ready within one minute. Details are in .local/app-engine.stderr.log.');
}

async function openBrowser() {
  if (process.platform !== 'win32') throw new Error('Use the Windows desktop shortcut, or open http://127.0.0.1:3024/login after starting the engine.');
  const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', APP_URL], { detached: true, windowsHide: true, stdio: 'ignore' });
  await new Promise((done, reject) => { browser.once('spawn', done); browser.once('error', reject); });
  browser.unref();
}

export async function launchApp({ browser = true } = {}) {
  await mkdir(LOCAL, { recursive: true });
  await checkBuild();
  const unlock = await acquireLock();
  let reused = false;
  let pid;
  try {
    reused = await ready();
    if (reused) await log('Reused the ready local engine.');
    else {
      if (await portInUse()) throw new Error('Port 3024 is occupied, but the BizPlus login is not ready. No existing process was stopped. Check .local/app-engine.stderr.log.');
      pid = await startEngine();
    }
  } finally { await unlock(); }
  await writeFile(ERROR_FILE, '');
  if (browser) { await openBrowser(); await log('Opened the login page after readiness checks passed.'); }
  return { ready: true, reused, ...(pid ? { pid } : {}), url: APP_URL };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  try {
    if (args.some(arg => arg !== '--no-browser')) throw new Error('Unsupported launch option. Open Start BizPlus AI.vbs or use npm run start:app.');
    console.log(JSON.stringify(await launchApp({ browser: !args.includes('--no-browser') })));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'BizPlus AI could not start.';
    await mkdir(LOCAL, { recursive: true }).catch(() => {});
    await writeFile(ERROR_FILE, message).catch(() => {});
    await log(`Startup failed: ${message}`).catch(() => {});
    console.error(message); process.exitCode = 1;
  }
}
