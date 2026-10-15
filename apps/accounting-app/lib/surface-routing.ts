/**
 * M3 — the accounting app has no public surfaces: every route sits behind the session
 * gate. The AUD-13 whole-segment rule itself lives in `@erp/web-core/surface-routing`;
 * re-exported here so the (negative) invariant is pinned in this app's tests too.
 */
export { matchesPrefix } from '@erp/web-core/surface-routing';
