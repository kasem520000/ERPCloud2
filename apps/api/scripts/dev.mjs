#!/usr/bin/env node
/**
 * `pnpm --filter @erp/api dev` — watch-mode runner for the NestJS API.
 *
 * Why not `tsx watch src/main.ts` (what this script replaces)?
 *
 * tsx transpiles with esbuild, and esbuild does **not** implement
 * `emitDecoratorMetadata`. Nest resolves constructor dependencies from the
 * `design:paramtypes` metadata TypeScript emits, so under tsx every provider loses its
 * parameter types and the application dies during bootstrap with:
 *
 *   Nest can't resolve dependencies of the TenantGuard (?, ERP_DATABASE_HANDLE)
 *
 * The production build (`tsc`) was always fine — only dev mode was broken, which is why
 * the API could never be started locally.
 *
 * This runner keeps `tsc` (the only transpiler that emits the metadata) in watch mode and
 * lets `node --watch` restart the process whenever the emitted JavaScript changes.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(apiRoot, 'dist', 'main.js');
const children = [];

function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: apiRoot, stdio: 'inherit', shell: false, ...options });
  children.push(child);
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[api:dev] ${command} exited (${signal ?? code}) — stopping.`);
    shutdown(1);
  });
  return child;
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 200);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

/**
 * Locate the real `tsc` entry file inside the `typescript` package so we can run it
 * through Node directly.
 *
 * We deliberately do NOT spawn the `.bin/tsc` shim: on Windows those links are
 * `.CMD`/`.ps1` shell scripts (or an extension-less POSIX script), and Node's
 * `spawn(..., { shell: false })` cannot launch any of them (ENOENT / EINVAL). Running
 * `<node> <typescript>/lib/tsc.js` needs no shell and behaves identically everywhere.
 */
function resolveTscJs() {
  try {
    // typescript is a root devDependency; Node's upward resolution finds it from here.
    const require = createRequire(import.meta.url);
    const tsMain = require.resolve('typescript'); // .../typescript/lib/typescript.js
    const pkgRoot = path.resolve(path.dirname(tsMain), '..');
    const tscJs = path.join(pkgRoot, 'lib', 'tsc.js');
    if (existsSync(tscJs)) return tscJs;
  } catch {
    /* not resolvable — fall back to letting the shell find `tsc` on PATH */
  }
  return null;
}

const tscJs = resolveTscJs();

if (tscJs) {
  console.log('[api:dev] compiling with tsc --watch (decorator metadata is required by Nest DI)…');
  run(process.execPath, [tscJs, '-p', 'tsconfig.json', '--watch', '--preserveWatchOutput']);
} else {
  console.log('[api:dev] compiling with tsc --watch (falling back to shell resolution)…');
  run('tsc', ['-p', 'tsconfig.json', '--watch', '--preserveWatchOutput'], { shell: true });
}

// Wait for the first successful emit before starting the server, otherwise `node --watch`
// exits immediately on a missing entry point.
const started = Date.now();
const poll = setInterval(() => {
  if (existsSync(entry)) {
    clearInterval(poll);
    console.log('[api:dev] starting node --watch dist/main.js');
    run(process.execPath, ['--watch', '--watch-preserve-output', entry]);
    return;
  }
  if (Date.now() - started > 180_000) {
    clearInterval(poll);
    console.error('[api:dev] dist/main.js was never produced — check the TypeScript errors above.');
    shutdown(1);
  }
}, 500);
