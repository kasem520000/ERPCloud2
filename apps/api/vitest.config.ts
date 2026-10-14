import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Tests resolve the workspace packages to their TypeScript **source**, so a spec exercises
 * the code as written and no build step is needed before `pnpm test`. Production resolves
 * the same specifiers to `dist/` through each package's `exports` map.
 *
 * The more specific specifiers are listed first because Vite replaces aliases by prefix:
 * `@erp/testing` would otherwise swallow `@erp/testing/database`.
 */
const packageSource = (dir: string, entry: string): string =>
  fileURLToPath(new URL(`../../packages/${dir}/src/${entry}.ts`, import.meta.url));

const aliases = [
  { find: '@erp/testing/database', replacement: packageSource('testing', 'test-database') },
  { find: '@erp/testing/isolation', replacement: packageSource('testing', 'isolation-suite') },
  { find: '@erp/testing/factories', replacement: packageSource('testing', 'factories') },
  { find: '@erp/testing', replacement: packageSource('testing', 'index') },
  { find: '@erp/config', replacement: packageSource('config', 'index') },
  { find: '@erp/contracts', replacement: packageSource('contracts', 'index') },
  { find: '@erp/database', replacement: packageSource('database', 'index') },
];

/**
 * Vitest configuration for `apps/api`.
 *
 * - `unplugin-swc` replaces esbuild so that `emitDecoratorMetadata` works; NestJS
 *   constructor injection depends on the emitted `design:paramtypes`.
 * - A throwaway RS256 key pair is generated here and injected through `test.env` so the
 *   application code only ever reads keys from `@erp/config` (SECURITY_ARCHITECTURE §9).
 * - `singleFork` + `isolate: false` keeps every spec in one child process, which lets the
 *   PostgreSQL started by `test/global-setup.ts` be shared by the whole run.
 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

export default defineConfig({
  resolve: { alias: aliases },
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
      },
    }),
  ],
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    setupFiles: ['./test/setup.ts'],
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true, isolate: false } },
    env: {
      NODE_ENV: 'test',
      JWT_PRIVATE_KEY: privateKey,
      JWT_PUBLIC_KEY: publicKey,
      JWT_KEY_ID: 'test-key-1',
    },
  },
});
