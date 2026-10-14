import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SETTINGS_UPDATED_NOTIFICATION } from '@erp/contracts';

import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Notifications — API_CONTRACT §2, PHASE_04 §5.4, including the demo subscription
 * ("settings updated → notification") that wires the domain-event emitter to the inbox
 * and to the transactional outbox.
 */
describe('notifications (PHASE_04 §5.4)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let colleague: Actor;
  let other: Actor;

  beforeAll(async () => {
    ctx = await createTestApp('notifications');
    admin = await createActor(ctx, {
      tenantCode: 'notif-a',
      email: 'owner@notif-a.test',
      permissions: ALL_PLATFORM_PERMISSIONS,
    });
    colleague = await createActor(ctx, {
      tenantCode: 'notif-a',
      email: 'colleague@notif-a.test',
      permissions: ALL_PLATFORM_PERMISSIONS,
      isOwner: false,
    });
    other = await createActor(ctx, {
      tenantCode: 'notif-b',
      email: 'owner@notif-b.test',
      permissions: ALL_PLATFORM_PERMISSIONS,
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('creates a notification and an outbox e-mail job when a setting changes', async () => {
    const updated = await api(ctx.server, 'put', '/api/v1/settings/branding.primary_color', {
      token: admin.token,
      body: { value: '#123456' },
    });
    expect(updated.status).toBe(200);

    const inbox = await api(ctx.server, 'get', '/api/v1/notifications', { token: admin.token });
    expect(inbox.status).toBe(200);
    const rows = inbox.body.data as Array<{ type: string; payload: Record<string, unknown>; readAt: string | null }>;
    const notification = rows.find((row) => row.type === SETTINGS_UPDATED_NOTIFICATION);
    expect(notification).toBeDefined();
    expect(notification?.payload.key).toBe('branding.primary_color');
    expect(notification?.readAt).toBeNull();
    expect((inbox.body.meta as { unread: number }).unread).toBeGreaterThan(0);

    // The same transaction queued the e-mail; nothing was sent inline.
    const outbox = await api(ctx.server, 'get', '/api/v1/jobs/outbox?filter[queue]=notifications', {
      token: admin.token,
    });
    // The outbox DTO exposes routing and lifecycle, not the payload — a job payload can
    // be large and is not meant for an admin list view.
    const jobs = outbox.body.data as Array<{ type: string; status: string; attempts: number }>;
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs[0]?.type).toBe('notification.email');
    expect(jobs[0]?.status).toBe('pending');
  });

  it('marks a notification read idempotently and updates the unread counter', async () => {
    const inbox = await api(ctx.server, 'get', '/api/v1/notifications', { token: admin.token });
    const first = (inbox.body.data as Array<{ id: string }>)[0]!;

    const read = await api(ctx.server, 'post', `/api/v1/notifications/${first.id}/read`, {
      token: admin.token,
    });
    expect(read.status).toBe(201);
    const readAt = (read.body.data as { readAt: string }).readAt;
    expect(readAt).toBeTypeOf('string');

    const again = await api(ctx.server, 'post', `/api/v1/notifications/${first.id}/read`, {
      token: admin.token,
    });
    expect(again.status).toBe(201);
    // Idempotent: the first timestamp is preserved rather than overwritten.
    expect((again.body.data as { readAt: string }).readAt).toBe(readAt);

    const unreadOnly = await api(ctx.server, 'get', '/api/v1/notifications?filter[read]=false', {
      token: admin.token,
    });
    const ids = (unreadOnly.body.data as Array<{ id: string }>).map((row) => row.id);
    expect(ids).not.toContain(first.id);
  });

  it('addresses a notification to a membership, not to a user', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/notifications', {
      token: admin.token,
      body: {
        membershipId: colleague.membershipId,
        type: 'demo.ping',
        payload: { hello: 'world' },
      },
    });
    expect(created.status).toBe(201);
    const id = (created.body.data as { id: string }).id;

    const colleagueInbox = await api(ctx.server, 'get', '/api/v1/notifications', {
      token: colleague.token,
    });
    expect((colleagueInbox.body.data as Array<{ id: string }>).map((row) => row.id)).toContain(id);

    // Same tenant, different membership: the author cannot see it in their own inbox.
    const adminInbox = await api(ctx.server, 'get', '/api/v1/notifications?limit=100', {
      token: admin.token,
    });
    expect((adminInbox.body.data as Array<{ id: string }>).map((row) => row.id)).not.toContain(id);

    // Reading it by id from another membership is a 404, not a 403.
    expect((await api(ctx.server, 'get', `/api/v1/notifications/${id}`, { token: admin.token })).status).toBe(
      404,
    );
  });

  it('refuses a membership that does not belong to this tenant', async () => {
    const response = await api(ctx.server, 'post', '/api/v1/notifications', {
      token: admin.token,
      body: { membershipId: other.membershipId, type: 'demo.ping' },
    });
    expect(response.status).toBe(422);
  });

  it('keeps inboxes tenant-scoped', async () => {
    const inbox = await api(ctx.server, 'get', '/api/v1/notifications?limit=100', { token: other.token });
    expect(inbox.status).toBe(200);
    const types = (inbox.body.data as Array<{ type: string }>).map((row) => row.type);
    expect(types).not.toContain(SETTINGS_UPDATED_NOTIFICATION);
  });
});
