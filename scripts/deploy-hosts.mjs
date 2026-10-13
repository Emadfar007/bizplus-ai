/**
 * Deployment orchestration for the approved BizPlus AI demo.
 * Node 24; no extra dependencies. Credentials and state stay in ignored .local/.
 *
 * Read-only: node scripts/deploy-hosts.mjs --check | --plan
 * Mutating:  node scripts/deploy-hosts.mjs --deploy | --redeploy
 * Add --netlify-only to use .local/render-native.json instead of a Render API key.
 * Netlify-only mode never creates, updates, deploys, or queries Render resources.
 * --deploy resumes interrupted operations; --redeploy explicitly makes new deploys.
 *
 * Official schemas checked 2026-10-13:
 * https://api-docs.render.com/reference/create-service.md
 * https://api-docs.render.com/reference/list-owners.md
 * https://api-docs.render.com/reference/create-deploy.md
 * https://open-api.netlify.com/swagger.json
 * https://docs.netlify.com/api-and-cli-guides/api-guides/get-started-with-api/
 */
import { readFile, writeFile, rename, mkdir, readdir, open, unlink, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = resolve(ROOT, '.local');
const STATE_PATH = resolve(LOCAL, 'deployment-state.json');
const ENV_PATH = resolve(LOCAL, 'deployment.env');
const NATIVE_RENDER_PATH = resolve(LOCAL, 'render-native.json');
const LOCK_PATH = resolve(LOCAL, 'deployment.lock');
const REPO = 'https://github.com/Emadfar007/bizplus-ai';
const BRANCH = 'main';
const API = { render: 'https://api.render.com/v1', netlify: 'https://api.netlify.com/api/v1' };
let credentials = {};
let state = {};
let netlifyOnly = false;

export function parseArgs(args) {
  const modes = args.filter(arg => ['--check', '--plan', '--deploy', '--redeploy'].includes(arg));
  if (modes.length > 1 || args.some(arg => !['--check', '--plan', '--deploy', '--redeploy', '--netlify-only'].includes(arg)) || args.filter(arg => arg === '--netlify-only').length > 1) fail('Usage: node scripts/deploy-hosts.mjs [--check|--plan|--deploy|--redeploy] [--netlify-only]');
  return { mode: modes[0] || '--check', netlifyOnly: args.includes('--netlify-only') };
}

export function parseEnv(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    result[match[1]] = value;
  }
  return result;
}

function safe(value) {
  let text = String(value ?? '');
  for (const key of ['NETLIFY_AUTH_TOKEN', 'RENDER_API_KEY']) {
    if (credentials[key]) text = text.split(credentials[key]).join('[REDACTED]');
  }
  return text.replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]');
}
function log(value) { console.log(safe(value)); }
function fail(message) { throw new Error(message); }
const enc = value => encodeURIComponent(String(value));
const definitiveRejection = error => [400, 401, 402, 403, 404, 406, 409, 410, 415, 422, 429].includes(error.status);

