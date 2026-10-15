import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      // Mirror apps/staff: typecheck/tests run against the contracts TypeScript source,
      // so the package does not depend on a prior `pnpm --dir packages/contracts run build`.
      { find: '@erp/contracts', replacement: fileURLToPath(new URL('../contracts/src/index.ts', import.meta.url)) },
    ],
  },
  test: {
    // Browser-shaped globals (window, navigator, localStorage) for the offline queue and
    // sync engine; IndexedDB itself comes from fake-indexeddb via the setup file.
    environment: 'happy-dom',
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.spec.ts'],
  },
});
