import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Marina operations: preparation, rota, invoice linking and the day close.
 *
 * The invariant worth a database: a closed harbour day is frozen. Everything else here
 * exists to prove the day close actually holds — a booking dated into a closed day must
 * be refused, not silently accepted and then missing from yesterday's totals.
 */
describe('marina operations', () => {
  let ctx: TestApp;
  let actor: Actor;
  let branchId = '';
  let partyId = '';
  let vesselId = '';
  const day = '2026-07-01';

  beforeAll(async () => {
    ctx = await createTestApp('marina-operations');
    actor = await createActor(ctx, {
      tenantCode: 'marina-ops',
      email: 'owner@marina-ops.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'marina.view',
        'marina.manage',
        'marina.invoice',
        'parties.view',
        'parties.manage',
        'sales.view',
        'sales.invoice.create',
      ],
    });

    const branch = await api(ctx.server, 'post', '/api/v1/branches', { token: actor.token, body: { code: 'MAIN', nameAr: 'المرسى' } });
    branchId = ((branch.body.data ?? branch.body) as { id: string }).id;
    const party = await api(ctx.server, 'post', '/api/v1/parties', { token: actor.token, body: { kind: 'customer', name: 'عميل المرسى' } });
    partyId = ((party.body.data ?? party.body) as { id: string }).id;

    const group = await api(ctx.server, 'post', '/api/v1/marina/groups', { token: actor.token, body: { name: 'قوارب سريعة', code: 'FAST' } });
    const groupId = ((group.body.data ?? group.body) as { id: string }).id;
    await api(ctx.server, 'post', `/api/v1/marina/groups/${groupId}/pricing`, { token: actor.token, body: { periodKind: 'hour', price: '200' } });
    const vessel = await api(ctx.server, 'post', '/api/v1/marina/vessels', { token: actor.token, body: { groupId, code: 'V-1', name: 'الأمل', capacity: 6 } });
    vesselId = ((vessel.body.data ?? vessel.body) as { id: string }).id;
  }, 240_000);

  afterAll(async () => ctx.close());

  const book = (startsAt: string, endsAt: string, companions = 0) =>
    api(ctx.server, 'post', '/api/v1/marina/bookings', {
      token: actor.token,
      body: { branchId, partyId, vesselId, startsAt, endsAt, companions, insuranceAmount: '100' },
    });

  it('prepares a booking once and refuses fewer life jackets than companions', async () => {
    const booking = await book(`${day}T08:00:00.000Z`, `${day}T10:00:00.000Z`, 3);
    const bookingId = ((booking.body.data ?? booking.body) as { id: string }).id;

    const short = await api(ctx.server, 'post', `/api/v1/marina/bookings/${bookingId}/preparation`, { token: actor.token, body: { lifeJackets: 2 } });
    expect(short.status).toBe(422);
    expect(short.body.code).toBe('MARINA_JACKETS_INSUFFICIENT');

    const prepared = await api(ctx.server, 'post', `/api/v1/marina/bookings/${bookingId}/preparation`, {
      token: actor.token,
      body: { lifeJackets: 4, fuelLevel: 'full' },
    });
    expect(prepared.status).toBe(201);
    const preparationId = ((prepared.body.data ?? prepared.body) as { id: string; status: string }).id;

    const again = await api(ctx.server, 'post', `/api/v1/marina/bookings/${bookingId}/preparation`, { token: actor.token, body: { lifeJackets: 4 } });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('MARINA_ALREADY_PREPARED');

    const returned = await api(ctx.server, 'post', `/api/v1/marina/preparations/${preparationId}/return`, { token: actor.token, body: {} });
    expect(returned.status).toBe(201);
    expect((returned.body.data ?? returned.body).status).toBe('returned');

    const twice = await api(ctx.server, 'post', `/api/v1/marina/preparations/${preparationId}/return`, { token: actor.token, body: {} });
    expect(twice.status).toBe(409);
  });

  it('reads back a rota with its lines', async () => {
    await api(ctx.server, 'post', '/api/v1/marina/operation-plans', {
      token: actor.token,
      body: { planDate: day, name: 'دور اليوم', lines: [{ vesselId, periodLabel: 'الفترة الصباحية' }] },
    });
    const plans = await api(ctx.server, 'get', `/api/v1/marina/operation-plans?date=${day}`, { token: actor.token });
    const rows = (plans.body.data ?? plans.body) as Array<{ name: string; lines: Array<{ periodLabel: string }> }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lines[0]?.periodLabel).toBe('الفترة الصباحية');

    const other = await api(ctx.server, 'get', '/api/v1/marina/operation-plans?date=2020-01-01', { token: actor.token });
    expect((other.body.data ?? other.body) as unknown[]).toHaveLength(0);
  });

  it('freezes the day once it is closed', async () => {
    const uninvoiced = await api(ctx.server, 'get', '/api/v1/marina/bookings/uninvoiced', { token: actor.token });
    const pending = (uninvoiced.body.data ?? uninvoiced.body) as Array<{ id: string }>;
    expect(pending.length).toBeGreaterThan(0);

    const linked = await api(ctx.server, 'post', '/api/v1/marina/rental-invoices/link', { token: actor.token, body: { bookingIds: pending.map((row) => row.id) } });
    expect(linked.status).toBe(201);
    expect((linked.body.data ?? linked.body).failed).toHaveLength(0);

    // Linking the same booking again fails per booking instead of blowing up the request.
    const relink = await api(ctx.server, 'post', '/api/v1/marina/rental-invoices/link', { token: actor.token, body: { bookingIds: [pending[0]?.id] } });
    expect(relink.status).toBe(201);
    expect((relink.body.data ?? relink.body).failed).toHaveLength(1);

    const summary = await api(ctx.server, 'get', `/api/v1/marina/day-close?branch_id=${branchId}&date=${day}`, { token: actor.token });
    const totals = (summary.body.data ?? summary.body) as { bookingsCount: number; rentalsCount: number; closed: boolean; rentalsTotal: string };
    expect(totals.closed).toBe(false);
    expect(totals.bookingsCount).toBeGreaterThan(0);
    expect(Number(totals.rentalsTotal)).toBeGreaterThan(0);

    const emptyDay = await api(ctx.server, 'post', '/api/v1/marina/day-close', { token: actor.token, body: { branchId, closeDate: '2020-05-05' } });
    expect(emptyDay.status).toBe(422);
    expect(emptyDay.body.code).toBe('MARINA_DAY_EMPTY');

    const closed = await api(ctx.server, 'post', '/api/v1/marina/day-close', { token: actor.token, body: { branchId, closeDate: day } });
    expect(closed.status).toBe(201);

    const twice = await api(ctx.server, 'post', '/api/v1/marina/day-close', { token: actor.token, body: { branchId, closeDate: day } });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('MARINA_DAY_ALREADY_CLOSED');

    const late = await book(`${day}T12:00:00.000Z`, `${day}T13:00:00.000Z`);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('MARINA_DAY_CLOSED');

    const openDay = await book('2026-07-02T08:00:00.000Z', '2026-07-02T09:00:00.000Z');
    expect(openDay.status).toBe(201);

    const guarded = await api(ctx.server, 'post', '/api/v1/marina/day-close', { token: actor.token, body: { branchId, closeDate: '2026-07-02' } });
    expect(guarded.status).toBe(422);
    expect(guarded.body.code).toBe('MARINA_DAY_UNINVOICED');

    const forced = await api(ctx.server, 'post', '/api/v1/marina/day-close', { token: actor.token, body: { branchId, closeDate: '2026-07-02', force: true } });
    expect(forced.status).toBe(201);
  });
});
