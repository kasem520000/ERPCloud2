import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      // Mirror apps/staff + packages/web-core: tests run against the contracts TypeScript
      // source, so the app does not depend on a prior contracts build.
      { find: '@erp/contracts', replacement: fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)) },
    ],
  },
  test: {
    // Browser-shaped globals (window, navigator, localStorage) for the offline stores and
    // the sync engine; IndexedDB itself comes from fake-indexeddb via the setup file —
    // the same arrangement as `packages/web-core` (M2).
    environment: 'happy-dom',
    setupFiles: ['tests/setup.ts'],
    include: ['lib/**/*.spec.ts', 'tests/**/*.spec.ts'],
  },
});
