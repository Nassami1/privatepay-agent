#!/usr/bin/env tsx
/**
 * Zero-dependency static server for the dashboard.
 *
 *   npm run dev            # http://127.0.0.1:4173
 *   npm run dev -- --port 8080
 *
 * `npx serve frontend` works too; this exists so the demo needs no network to
 * fetch a server package.
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function portFromArgs(): number {
  const index = process.argv.indexOf('--port');
  if (index !== -1) {
    const parsed = Number.parseInt(process.argv[index + 1] ?? '', 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 4173;
}

const root = resolve(process.cwd(), 'frontend');
if (!existsSync(join(root, 'index.html'))) {
  console.error(`[serve] no frontend/index.html under ${root}`);
  process.exit(1);
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const decoded = decodeURIComponent(url.pathname);
  const candidate = normalize(join(root, decoded === '/' ? 'index.html' : decoded));
  const insideRoot = candidate === root || candidate.startsWith(root + sep);
  const exists = insideRoot && existsSync(candidate) && statSync(candidate).isFile();
  const isFileRequest = extname(decoded) !== '';
  // Missing data files must 404 (so the dashboard shows its empty state) while
  // unknown routes still get the single-page shell.
  const target = exists ? candidate : isFileRequest ? null : join(root, 'index.html');

  if (target === null) {
    response.statusCode = 404;
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.end('not found');
    return;
  }

  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', MIME[extname(target)] ?? 'application/octet-stream');
  createReadStream(target)
    .on('error', () => {
      response.statusCode = 404;
      response.end('not found');
    })
    .pipe(response);
});

const port = portFromArgs();
server.listen(port, '127.0.0.1', () => {
  console.log(`[serve] dashboard at http://127.0.0.1:${port}`);
});
