import { describe, expect, it, vi } from 'vitest';

import { createPool } from './client.js';

/**
 * R-24 — an error on an *idle* pooled client (server-side termination `57P01`, a
 * postgres restart, a load balancer dropping an idle socket) is re-emitted by pg-pool
 * on the pool itself. Before `createPool` attached a listener, that was an unhandled
 * `'error'` event: it would crash a production API on a transient connection loss, and
 * it failed whole vitest runs ("Errors 1", exit 1) while every test had passed — the
 * test teardown race is `pool.end()` resolving before the sockets finish closing, then
 * `pg_terminate_backend` from the database drop killing the draining client. The pool
 * must log such events and keep serving.
 */
describe('createPool — idle client errors never become unhandled (R-24)', () => {
  it('emitting a pool error is logged, not thrown', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const pool = createPool('postgres://erp_api:x@127.0.0.1:5/pool_spec', 1);
      // No connection is ever opened: the contract under test is purely about the
      // 'error' listener the factory must attach.
      const fatal = Object.assign(new Error('terminating connection due to administrator shutdown'), {
        code: '57P01',
      });
      expect(() => pool.emit('error', fatal)).not.toThrow();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('57P01');
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('pool continues');
      pool.end().catch(() => undefined); // no clients were ever created; resolves immediately
    } finally {
      errorSpy.mockRestore();
    }
  });
});
