// Legacy smoke-frontend runner.
//
// The repo's smoke_*.js files are bare `async page => {...}` fixture
// callbacks (no export, no committed harness). This script is a self-contained
// runner that makes them executable: it builds the Vite app if needed, serves
// frontend/dist on the smoke file's documented loopback port, launches a
// FRESH Playwright Chromium context, and invokes the callback. No live
// inference, no personal state. All API traffic is intercepted by the smoke file
// itself.
//
// Usage: node smoke_frontend.mjs <smoke-file.js> [--port PORT]
//   --port defaults to the port the smoke file documents (http://127.0.0.1:PORT)
//   or 8038 if it does not document one.
import { readFile } from 'node:fs/promises';
import { readdirSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
);

const smokeFile = process.argv[2];
if (!smokeFile) {
  console.error(
    'usage: node smoke_frontend.mjs <smoke-file.js> [--port PORT]',
  );
  process.exit(2);
}
const absSmokeFile = resolve(smokeFile);
if (!existsSync(absSmokeFile)) {
  console.error(`smoke file not found: ${absSmokeFile}`);
  process.exit(2);
}

// --- port -------------------------------------------------------------
const args = process.argv.slice(3).flat();
let port = null;
const explicitPort = args.find((a) => a.startsWith('--port='));
if (explicitPort) {
  port = parseInt(explicitPort.split('=').at(1), 10);
}
if (!port) {
  const smokeText = await readFile(absSmokeFile, 'utf8');
  const m = smokeText.match(/127\.0\.0\.1:(\d+)/);
  port = m ? parseInt(m[1], 10) : 8038;
}

const frontendDir = join(repoRoot, 'frontend');
const distDir = join(frontendDir, 'dist');
const playwrightDir = join(frontendDir, 'node_modules', 'playwright');

// --- ensure the Vite build exists -------------------------------------
if (!existsSync(join(distDir, 'index.html'))) {
  console.log(`[smoke] building frontend -> ${distDir}`);
  const builder = spawn(
    process.execPath,
    [
      'npm',
      'run',
      'build',
    ],
    { cwd: frontendDir, stdio: 'inherit' },
  );
  await new Promise((res, rej) => {
    builder.on('close', (code) =>
      code === 0 ? res() : rej(new Error('vite build failed')),
    );
  });
}

// --- static server for the build --------------------------------------
const MIME = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  svg: 'image/svg+xml',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  json5: 'application/json',
};

const isDirectory = (p) => {
  try {
    return readdirSync(p).length >= 0;
  } catch {
    return false;
  }
};

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = decodeURIComponent(url.pathname);
  let file = join(distDir, pathname);
  if (!existsSync(file) || isDirectory(file)) {
    file = join(distDir, 'index.html');
  }
  readFile(file)
    .then((content) => {
      const ext = file.split('.').pop()?.toLowerCase() || 'bin';
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
      });
      res.end(content);
    })
    .catch(() => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });
});

await new Promise((res, rej) => {
  server.on('error', rej);
  server.listen(port, '127.0.0.1', () => res());
});
console.log(`[smoke] serving ${distDir} on http://127.0.0.1:${port}`);

// --- Playwright -------------------------------------------------------
const { chromium } = await import(
  pathToFileURL(join(playwrightDir, 'index.mjs')).href,
);

const browser = await chromium.launch();
let failed;
let smokeResult;
try {
  const smokeText = await readFile(absSmokeFile, 'utf8');
  const start = smokeText.search(/async\s*\(?page\)?\s*=>/);
  if (start === -1) {
    throw new Error('no `async page =>` callback found in smoke file');
  }
  const arrowSrc = smokeText.slice(start);
  const fn = new Function('return ' + arrowSrc)();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  smokeResult = await fn(page);
} catch (e) {
  failed = true;
  console.error('[smoke] FAILED');
  console.error(e && e.stack ? String(e.stack) : String(e));
} finally {
  await browser.close().catch(() => {});
  server.close();
  await setTimeout(50);
}

if (failed) {
  process.exit(1);
}
console.log('[smoke] PASSED');
if (smokeResult !== undefined && typeof smokeResult === 'object') {
  console.log(JSON.stringify(smokeResult, null, 2));
} else {
  console.log('[smoke] result:', smokeResult ?? '');
}
process.exit(0);
