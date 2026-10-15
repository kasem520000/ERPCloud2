/**
 * `@erp/web-core` — shared web runtime for every ERPCloud frontend (M2).
 *
 * Surface map (each importable as `@erp/web-core/<name>`):
 * - `api`          — API client: bearer token, transparent refresh on 401, problem+json errors
 * - `session`      — React session provider on top of the api client
 * - `offline-db`   — native IndexedDB adapter for the offline till queue + catalog
 * - `sync-engine`  — replay engine for the offline queue (online-only, idempotent by offlineId)
 * - `i18n`         — bilingual (ar/en) + RTL/LTR language provider factory
 * - `surface-routing` — AUD-13 whole-segment prefix matching
 */
export * from './api';
export * from './offline-db';
export * from './surface-routing';
export * from './sync-engine';
