/**
 * Test-environment shims for the offline queue and sync engine.
 *
 * `happy-dom` provides `window`, `navigator` and `localStorage`, but not `indexedDB`;
 * `fake-indexeddb/auto` installs it on `globalThis`. The offline adapter checks
 * `'indexedDB' in window` — make sure the two line up whichever way the test runner
 * wires its globals.
 */
import 'fake-indexeddb/auto';

if (typeof window !== 'undefined' && !('indexedDB' in window)) {
  Object.defineProperty(window, 'indexedDB', {
    value: indexedDB,
    configurable: true,
    writable: true,
  });
}
