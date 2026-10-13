import express, { type Express } from 'express';
import { statSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface HostedFrontendOptions {
  /** Explicit override for tests; production uses the SERVE_FRONTEND flag. */
  enabled?: boolean;
  /** Internal fixture override only. Never populate this option from a request. */
  directory?: string;
}

const SPA_VIEWS = new Set(['/', '/login', '/shop', '/live-tests', '/workflows', '/incidents', '/recovery']);
const DETAIL_VIEW = /^\/(?:incidents|recovery)\/[A-Za-z0-9_-]{1,128}$/;
const FRONTEND_DIRECTORY = fileURLToPath(new URL('../../../frontend/dist/', import.meta.url));

/** Register after all API routes and before the existing JSON 404 handler. */
export function registerHostedFrontend(app: Express, options: HostedFrontendOptions = {}): boolean {
  if (!(options.enabled ?? process.env.SERVE_FRONTEND === 'true')) return false;
  const directory = resolve(options.directory ?? FRONTEND_DIRECTORY);
  const indexFile = resolve(directory, 'index.html');
  try {
    if (!statSync(indexFile).isFile()) throw new Error('Not a regular file');
  } catch {
    throw new Error('SERVE_FRONTEND=true requires a built frontend/dist/index.html. Run the hosted frontend build before starting the backend.');
  }

  const staticFiles = express.static(directory, {
    index: false,
    redirect: false,
    dotfiles: 'ignore',
    fallthrough: true,
    setHeaders(response, path) {
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      response.setHeader('Cache-Control', /-[A-Za-z0-9_-]{6,}\./.test(basename(path)) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });

  app.use((request, response, next) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') { next(); return; }
    let path: string;
    try { path = decodeURIComponent(request.path); } catch { next(); return; }
    // Static routes are intentionally bounded. Private, API, sandbox, and unknown
    // paths must continue to the API's existing 404 rather than receive index.html.
    if (path.includes('\\') || path.split('/').some(segment => segment.startsWith('.'))) { next(); return; }
    const normalized = path.length > 1 ? path.replace(/\/$/, '') : path;
    if (SPA_VIEWS.has(normalized) || DETAIL_VIEW.test(normalized)) {
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      response.setHeader('Cache-Control', 'no-cache');
      response.sendFile('index.html', { root: directory, dotfiles: 'ignore' }, error => { if (error) next(error); });
      return;
    }
    if (path.startsWith('/assets/') || path === '/favicon.svg' || path === '/index.html') {
      staticFiles(request, response, next);
      return;
    }
    next();
  });
  return true;
}
