import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IdempotencyStore, hashRequestPayload } from '../src/modules/platform-services/index.js';

import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Idempotency — API_CONTRACT §0, PHASE_04 §5.7 ("replace the in-memory interceptor with
 * `idempotency_keys` storage; 24 h expiry; byte-identical replay; conflict on same key +
 * different payload").
 */
describe('idempotent POST replay (PHASE_04 §5.7)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let other: Actor;

  beforeAll(async () => {
    ctx = await createTestApp('idempotency');
    admin = await createActor(ctx, {
      tenantCode: 'idem-a',
      email: 'owner@idem-a.test',
      permissions: ALL_PLATFORM_PERMISSIONS,
    });
    other = await createActor(ctx, {
      tenantCode: 'idem-b',
      email: 'owner@idem-b.test',
      permissions: ALL_PLATFORM_PERMISSIONS,
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  const roleBody = (name: string) => ({ name, description: 'created once', permissionCodes: [] });

  it('replays the stored response byte for byte and runs the handler once', async () => {
    const key = 'replay-key-1';
    const first = await api(ctx.server, 'post', '/api/v1/roles', {
      token: admin.token,
      headers: { 'Idempotency-Key': key },
      body: roleBody('Warehouse'),
    });
    expect(first.status).toBe(201);
    expect(first.headers['idempotency-replayed']).toBeUndefined();

    const second = await api(ctx.server, 'post', '/api/v1/roles', {
      token: admin.token,
      headers: { 'Idempotency-Key': key },
      body: roleBody('Warehouse'),
    });
    expect(second.status).toBe(201);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(JSON.stringify(second.body)).toBe(JSON.stringify(first.body));

    // The side effect happened exactly once.
    const roles = await api(ctx.server, 'get', '/api/v1/roles?limit=100', { token: admin.token });
    const named = (roles.body.data as Array<{ name: string }>).filter((row) => row.name === 'Warehouse');
    expect(named.length).toBe(1);
  });

  it('rejects the same key with a different payload', async () => {
    const key = 'replay-key-2';
    const first = await api(ctx.server, 'post', '/api/v1/roles', {
      token: admin.token,
      headers: { 'Idempotency-Key': key },
      body: roleBody('Cashier'),
    });
    expect(first.status).toBe(201);

    const conflicting = await api(ctx.server, 'post', '/api/v1/roles', {
      token: admin.token,
      headers: { 'Idempotency-Key': key },
      body: roleBody('Cashier-2'),
    });
    expect(conflicting.status).toBe(409);
    expect(conflicting.body.code).toBe('IDEMPOTENCY_REPLAY');
  });

  it('scopes keys per tenant', async () => {
    const key = 'shared-key';
    const mine = await api(ctx.server, 'post', '/api/v1/roles', {
      token: admin.token,
      headers: { 'Idempotency-Key': key },
      body: roleBody('Shared'),
    });
    expect(mine.status).toBe(201);

    // Same key, other tenant, different payload — must not collide or replay.
    const theirs = await api(ctx.server, 'post', '/api/v1/roles', {
      token: other.token,
      headers: { 'Idempotency-Key': key },
      body: roleBody('Their Own Role'),
    });
    expect(theirs.status).toBe(201);
    expect(theirs.headers['idempotency-replayed']).toBeUndefined();
    expect((theirs.body.data as { id: string }).id).not.toBe((mine.body.data as { id: string }).id);
  });

  it('frees the key when the handler failed, so the client can retry', async () => {
    const key = 'retry-after-failure';
    const rejected = await api(ctx.server, 'post', '/api/v1/roles', {
      token: admin.token,
      headers: { 'Idempotency-Key': key },
      body: { name: '', description: 'invalid' },
    });
    expect(rejected.status).toBe(400);

    const retried = await api(ctx.server, 'post', '/api/v1/roles', {
      token: admin.token,
      headers: { 'Idempotency-Key': key },
      body: { name: '', description: 'invalid' },
    });
    // Still a validation error, not a poisoned key.
    expect(retried.status).toBe(400);
    expect(retried.body.code).toBe('VALIDATION_FAILED');
  });

  it('ignores the header on reads and passes through without a tenant context', async () => {
    const read = await api(ctx.server, 'get', '/api/v1/roles', {
      token: admin.token,
      headers: { 'Idempotency-Key': 'not-used-on-get' },
    });
    expect(read.status).toBe(200);
    expect(read.headers['idempotency-replayed']).toBeUndefined();

    const anonymous = await api(ctx.server, 'post', '/api/v1/auth/login', {
      headers: { 'Idempotency-Key': 'anonymous-key' },
      body: { email: 'nobody@idem-a.test', password: 'wrong-password-1234' },
    });
    expect([400, 401]).toContain(anonymous.status);
  });

  it('hashes endpoint and payload together and purges expired rows', async () => {
    expect(hashRequestPayload('POST /roles', { a: 1 })).toBe(hashRequestPayload('POST /roles', { a: 1 }));
    expect(hashRequestPayload('POST /roles', { a: 1 })).not.toBe(
      hashRequestPayload('PUT /roles', { a: 1 }),
    );
    expect(hashRequestPayload('POST /roles', { a: 1 })).not.toBe(
      hashRequestPayload('POST /roles', { a: 2 }),
    );

    const store = ctx.app.get(IdempotencyStore);
    // Nothing has expired yet…
    expect(await store.purgeExpired()).toBe(0);
    // …but everything is expired relative to a point far in the future.
    const purged = await store.purgeExpired(new Date(Date.now() + 72 * 3_600_000));
    expect(purged).toBeGreaterThan(0);

    // After the sweep the key is free again and the handler runs anew.
    const reused = await api(ctx.server, 'post', '/api/v1/roles', {
      token: admin.token,
      headers: { 'Idempotency-Key': 'replay-key-1' },
      body: { name: 'Warehouse Two', description: 'after gc', permissionCodes: [] },
    });
    expect(reused.status).toBe(201);
    expect(reused.headers['idempotency-replayed']).toBeUndefined();
  });
});
