/**
 * `@erp/testing` — fixtures, factories and the tenant-isolation harness
 * (TARGET_ARCHITECTURE §3, TESTING_STRATEGY §1/§6).
 */
export const testingWorkspace = 'erp-saas';

export * from './test-database.js';
export * from './isolation-suite.js';
export * from './factories.js';
export * from './accounting-invariants.js';
