import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

/**
 * R-19 regression — the test gate must fail when tests fail.
 *
 * `embedded-postgres` (booted by `startTestDatabaseServer` for every run without
 * `TEST_DATABASE_URL`) registers `async-exit-hook`, whose `beforeExit` handler calls
 * `process.exit(0)` after its cleanup hooks run. Vitest reports failing tests by setting
 * `process.exitCode = 1` and letting the process end naturally — which fires
 * `beforeExit` — so every red run looked green to the shell, to `pnpm verify` and to
 * GitHub Actions (the repository's only CI run "succeeded" on a commit that had a
 * failing spec). `packages/testing/src/test-database.ts` now removes that listener
 * right after the server starts; this spec pins the property so it cannot regress.
 *
 * It proves it in a real child process, because the property only exists at process
 * exit: the child starts the embedded server (the code path that installs the hook),
 * stops it the way the global-setup teardown does, sets a distinctive exit code and
 * returns naturally. If the hook ever hijacks `beforeExit` again the child exits 0 and
 * this spec fails.
 *
 * Note: the child imports `@erp/testing/database` from the built `dist/`, so a bare
 * `pnpm --dir apps/api test` on a fresh clone needs the workspace packages built first
 * (`pnpm typecheck` or `pnpm build`) — the same documented requirement as
 * `packages/database/src/rls.spec.ts`. `pnpm verify` always satisfies it.
 *
 * With `TEST_DATABASE_URL` set the server is external and no hook is installed; the
 * assertion still holds (the exit code must survive regardless of the mode).
 */
describe('exit-code gate — starting the test database must not mask the process exit code', () => {
  const script = `
import { startTestDatabaseServer } from '@erp/testing/database';

async function main(): Promise<void> {
  const server = await startTestDatabaseServer({});
  await server.stop();
  // A distinctive code: 1 is what vitest uses, 6 can only come from this script.
  process.exitCode = 6;
}

void main();
`;

  let dir: string | undefined;

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('a child that started and stopped the embedded server still exits with its own code', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'erp-exitcode-'));
    const probe = path.join(dir, 'probe.ts');
    await writeFile(probe, script, 'utf8');

    const tsx = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
    const child = spawn(tsx, [probe], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('exit-code probe child did not finish within 120 s'));
      }, 120_000);
      child.on('error', reject);
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });

    expect(
      code,
      `the child should have exited 6; it exited ${code}${stderr ? `\n--- child stderr ---\n${stderr.slice(0, 2000)}` : ''}`,
    ).toBe(6);
  }, 180_000);
});
