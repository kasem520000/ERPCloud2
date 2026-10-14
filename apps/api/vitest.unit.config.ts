import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const packageSource = (dir: string, entry: string): string =>
  fileURLToPath(new URL(`../../packages/${dir}/src/${entry}.ts`, import.meta.url));

/** Unit specs that do not need the embedded PostgreSQL global setup. */
export default defineConfig({
  resolve: {
    alias: [
      { find: '@erp/config', replacement: packageSource('config', 'index') },
      { find: '@erp/contracts', replacement: packageSource('contracts', 'index') },
      { find: '@erp/database', replacement: packageSource('database', 'index') },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    testTimeout: 30_000,
  },
});