async function loadCredentials() {
  let local = {};
  try { local = parseEnv(await readFile(ENV_PATH, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  credentials = Object.fromEntries(['NETLIFY_AUTH_TOKEN', 'RENDER_API_KEY', 'NETLIFY_ACCOUNT_SLUG', 'RENDER_OWNER_ID'].map(key => [key, local[key] || process.env[key] || '']));
}
async function loadState() {
  try { state = JSON.parse(await readFile(STATE_PATH, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = {}; }
  if (state.repository && state.repository !== REPO) fail('The local deployment state belongs to a different repository. Refusing to reuse it.');
}
export function parseNativeRenderMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.serviceId !== 'string' || !/^srv-[a-z0-9]{20}$/.test(value.serviceId) || typeof value.workspaceId !== 'string' || !/^(tea|usr)-[a-z0-9]{20}$/.test(value.workspaceId)) fail('Native Render metadata requires a valid serviceId, workspaceId, and HTTPS onrender.com URL.');
  return { serviceId: value.serviceId, workspaceId: value.workspaceId, url: approvedPublicUrl(value.url, '.onrender.com') };
}
async function loadNativeRender() {
  let text;
  try { text = await readFile(NATIVE_RENDER_PATH, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') fail('Netlify-only mode requires .local/render-native.json from the existing native Render service.'); throw error; }
  let value;
  try { value = JSON.parse(text); } catch { fail('Native Render metadata is not valid JSON.'); }
  return parseNativeRenderMetadata(value);
}
function backendTarget() { return netlifyOnly ? state.nativeRender : state.render; }
async function saveState() {
  state.repository = REPO;
  state.branch = BRANCH;
  state.updatedAt = new Date().toISOString();
  await mkdir(LOCAL, { recursive: true });
  const temporary = `${STATE_PATH}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, STATE_PATH);
}

async function request(provider, path, { method = 'GET', body, binary = false } = {}) {
  if (netlifyOnly && provider === 'render') fail('Netlify-only mode forbids Render API operations. Manage the existing backend through the native Render connector.');
  const token = credentials[provider === 'render' ? 'RENDER_API_KEY' : 'NETLIFY_AUTH_TOKEN'];
  if (!token) fail(`Missing ${provider === 'render' ? 'RENDER_API_KEY' : 'NETLIFY_AUTH_TOKEN'} in the ignored deployment.env file.`);
  let response;
  try {
    response = await fetch(`${API[provider]}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' } : {}) },
      ...(body !== undefined ? { body: binary ? body : JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(45000),
    });
  } catch {
    fail(`${provider} ${method} ${path}: network request timed out or failed. The operation may have completed; rerun --deploy to reconcile saved state. No automatic POST retry was made.`);
  }
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    const detail = safe(data?.message ?? data?.error ?? '').replace(/\s+/g, ' ').slice(0, 400);
    const error = new Error(`${provider} ${method} ${path}: HTTP ${response.status}${detail ? ` — ${detail}` : ''}.${response.status === 402 ? ' A paid plan or billing setup was requested; this helper will not change billing or upgrade.' : ''}${provider === 'render' && [400, 403, 404].includes(response.status) && path === '/services' ? ' If this concerns repository access, grant the Render GitHub app access to the existing private repository; do not make the source public.' : ''}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export function isFreeNetlifyAccount(account) {
  const names = [account.type_name, account.type_id, account.type].filter(Boolean);
  return names.some(value => /^(free|starter)$/i.test(value) || /(?:^|_)free$/i.test(value) || /(?:^|_)starter$/i.test(value));
}
function accountSummary(account) { return { id: account.id, name: account.name, slug: account.slug, plan: account.type_name || account.type_id || account.type || 'unknown', freeVerified: isFreeNetlifyAccount(account) }; }
function ownerSummary(owner) { return { id: owner.id, name: owner.name, type: owner.type }; }

async function renderOwners() {
  const result = [];
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const rows = await request('render', `/owners?limit=100${cursor ? `&cursor=${enc(cursor)}` : ''}`);
    if (!Array.isArray(rows)) fail('Render returned an unexpected workspaces response.');
    for (const row of rows) if (row.owner?.id && !result.some(owner => owner.id === row.owner.id)) result.push(row.owner);
    if (rows.length < 100) return result;
    const next = rows.at(-1)?.cursor;
    if (!next || next === cursor) fail('Render workspace pagination could not be verified.');
    cursor = next;
  }
  fail('Render workspace pagination exceeded its safe bound. Select the workspace manually.');
}
async function identities(requireAll = true, useRenderApi = true) {
  const jobs = [
    credentials.NETLIFY_AUTH_TOKEN ? Promise.all([request('netlify', '/user'), request('netlify', '/accounts')]) : Promise.resolve(null),
    useRenderApi && credentials.RENDER_API_KEY ? renderOwners() : Promise.resolve(null),
  ];
  const results = await Promise.allSettled(jobs);
  const output = { netlifyTokenPresent: Boolean(credentials.NETLIFY_AUTH_TOKEN), renderKeyPresent: Boolean(credentials.RENDER_API_KEY), ...(useRenderApi ? {} : { renderManagement: 'native-connector', renderApiOperations: false }) };
  if (results[0].status === 'fulfilled' && results[0].value) {
    const [user, accounts] = results[0].value;
    if (!user?.id || !Array.isArray(accounts)) fail('Netlify returned an unexpected user/account response.');
    output.netlify = { user: { id: user.id, name: user.full_name || user.id }, accounts: accounts.map(accountSummary) };
    output.netlifyRaw = { user, accounts };
  } else if (results[0].status === 'rejected') output.netlifyError = safe(results[0].reason.message);
  if (results[1].status === 'fulfilled' && results[1].value) {
    output.render = { workspaces: results[1].value.map(ownerSummary) };
    output.renderRaw = results[1].value;
  } else if (results[1].status === 'rejected') output.renderError = safe(results[1].reason.message);
  log(JSON.stringify({ ...output, netlifyRaw: undefined, renderRaw: undefined }, null, 2));
  if (requireAll && (!output.netlifyRaw || (useRenderApi && !output.renderRaw))) fail(useRenderApi ? 'Both provider credentials must be available and authenticated before any hosting mutation.' : 'NETLIFY_AUTH_TOKEN must be available and authenticated before any Netlify mutation; no Render API key is needed in Netlify-only mode.');
  return output;
}
function selectNetlifyAccount(identity) {
  const { user, accounts } = identity.netlifyRaw;
  let eligible = accounts.filter(account => isFreeNetlifyAccount(account) && account.owner_ids?.includes(user.id));
  const selectedSlug = state.netlify?.accountSlug || credentials.NETLIFY_ACCOUNT_SLUG;
  if (selectedSlug) eligible = eligible.filter(account => account.slug === selectedSlug);
  else eligible = eligible.filter(account => account.owner_ids.length === 1);
  if (eligible.length !== 1) fail('Netlify needs exactly one verified personal Free/Starter account. Review the account names above and set NETLIFY_ACCOUNT_SLUG to the intended verified free account; no site was created.');
  return eligible[0];
}
function selectTargets(identity) {
  const account = selectNetlifyAccount(identity);
  let owners = identity.renderRaw;
  const selectedOwner = state.render?.ownerId || credentials.RENDER_OWNER_ID;
  if (selectedOwner) owners = owners.filter(owner => owner.id === selectedOwner);
  if (owners.length !== 1) fail('Render needs exactly one verified workspace. Review the workspace names above and set RENDER_OWNER_ID to the intended workspace; no service or site was created.');
  return { account, owner: owners[0] };
}

function git(args) {
  try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 45000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { fail(`Git verification failed for ${args[0]}. Check the existing private repository connection locally; credentials are not printed.`); }
}
function verifiedSource() {
  if (Number(process.versions.node.split('.')[0]) !== 24) fail('Run this helper with tested Node 24.');
  const remote = git(['remote', 'get-url', 'origin']).replace(/\.git$/, '');
  if (remote !== REPO) fail('The origin remote is not the approved private Emadfar007/bizplus-ai repository.');
  if (git(['branch', '--show-current']) !== BRANCH) fail('Switch to main before deploying.');
  if (git(['status', '--porcelain'])) fail('Commit or resolve pending project changes before deploying so the frontend and backend use the same verified source.');
  const commit = git(['rev-parse', 'HEAD']);
  const remoteCommit = git(['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(commit) || remoteCommit !== commit) fail('Push the verified local main commit to the existing private repository before deployment.');
  return commit;
}
function approvedPublicUrl(value, suffix) {
  let url;
  try { url = new URL(value); } catch { fail(`Provider returned an invalid ${suffix} URL.`); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith(suffix) || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) fail(`Provider URL is outside the expected HTTPS ${suffix} hosting domain.`);
  return url.origin;
}

async function netlifySites() {
  const sites = [];
  for (let page = 1; page <= 10; page++) {
    const rows = await request('netlify', `/sites?page=${page}&per_page=100`);
    if (!Array.isArray(rows)) fail('Netlify returned an unexpected sites response.');
    sites.push(...rows);
    if (rows.length < 100) return sites;
  }
  fail('Netlify site pagination exceeded its safe bound; inspect this account manually.');
}
async function verifySite(site, account) {
  if (!site?.id || site.name !== state.netlify.name || site.account_id !== account.id) fail('Netlify site identity does not match the saved deployment target.');
  state.netlify.siteId = site.id;
  state.netlify.url = approvedPublicUrl(site.ssl_url || site.url, '.netlify.app');
  state.netlify.adminUrl = site.admin_url;
  delete state.netlify.pendingCreate;
  await saveState();
}
async function ensureNetlifySite(account) {
  if (state.netlify.siteId) { await verifySite(await request('netlify', `/sites/${enc(state.netlify.siteId)}`), account); return; }
  const found = (await netlifySites()).filter(site => site.name === state.netlify.name && site.account_id === account.id);
  if (found.length > 1) fail('Multiple Netlify sites match the saved name; manual inspection is required.');
  if (found.length === 1) { await verifySite(found[0], account); log('Resumed the existing Netlify site.'); return; }
  if (state.netlify.pendingCreate) fail('A previous Netlify site creation has an unknown outcome and is not yet visible. Retry --deploy later or inspect the dashboard; the helper will not create a second site.');
  state.netlify.pendingCreate = { at: new Date().toISOString() };
  await saveState();
  log(`Creating the single Netlify site ${state.netlify.name} on ${account.name} (${account.type_name || account.type_id || account.type}).`);
  let site;
  try { site = await request('netlify', `/${enc(account.slug)}/sites`, { method: 'POST', body: { name: state.netlify.name, force_ssl: true } }); }
  catch (error) { if (definitiveRejection(error)) { delete state.netlify.pendingCreate; await saveState(); } throw error; }
  if (site?.id) { state.netlify.siteId = site.id; await saveState(); }
  await verifySite(site, account);
  log(`Frontend host: ${state.netlify.url}`);
}

export function renderPayload(ownerId, frontendUrl, name) {
  return {
    type: 'web_service', name, ownerId, repo: REPO, branch: BRANCH, rootDir: '', autoDeployTrigger: 'off',
    envVars: [
      { key: 'NODE_VERSION', value: '24.19.0' },
      { key: 'NODE_ENV', value: 'production' },
      { key: 'HISTORY_POLICY', value: 'temporary' },
      { key: 'DATABASE_PATH', value: '.local/bizplus.sqlite' },
      { key: 'CORS_ORIGIN', value: frontendUrl },
    ],
    serviceDetails: {
      runtime: 'node', plan: 'free', region: 'singapore', numInstances: 1, healthCheckPath: '/health',
      envSpecificDetails: { buildCommand: 'npm ci && npm run build:backend', startCommand: 'npm start' },
      previews: { generation: 'off' },
    },
  };
}
async function matchingRenderServices(owner) {
  const found = [];
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const rows = await request('render', `/services?ownerId=${enc(owner.id)}&name=${enc(state.render.name)}&limit=100${cursor ? `&cursor=${enc(cursor)}` : ''}`);
    if (!Array.isArray(rows)) fail('Render returned an unexpected services response.');
    for (const row of rows) if (row.service?.name === state.render.name && row.service.ownerId === owner.id) found.push(row.service);
    if (rows.length < 100) return found;
    const next = rows.at(-1)?.cursor;
    if (!next || next === cursor) fail('Render service pagination could not be verified.');
    cursor = next;
  }
  fail('Render service pagination exceeded its safe bound.');
}
async function verifyService(service, owner) {
  const details = service?.serviceDetails;
  if (!service?.id || service.name !== state.render.name || service.ownerId !== owner.id || service.type !== 'web_service' || service.repo?.replace(/\.git$/, '') !== REPO || service.branch !== BRANCH || service.rootDir || details?.plan !== 'free' || details?.runtime !== 'node' || details?.healthCheckPath !== '/health' || details?.envSpecificDetails?.buildCommand !== 'npm ci && npm run build:backend' || details?.envSpecificDetails?.startCommand !== 'npm start' || details?.disk || details?.numInstances !== 1) fail('Render service configuration differs from the approved free Node demo. No configuration changes were made; inspect this service.');
  state.render.serviceId = service.id;
  state.render.url = approvedPublicUrl(details.url, '.onrender.com');
  state.render.dashboardUrl = service.dashboardUrl;
  delete state.render.pendingCreate;
  await saveState();
}
async function ensureRenderService(owner) {
  if (state.render.serviceId) { await verifyService(await request('render', `/services/${enc(state.render.serviceId)}`), owner); return; }
  const found = await matchingRenderServices(owner);
  if (found.length > 1) fail('Multiple Render services match the saved name; manual inspection is required.');
  if (found.length === 1) { await verifyService(found[0], owner); log('Resumed the existing free Render service.'); return; }
  if (state.render.pendingCreate) fail('A previous Render creation has an unknown outcome and is not yet visible. Retry --deploy later or inspect Render; no second service will be created.');
  state.render.pendingCreate = { at: new Date().toISOString() };
  await saveState();
  log(`Creating the single free Render service ${state.render.name} in ${owner.name}.`);
  let result;
  try { result = await request('render', '/services', { method: 'POST', body: renderPayload(owner.id, state.netlify.url, state.render.name) }); }
  catch (error) { if (definitiveRejection(error)) { delete state.render.pendingCreate; await saveState(); } throw error; }
  if (result?.service?.id) { state.render.serviceId = result.service.id; if (result.deployId) state.render.deployId = result.deployId; await saveState(); }
  await verifyService(result?.service, owner);
  log(`Backend host: ${state.render.url}`);
}

async function renderDeploys() {
  const rows = await request('render', `/services/${enc(state.render.serviceId)}/deploys?limit=100`);
  if (!Array.isArray(rows)) fail('Render returned an unexpected deploy list.');
  return rows.map(row => row.deploy).filter(Boolean);
}
async function ensureRenderDeploy(commit, force) {
  if (!state.render.pendingDeploy && !force && state.render.deployedCommit === commit && state.render.deployId) return;
  if (!state.render.pendingDeploy && !force && state.render.deployId && !state.render.deployedCommit) return;
  const matching = (await renderDeploys()).filter(deploy => deploy.commit?.id === commit);
  if (!force && matching.length && !state.render.pendingDeploy) {
    state.render.deployId = matching[0].id;
    await saveState();
    return;
  }
  if (state.render.pendingDeploy) {
    if (state.render.pendingDeploy.commit !== commit) fail('The saved pending Render deploy belongs to another source commit. Reconcile that deploy before requesting a new one.');
    const after = matching.filter(deploy => Date.parse(deploy.createdAt) >= Date.parse(state.render.pendingDeploy.at) - 5000);
    if (after.length !== 1) fail('A Render deploy request has an unknown outcome. Inspect the service or rerun --deploy later; no duplicate deploy was requested.');
    state.render.deployId = after[0].id;
    delete state.render.pendingDeploy;
    await saveState();
    return;
  }
  state.render.pendingDeploy = { at: new Date().toISOString(), commit };
  await saveState();
  let deploy;
  try { deploy = await request('render', `/services/${enc(state.render.serviceId)}/deploys`, { method: 'POST', body: { commitId: commit, clearCache: 'do_not_clear' } }); }
  catch (error) { if (definitiveRejection(error)) { delete state.render.pendingDeploy; await saveState(); } throw error; }
  if (!deploy?.id) fail('Render accepted the deploy without an ID. Rerun --deploy to reconcile its status.');
  state.render.deployId = deploy.id;
  delete state.render.pendingDeploy;
  await saveState();
}
async function waitRender(commit) {
  const deadline = Date.now() + 15 * 60_000;
  let last = '';
  while (Date.now() < deadline) {
    const deploy = await request('render', `/services/${enc(state.render.serviceId)}/deploys/${enc(state.render.deployId)}`);
    if (deploy.status !== last) { log(`Render deployment: ${deploy.status}`); last = deploy.status; }
    if (deploy.status === 'live') {
      if (deploy.commit?.id !== commit) fail('The live Render deployment does not match the verified main commit. Rerun with --redeploy to deploy that exact commit.');
      state.render.deployedCommit = commit;
      state.render.deployStatus = 'live';
      await saveState();
      return;
    }
    if (['build_failed', 'update_failed', 'pre_deploy_failed', 'canceled', 'deactivated'].includes(deploy.status)) {
      state.render.deployStatus = deploy.status;
      await saveState();
      fail(`Render deployment ended as ${deploy.status}. Inspect ${state.render.dashboardUrl}; after fixing the issue use --redeploy. The service remains free.`);
    }
    await sleep(10000);
  }
  fail('Render is still deploying after the 15-minute wait. Rerun --deploy to resume the same deployment.');
}
async function verifyBackend() {
  const backend = backendTarget();
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${backend.url}/health`, { headers: { Origin: state.netlify.url }, signal: AbortSignal.timeout(15000) });
      const health = await response.json();
      if (response.status === 403) fail('The live API rejected the exact frontend origin. Fix CORS_ORIGIN before publishing.');
      if (response.ok && health.status === 'ok') {
        if (response.headers.get('access-control-allow-origin') !== state.netlify.url) fail('The live API does not allow the exact frontend origin. Fix the saved service CORS_ORIGIN before publishing.');
        if (health.historyPolicy !== 'temporary') fail('The hosted backend does not report temporary history. Verify HISTORY_POLICY before publishing.');
        backend.healthVerifiedAt = new Date().toISOString();
        await saveState();
        log('Live backend health, temporary-history policy, and exact CORS origin verified.');
        return;
      }
    } catch (error) { if (error.message?.startsWith('The live API') || error.message?.startsWith('The hosted backend')) throw error; }
    log('Waiting for the free backend to respond…');
    await sleep(5000);
  }
  fail('Backend did not become ready within two minutes. Rerun --deploy after inspecting the existing free service.');
}

async function buildFrontend() {
  const npmCli = resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (!existsSync(npmCli)) fail('The Node installation does not contain npm-cli.js; use the tested Node 24 installation.');
  const backendUrl = backendTarget().url;
  const env = { ...process.env, VITE_API_BASE_URL: backendUrl };
  for (const name of ['NETLIFY_AUTH_TOKEN', 'RENDER_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'RENDER_OWNER_ID', 'NETLIFY_ACCOUNT_SLUG']) delete env[name];
  log(`Building frontend with API ${backendUrl}.`);
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [npmCli, 'run', 'build:frontend'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', value => process.stdout.write(safe(value)));
    child.stderr.on('data', value => process.stderr.write(safe(value)));
    child.on('error', () => reject(new Error('Could not launch the frontend build.')));
    child.on('exit', code => code === 0 ? resolvePromise() : reject(new Error(`Frontend build failed with exit code ${code}. Nothing was uploaded.`)));
  });
  const dist = resolve(ROOT, 'frontend/dist');
  await access(resolve(dist, 'index.html'));
  // API digest deploys do not apply root netlify.toml. Ship the rules as actual files.
  await writeFile(resolve(dist, '_redirects'), '/* /index.html 200\n');
  await writeFile(resolve(dist, '_headers'), '/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n');
  return collectFiles(dist);
}
async function collectFiles(dist) {
  const files = new Map();
  let totalBytes = 0;
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = resolve(directory, entry.name);
      const rel = relative(dist, full);
      if (rel === '..' || rel.startsWith(`..${sep}`) || entry.isSymbolicLink()) fail('A deployment file is outside frontend/dist or is a symbolic link.');
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) {
        const bytes = await readFile(full);
        for (const token of [credentials.NETLIFY_AUTH_TOKEN, credentials.RENDER_API_KEY].filter(Boolean)) if (bytes.includes(Buffer.from(token))) fail('A provider credential was found in built output. Nothing was uploaded.');
        totalBytes += bytes.length;
        files.set(`/${rel.split(sep).join('/')}`, { bytes, sha: createHash('sha1').update(bytes).digest('hex') });
      }
    }
  }
  await visit(dist);
  if (files.size > 2000 || totalBytes > 40 * 1024 * 1024) fail('Frontend upload exceeds the expected small static demo bounds.');
  const manifest = Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, file]) => [path, file.sha]));
  const digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  log(`Prepared ${files.size} static files (${(totalBytes / 1024 / 1024).toFixed(2)} MiB).`);
  return { files, manifest, digest };
}
async function ensureNetlifyDeploy(bundle, commit, force) {
  const saved = state.netlify.deploy;
  if (saved?.id && saved.digest === bundle.digest && (!force || saved.pending)) return saved.id;
  if (saved?.pending && saved.digest !== bundle.digest) fail('Built files differ from an interrupted Netlify deployment. Preserve the saved state and inspect the pending deploy before creating another.');
  if (saved?.pending && !saved.id) {
    const rows = await request('netlify', `/sites/${enc(state.netlify.siteId)}/deploys?per_page=100`);
    const found = rows.filter(deploy => deploy.title === saved.title && deploy.site_id === state.netlify.siteId);
    if (found.length !== 1) fail('A Netlify deploy request has an unknown outcome. Inspect the site or rerun --deploy later; no second deploy was created.');
    saved.id = found[0].id;
    await saveState();
    return saved.id;
  }
  const title = `BizPlus AI ${commit.slice(0, 12)} ${bundle.digest.slice(0, 12)} ${Date.now()}`;
  state.netlify.deploy = { pending: true, at: new Date().toISOString(), digest: bundle.digest, commit, title };
  await saveState();
  let deploy;
  try { deploy = await request('netlify', `/sites/${enc(state.netlify.siteId)}/deploys?title=${enc(title)}`, { method: 'POST', body: { files: bundle.manifest, draft: false } }); }
  catch (error) { if (definitiveRejection(error)) { state.netlify.deploy.pending = false; state.netlify.deploy.status = 'request_rejected'; await saveState(); } throw error; }
  if (!deploy?.id) fail('Netlify accepted a deploy without an ID. Rerun --deploy to reconcile.');
  state.netlify.deploy.id = deploy.id;
  await saveState();
  return deploy.id;
}
async function uploadNetlify(bundle, id) {
  const deadline = Date.now() + 5 * 60_000;
  let last = '';
  while (Date.now() < deadline) {
    const deploy = await request('netlify', `/deploys/${enc(id)}`);
    if (deploy.site_id !== state.netlify.siteId) fail('Netlify deploy identity does not match the saved site.');
    if (deploy.state !== last) { log(`Netlify deployment: ${deploy.state}`); last = deploy.state; }
    if (['error', 'failed'].includes(deploy.state)) {
      state.netlify.deploy.pending = false;
      state.netlify.deploy.status = deploy.state;
      await saveState();
      fail(`Netlify deployment failed${deploy.error_message ? `: ${safe(deploy.error_message).slice(0, 300)}` : ''}. Inspect the saved site; after fixing the issue use --redeploy. No extra site was created.`);
    }
    if (deploy.state === 'ready') {
      state.netlify.deploy.pending = false;
      state.netlify.deploy.status = 'ready';
      state.netlify.deploy.publishedAt = deploy.published_at || new Date().toISOString();
      await saveState();
      return;
    }
    for (const sha of new Set(deploy.required ?? [])) {
      const file = [...bundle.files].find(([, value]) => value.sha === sha);
      if (!file) fail('Netlify requested a digest outside the current frontend bundle. Nothing else was uploaded.');
      const [path, value] = file;
      const uploadPath = path.slice(1).split('/').map(enc).join('/');
      await request('netlify', `/deploys/${enc(id)}/files/${uploadPath}?size=${value.bytes.length}`, { method: 'PUT', body: value.bytes, binary: true });
    }
    await sleep(2000);
  }
  fail('Netlify is still preparing the saved deployment. Rerun --deploy to resume it.');
}
async function verifyFrontend() {
  for (const path of ['/', '/incidents']) {
    const response = await fetch(`${state.netlify.url}${path}`, { signal: AbortSignal.timeout(20000) });
    const html = await response.text();
    if (!response.ok || !html.includes('id="root"')) fail(`Published frontend ${path} did not serve the React page. Check the SPA redirect.`);
  }
  state.verifiedAt = new Date().toISOString();
  await saveState();
  log(`Deployment hosts verified. Public app: ${state.netlify.url}`);
  log(`API: ${backendTarget().url}`);
  log('Next: verify the full public browser journey, a second browser session, mobile layout, and cold start. These host checks do not claim those tests are complete.');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const mode = options.mode;
  netlifyOnly = options.netlifyOnly;
  await loadCredentials();
  await loadState();
  if (!netlifyOnly && mode !== '--check' && existsSync(NATIVE_RENDER_PATH) && !state.render) fail('A native Render backend is already registered in this workspace. Add --netlify-only to reuse it; a second backend will not be created.');
  let nativeRender;
  let nativeRenderError;
  if (netlifyOnly) {
    try { nativeRender = await loadNativeRender(); }
    catch (error) { if (mode !== '--check') throw error; nativeRenderError = safe(error.message); }
    log(JSON.stringify({ nativeRenderMetadataPresent: Boolean(nativeRender), nativeRender, nativeRenderError }, null, 2));
  }
  const identity = await identities(mode !== '--check', !netlifyOnly);
  if (mode === '--check') {
    if (state.netlify?.siteId || backendTarget()?.serviceId) log(JSON.stringify({ saved: { frontend: state.netlify?.url, backend: backendTarget()?.url, siteId: state.netlify?.siteId, serviceId: backendTarget()?.serviceId } }, null, 2));
    return;
  }
  if (!netlifyOnly && state.nativeRender && !state.render) fail('The saved deployment uses a native Render backend. Add --netlify-only to resume it; a second backend will not be created.');
  if (netlifyOnly && state.nativeRender && (state.nativeRender.serviceId !== nativeRender.serviceId || state.nativeRender.workspaceId !== nativeRender.workspaceId)) fail('Native Render metadata differs from the saved backend identity. Inspect the state before changing deployment targets.');
  const targets = netlifyOnly ? { account: selectNetlifyAccount(identity) } : selectTargets(identity);
  const commit = verifiedSource();
  if (mode === '--plan') {
    log(JSON.stringify({ repository: REPO, branch: BRANCH, commit, netlifyAccount: accountSummary(targets.account), ...(netlifyOnly ? { nativeRender, renderApiOperations: false, requiredRenderEnvironment: { CORS_ORIGIN: state.netlify?.url || '<actual Netlify origin printed after site creation>' }, renderVerification: 'Verify the native backend commit and free configuration through the Render connector.' } : { renderWorkspace: ownerSummary(targets.owner), service: renderPayload(targets.owner.id, state.netlify?.url || '<created Netlify HTTPS origin>', state.render?.name || '<one unique bizplus-ai-api name>') }), frontend: 'Build using actual Render URL; digest-upload only frontend/dist, including _redirects and _headers.', sourceControl: 'Existing private repository stays private; no account upgrades, disks, or billing changes.' }, null, 2));
    return;
  }
  let lock;
  try { lock = await open(LOCK_PATH, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') fail('Another deployment holds .local/deployment.lock. If no helper is running, inspect that local lock before removing it.'); throw error; }
  try {
    await lock.writeFile(`${process.pid}\n`);
    const suffix = state.suffix || randomBytes(3).toString('hex');
    state.suffix = suffix;
    state.netlify ??= { name: `bizplus-ai-emadfar007-${suffix}`, accountId: targets.account.id, accountSlug: targets.account.slug };
    if (netlifyOnly) state.nativeRender = { ...state.nativeRender, ...nativeRender, management: 'native-connector' };
    else state.render ??= { name: `bizplus-ai-api-${suffix}`, ownerId: targets.owner.id };
    if (state.netlify.accountId !== targets.account.id || (!netlifyOnly && state.render.ownerId !== targets.owner.id)) fail('Selected accounts differ from the saved deployment targets.');
    await saveState();
    await ensureNetlifySite(targets.account);
    if (netlifyOnly) {
      log(JSON.stringify({ requiredRenderEnvironment: { serviceId: nativeRender.serviceId, workspaceId: nativeRender.workspaceId, CORS_ORIGIN: state.netlify.url }, applyVia: 'Native Render connector. This helper will not update or redeploy Render; rerun the same Netlify-only command after applying the exact origin.' }, null, 2));
    } else {
      await ensureRenderService(targets.owner);
      await ensureRenderDeploy(commit, mode === '--redeploy');
      await waitRender(commit);
    }
    await verifyBackend();
    const bundle = await buildFrontend();
    const deployId = await ensureNetlifyDeploy(bundle, commit, mode === '--redeploy');
    await uploadNetlify(bundle, deployId);
    await verifyFrontend();
  } finally { await lock.close(); await unlink(LOCK_PATH); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(safe(error.message)); process.exitCode = 1; });
}
