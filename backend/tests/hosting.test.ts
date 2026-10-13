import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest, type Server } from 'node:http';
import { registerHostedFrontend, type HostedFrontendOptions } from '../src/hosting/frontend.js';

const FIXTURE_PARENT = fileURLToPath(new URL('../../.local/', import.meta.url));
const INDEX = '<!doctype html><html><head><title>Hosting fixture</title></head><body><div id="root">BizPlus UI fixture</div></body></html>';
const PRIVATE = 'private-fixture-must-never-be-served';

async function withFixture(operation: (directory: string) => Promise<void>) {
  await mkdir(FIXTURE_PARENT, { recursive: true });
  const fixture = await mkdtemp(join(FIXTURE_PARENT, 'hosting-test-'));
  const directory = join(fixture, 'public');
  try {
    await mkdir(join(directory, 'assets'), { recursive: true });
    await mkdir(join(directory, 'api'), { recursive: true });
    await mkdir(join(directory, '.local'), { recursive: true });
    await writeFile(join(directory, 'index.html'), INDEX);
    await writeFile(join(directory, 'assets', 'app-Abcd1234.js'), 'console.log("public asset");');
    await writeFile(join(directory, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(join(fixture, 'private.env'), PRIVATE);
    await writeFile(join(directory, '.env'), PRIVATE);
    await writeFile(join(directory, 'secret.txt'), PRIVATE);
    await writeFile(join(directory, '.local', 'integrations.env'), PRIVATE);
    await writeFile(join(directory, 'api', 'private.txt'), PRIVATE);
    await operation(directory);
  } finally {
    const target = resolve(fixture);
    assert.equal(dirname(target), resolve(FIXTURE_PARENT));
    assert.ok(basename(target).startsWith('hosting-test-'));
    await rm(target, { recursive: true, force: true });
  }
}
async function withServer(directory: string, operation: (base: string) => Promise<void>, options: HostedFrontendOptions = { enabled: true }) {
  const app = express();
  app.get('/health', (_request, response) => response.json({ status: 'ok' }));
  app.get('/api/probe', (_request, response) => response.json({ source: 'api' }));
  app.get('/sandbox/probe', (_request, response) => response.json({ source: 'sandbox' }));
  registerHostedFrontend(app, { directory, ...options });
  app.use((_request, response) => response.status(404).json({ code: 'NOT_FOUND' }));
  const server: Server = await new Promise((resolveServer, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolveServer(listening));
    listening.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try { await operation(`http://127.0.0.1:${address.port}`); }
  finally {
    await new Promise<void>((resolveClose, reject) => { server.close(error => error ? reject(error) : resolveClose()); server.closeIdleConnections(); });
  }
}
async function rawGet(base: string, path: string) {
  return new Promise<{ status: number; body: string }>((resolveResponse, reject) => {
    const request = httpRequest(base, { path }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolveResponse({ status: response.statusCode ?? 0, body }));
    });
    request.once('error', reject);
    request.end();
  });
}

test('hosting stays disabled by default and an explicit opt-out preserves API-only behavior', async () => {
  await withFixture(async directory => {
    const previous = process.env.SERVE_FRONTEND;
    delete process.env.SERVE_FRONTEND;
    try {
      await withServer(directory, async base => {
        assert.equal((await fetch(`${base}/shop`)).status, 404);
        assert.equal((await fetch(`${base}/assets/app-Abcd1234.js`)).status, 404);
        assert.deepEqual(await (await fetch(`${base}/api/probe`)).json(), { source: 'api' });
      }, {});
      process.env.SERVE_FRONTEND = 'true';
      await withServer(directory, async base => assert.equal((await fetch(`${base}/`)).status, 404), { enabled: false });
    } finally { if (previous === undefined) delete process.env.SERVE_FRONTEND; else process.env.SERVE_FRONTEND = previous; }
  });
});

test('known frontend routes and direct detail URLs receive fresh HTML with response headers', async () => {
  await withFixture(async directory => withServer(directory, async base => {
    for (const path of ['/', '/login', '/shop', '/shop/', '/live-tests', '/workflows', '/incidents', '/incidents/5c1a810e-261f-4f16-b7f7-d9bef3b1c3db', '/recovery', '/recovery/demo-incident']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('content-type') ?? '', /text\/html/);
      assert.equal(response.headers.get('cache-control'), 'no-cache');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
      assert.equal(await response.text(), INDEX);
    }
    const head = await fetch(`${base}/shop`, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
  }));
});

test('public static assets are served while missing assets remain JSON 404', async () => {
  await withFixture(async directory => withServer(directory, async base => {
    const asset = await fetch(`${base}/assets/app-Abcd1234.js`);
    assert.equal(asset.status, 200); assert.match(asset.headers.get('content-type') ?? '', /javascript/);
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await asset.text(), 'console.log("public asset");');
    const favicon = await fetch(`${base}/favicon.svg`);
    assert.equal(favicon.status, 200); assert.match(favicon.headers.get('content-type') ?? '', /image\/svg\+xml/);
    assert.equal(favicon.headers.get('cache-control'), 'no-cache'); await favicon.text();
    const missing = await fetch(`${base}/assets/missing.js`);
    assert.equal(missing.status, 404); assert.deepEqual(await missing.json(), { code: 'NOT_FOUND' });
  }));
});

test('API, sandbox, private files, unknown views, and mutations are never rewritten to the SPA', async () => {
  await withFixture(async directory => withServer(directory, async base => {
    for (const path of ['/api/private.txt', '/api/missing', '/sandbox/missing', '/health/missing', '/.env', '/.local/integrations.env', '/secret.txt', '/backend/src/app.ts', '/unexpected', '/shop/more', '/incidents/demo/more']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 404, path); assert.match(response.headers.get('content-type') ?? '', /application\/json/);
      const body = await response.text(); assert.ok(!body.includes(PRIVATE)); assert.ok(!body.includes('id="root"'));
    }
    assert.deepEqual(await (await fetch(`${base}/api/probe`)).json(), { source: 'api' });
    assert.deepEqual(await (await fetch(`${base}/sandbox/probe`)).json(), { source: 'sandbox' });
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: 'ok' });
    assert.equal((await fetch(`${base}/shop`, { method: 'POST' })).status, 404);
    for (const path of ['/assets/%2e%2e/%2e%2e/private.env', '/assets/%2eenv', '/assets/%5c..%5cprivate.env']) {
      const response = await rawGet(base, path); assert.equal(response.status, 404, path); assert.ok(!response.body.includes(PRIVATE));
    }
  }));
});

test('enabled hosting requires a built index file instead of silently publishing a broken frontend', async () => {
  await withFixture(async directory => {
    assert.throws(() => registerHostedFrontend(express(), { enabled: true, directory: join(directory, 'missing') }), /requires a built frontend\/dist\/index\.html/);
  });
});
