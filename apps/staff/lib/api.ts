/**
 * M2 — the API client moved to `@erp/web-core/api` (shared by every frontend).
 * This shim keeps every existing `@/lib/api` / `./api` import working unchanged,
 * and re-exporting means a single module instance: `instanceof ApiError` and the
 * in-memory session stay consistent across the app.
 */
export * from '@erp/web-core/api';
