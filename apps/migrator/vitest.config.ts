import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const packageSource = (dir: string, entry: string): string =>
  fileURLToPath(new URL(`../../packages/${dir}/src/${entry}.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: '@erp/contracts', replacement: packageSource('contracts', 'index') },
      { find: '@erp/database', replacement: packageSource('database', 'index') },
    ],
  },
  test: { environment: 'node', include: ['src/**/*.spec.ts'] },
});
