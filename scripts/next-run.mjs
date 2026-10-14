#!/usr/bin/env node
/**
 * Cross-platform runner for the four Next.js surfaces (`apps/staff`, `apps/marketing`,
 * `apps/platform-admin`, `apps/customer-portal`).
 *
 * The apps' npm scripts used to embed bash-isms such as `${STAFF_PORT:-3001}` and to
 * rely on pnpm putting `node_modules/.bin` shims on the PATH. Both assumptions break
 * when the stack is run from a Windows `cmd`/PowerShell prompt:
 *
 *   - `${STAFF_PORT:-3001}` is a bash default-value expansion; Windows shells pass it
 *     through literally, which `next dev` then rejects.
 *   - spawning a `.bin/next`/`next.CMD` shim with Node's `spawn(..., {shell:false})`
 *     fails on Windows (ENOENT / EINVAL).
 *
 * This loader:
 *   1. populates `process.env` from the workspace root `.env` (same rules as
 *      `next.config.mjs`, via `scripts/dotenv.mjs`);
 *   2. resolves the app port from the corresponding env var, falling back to a default;
 *   3. runs the real `next` CLI entry through Node directly — never through a shell or a
 *      `.bin`/`.cmd` shim — so the same code works on every OS.
 *
 * Usage: `node scripts/next-run.mjs <staff|marketing|platform-admin|customer-portal> [dev|start]`
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFiles } from './dotenv.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnvFiles(repoRoot);

const APP_META = {
  staff: { portEnv: 'STAFF_PORT', defaultPort: '3001' },
  marketing: { portEnv: 'MARKETING_PORT', defaultPort: '3002' },
  'platform-admin': { portEnv: 'PLATFORM_ADMIN_PORT', defaultPort: '3003' },
  'customer-portal': { portEnv: 'CUSTOMER_PORTAL_PORT', defaultPort: '3004' },
};

const [, , appName = '', mode = 'dev'] = process.argv;
const meta = APP_META[appName];
if (!meta) {
  console.error(`[next-run] unknown app "${appName}" — expected one of: ${Object.keys(APP_META).join(', ')}`);
  process.exit(2);
}

const port = process.env[meta.portEnv] || meta.defaultPort;
const appDir = path.join(repoRoot, 'apps', appName);

// Locate the real `next` CLI entry file inside the app's dependency tree so we can run
// it with `node` directly (no `.bin`/`.cmd` shim, no dependence on shell PATH).
let nextEntry;
try {
  const require = createRequire(path.join(appDir, 'noop.js'));
  const nextPkgRoot = path.dirname(require.resolve('next/package.json'));
  nextEntry = path.join(nextPkgRoot, 'dist', 'bin', 'next');
} catch (error) {
  console.error(`[next-run] could not resolve "next" inside apps/${appName}: ${error.message}`);
  process.exit(1);
}

const command = mode === 'start' ? 'start' : 'dev';
console.log(`[next-run] ${appName}: running "next ${command}" on port ${port}…`);

const child = spawn(
  process.execPath,
  [nextEntry, command, '--hostname', '0.0.0.0', '--port', port],
  { cwd: appDir, stdio: 'inherit' },
);

child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
