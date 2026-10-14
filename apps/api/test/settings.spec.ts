import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantSettingsRegistry } from '@erp/config';

import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/** Typed tenant settings — MULTI_TENANCY §5, API_CONTRACT §2. */

describe('tenant settings', () => {
  let ctx: TestApp;
  let admin: Actor;
  let outsider: Actor;

  beforeAll(async () => {
    ctx = await createTestApp('settings');
    admin = await createActor(ctx, {
      tenantCode: 'settings',
      email: 'admin@settings.test',
      permissions: ALL_PLATFORM_PERMISSIONS,
    });
    outsider = await createActor(ctx, {
      tenantCode: 'settings',
      email: 'outsider@settings.test',
      permissions: ['platform.tenant.view'],
      roleNames: ['Viewer'],
      isOwner: false,
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('returns registry defaults plus the key registry on GET /settings', async () => {
    const response = await api(ctx.server, 'get', '/api/v1/settings', { token: admin.token });
    expect(response.status).toBe(200);

    const data = response.body.data as {
      settings: Record<string, unknown>;
      registry: Array<{ key: string; module: string }>;
    };
    expect(data.registry).toHaveLength(tenantSettingsRegistry.length);
    expect(data.settings['money.rounding_digits']).toBe(2);
    expect(data.settings['invoice.number_prefix']).toBe('INV-');
    expect(data.settings['feature.pos']).toBe(false);
  });

  it('writes a typed setting and reflects it on the next read', async () => {
    const put = await api(ctx.server, 'put', '/api/v1/settings/money.rounding_digits', {
      token: admin.token,
      body: { value: 4 },
    });
    expect(put.status).toBe(200);
    expect(put.body.data).toEqual({ key: 'money.rounding_digits', value: 4 });

    const read = await api(ctx.server, 'get', '/api/v1/settings', { token: admin.token });
    expect((read.body.data as { settings: Record<string, unknown> }).settings['money.rounding_digits']).toBe(
      4,
    );

    const tenant = await api(ctx.server, 'get', '/api/v1/tenant', { token: admin.token });
    expect(
      (tenant.body.data as { settings: Record<string, unknown> }).settings['money.rounding_digits'],
    ).toBe(4);
  });

  it('rejects a value that fails the declared schema', async () => {
    const wrongType = await api(ctx.server, 'put', '/api/v1/settings/feature.pos', {
      token: admin.token,
      body: { value: 'yes' },
    });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.code).toBe('VALIDATION_FAILED');

    const outOfRange = await api(ctx.server, 'put', '/api/v1/settings/money.rounding_digits', {
      token: admin.token,
      body: { value: 99 },
    });
    expect(outOfRange.status).toBe(400);

    const badColour = await api(ctx.server, 'put', '/api/v1/settings/branding.primary_color', {
      token: admin.token,
      body: { value: 'blue' },
    });
    expect(badColour.status).toBe(400);
  });

  // CR-004: PHASE_02 answered 404 here; PHASE_04 §5.8 requires 400 VALIDATION_FAILED,
  // because the unknown key is a value inside the request, not a missing resource.
  it('rejects a key that is not in the registry', async () => {
    const response = await api(ctx.server, 'put', '/api/v1/settings/nope.nope', {
      token: admin.token,
      body: { value: 1 },
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  it('updates settings in bulk through PATCH /tenant', async () => {
    const response = await api(ctx.server, 'patch', '/api/v1/tenant', {
      token: admin.token,
      body: {
        timezone: 'Africa/Cairo',
        settings: { 'invoice.number_prefix': 'SLS-', 'pricing.price_includes_vat': true },
      },
    });
    expect(response.status).toBe(200);

    const data = response.body.data as { timezone: string; settings: Record<string, unknown> };
    expect(data.timezone).toBe('Africa/Cairo');
    expect(data.settings['invoice.number_prefix']).toBe('SLS-');
    expect(data.settings['pricing.price_includes_vat']).toBe(true);
  });

  it('rejects an unknown key inside a bulk PATCH', async () => {
    const response = await api(ctx.server, 'patch', '/api/v1/tenant', {
      token: admin.token,
      body: { settings: { 'not.a.key': 1 } },
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(String(response.body.detail)).toContain('not.a.key');
  });

  it('requires tenant.settings.manage', async () => {
    const read = await api(ctx.server, 'get', '/api/v1/settings', { token: outsider.token });
    expect(read.status).toBe(403);
    expect(read.body.detail).toBe('permission tenant.settings.manage required');

    const write = await api(ctx.server, 'put', '/api/v1/settings/invoice.padding', {
      token: outsider.token,
      body: { value: 8 },
    });
    expect(write.status).toBe(403);
  });
});
