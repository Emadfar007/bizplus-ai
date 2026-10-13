/** Optional same-origin UI build for the existing Render backend build command. */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function hostedApiOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('SERVE_FRONTEND=true requires an explicit VITE_API_BASE_URL containing the backend origin.'); }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('VITE_API_BASE_URL must be a public HTTPS origin or a local development origin, without credentials, a path, or query parameters.');
  return url.origin;
}

export async function buildHostedFrontend() {
  if (process.env.SERVE_FRONTEND !== 'true') {
    console.log('Hosted frontend disabled; backend build remains API-only.');
    return;
  }
  const origin = hostedApiOrigin(process.env.VITE_API_BASE_URL);
  const candidates = [
    process.env.npm_execpath,
    resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ];
  const npmCli = candidates.find(path => path?.endsWith('npm-cli.js') && existsSync(path));
  if (!npmCli) throw new Error('Could not find npm-cli.js for the hosted frontend build. Run through the project npm build script.');
  const env = { ...process.env, VITE_API_BASE_URL: origin };
  for (const key of ['DATABASE_URL', 'DATABASE_CA_CERT', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'RENDER_API_KEY', 'NETLIFY_AUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) delete env[key];
  console.log('Building the optional frontend for the configured backend origin.');
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [npmCli, 'run', 'build:frontend'], { cwd: ROOT, env, stdio: 'inherit', windowsHide: true });
    child.once('error', () => reject(new Error('Could not launch the optional hosted frontend build.')));
    child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(`Hosted frontend build failed with exit code ${code}.`)));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildHostedFrontend().catch(error => { console.error(error.message); process.exitCode = 1; });
}
