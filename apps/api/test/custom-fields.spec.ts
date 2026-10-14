import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_PLATFORM_PERMISSIONS, ALL_TENANT_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

describe('PHASE_05 custom fields and safe report builder', () => {
  let ctx: TestApp;
  let owner: Actor;
  let viewer: Actor;
  let otherTenant: Actor;
  let partyId = '';
  let warrantyFieldId = '';
  let warrantySelectId = '';

  const request = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, options: { token?: string; body?: Record<string, unknown> } = {}) =>
    api(ctx.server, method, `/api/v1${path}`, { token: options.token ?? owner.token, body: options.body });
  const data = (body: Record<string, unknown>) => body.data ?? body;
  const list = (body: Record<string, unknown>) => (Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : []) as Array<Record<string, unknown>>;

  beforeAll(async () => {
    ctx = await createTestApp('custom-fields');
    const permissions = [
      ...ALL_PLATFORM_PERMISSIONS,
      ...ALL_TENANT_PERMISSIONS,
      'parties.view', 'parties.manage', 'custom_fields.view', 'custom_fields.manage',
      'custom_reports.view', 'custom_reports.manage',
    ];
    owner = await createActor(ctx, { tenantCode: 'custom-fields', email: 'owner@custom-fields.test', permissions });
    viewer = await createActor(ctx, { tenantId: owner.tenantId, tenantCode: 'custom-fields', email: 'viewer@custom-fields.test', permissions: [...ALL_PLATFORM_PERMISSIONS, ...ALL_TENANT_PERMISSIONS, 'custom_fields.view', 'custom_reports.view'] });
    otherTenant = await createActor(ctx, { tenantCode: 'custom-fields-other', email: 'owner@custom-fields-other.test', permissions });
    const party = await request('post', '/parties', { body: { kind: 'customer', name: 'Custom field customer' } });
    partyId = String((data(party.body as Record<string, unknown>) as Record<string, unknown>).id ?? '');
  }, 240_000);

  afterAll(async () => ctx?.close());

  it('creates a text field with a tenant/entity unique key', async () => {
    const response = await request('post', '/custom-fields', { body: { entity: 'party', key: 'customer_segment', label: 'شريحة العميل', type: 'text' } });
    expect(response.status).toBe(201);
    expect((data(response.body as Record<string, unknown>) as Record<string, unknown>).type).toBe('text');
  });

  it('lists only active fields for the requested entity', async () => {
    const response = await request('get', '/custom-fields?entity=party');
    expect(response.status).toBe(200);
    expect(list(response.body as Record<string, unknown>).every((field) => field.entity === 'party')).toBe(true);
  });

  it('returns a conflict for a duplicate tenant/entity key', async () => {
    const response = await request('post', '/custom-fields', { body: { entity: 'party', key: 'customer_segment', label: 'Duplicate', type: 'text' } });
    expect(response.status, JSON.stringify(response.body)).toBe(409);
  });

  it('rejects an unsupported type and malformed key', async () => {
    const response = await request('post', '/custom-fields', { body: { entity: 'party', key: 'Bad Key', label: 'Bad', type: 'currency' } });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('requires unique options for select fields', async () => {
    const bad = await request('post', '/custom-fields', { body: { entity: 'party', key: 'status_choice', label: 'الحالة', type: 'select', options: ['new', 'new'] } });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const good = await request('post', '/custom-fields', { body: { entity: 'party', key: 'customer_status', label: 'حالة العميل', type: 'select', options: ['new', 'vip'] } });
    warrantySelectId = String((data(good.body as Record<string, unknown>) as Record<string, unknown>).id ?? '');
    expect(good.status).toBe(201);
    expect(warrantySelectId).toHaveLength(36);
  });

  it('creates a required date field for warranty dates', async () => {
    const response = await request('post', '/custom-fields', { body: { entity: 'party', key: 'warranty_date', label: 'تاريخ الضمان', type: 'date', required: true } });
    warrantyFieldId = String((data(response.body as Record<string, unknown>) as Record<string, unknown>).id ?? '');
    expect(response.status).toBe(201);
    expect(warrantyFieldId).toHaveLength(36);
  });

  it('rejects saving a required value when it is missing', async () => {
    const response = await request('put', '/custom-fields/values', { body: { entity: 'party', entityId: partyId, values: { customer_segment: 'retail' } } });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('saves and reads a valid date value', async () => {
    const response = await request('put', '/custom-fields/values', { body: { entity: 'party', entityId: partyId, values: { customer_segment: 'retail', customer_status: 'vip', warranty_date: '2026-09-27' } } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const values = await request('get', `/custom-fields/values?entity=party&entity_id=${partyId}`);
    expect(values.status).toBe(200);
    expect(list(values.body as Record<string, unknown>).find((field) => field.key === 'warranty_date')?.value).toBe('2026-09-27');
  });

  it('rejects invalid dates and select options using strict type validation', async () => {
    const date = await request('put', `/custom-fields/${warrantyFieldId}/values`, { body: { entity: 'party', entityId: partyId, value: '27/09/2026' } });
    const option = await request('put', `/custom-fields/${warrantySelectId}/values`, { body: { entity: 'party', entityId: partyId, value: 'not-configured' } });
    expect(date.status).toBeGreaterThanOrEqual(400);
    expect(option.status).toBeGreaterThanOrEqual(400);
  });

  it('enforces the view/manage permissions separately', async () => {
    const deniedWrite = await request('post', '/custom-fields', { token: viewer.token, body: { entity: 'party', key: 'viewer_cannot_write', label: 'No', type: 'text' } });
    const allowedRead = await request('get', '/custom-fields?entity=party', { token: viewer.token });
    expect(deniedWrite.status).toBe(403);
    expect(allowedRead.status).toBe(200);
  });

  it('isolates definitions and values between tenants', async () => {
    const stranger = await request('get', '/custom-fields?entity=party', { token: otherTenant.token });
    const strangerValues = await request('get', `/custom-fields/values?entity=party&entity_id=${partyId}`, { token: otherTenant.token });
    expect(stranger.status).toBe(200);
    expect(list(stranger.body as Record<string, unknown>).some((field) => field.key === 'warranty_date')).toBe(false);
    expect(strangerValues.status).toBe(200);
    expect(list(strangerValues.body as Record<string, unknown>).length).toBe(0);
  });

  it('creates and runs a report using a whitelisted custom column', async () => {
    const created = await request('post', '/custom-reports', { body: { name: 'Customers by warranty', baseEntity: 'party', columns: [{ source: 'native', key: 'name' }, { source: 'custom', key: 'warranty_date', agg: 'count' }], filters: [{ source: 'custom', key: 'warranty_date', op: 'eq', value: '2026-09-27' }], chartType: 'bar', isPublic: false } });
    expect(created.status).toBe(201);
    const reportId = String((data(created.body as Record<string, unknown>) as Record<string, unknown>).id);
    const run = await request('post', `/custom-reports/${reportId}/run`);
    expect(run.status).toBe(201);
    expect((data(run.body as Record<string, unknown>) as Record<string, unknown>).chart).toBeTruthy();
  });

  it('rejects SQL-like columns and returns CSV and printable PDF exports', async () => {
    const injection = await request('post', '/custom-reports', { body: { name: 'Unsafe', baseEntity: 'party', columns: [{ key: 'name; DROP TABLE parties;' }], filters: [] } });
    expect(injection.status).toBeGreaterThanOrEqual(400);
    const reports = await request('get', '/custom-reports');
    const report = list(reports.body as Record<string, unknown>)[0];
    if (!report) throw new Error('report setup did not create a report');
    const csv = await request('post', `/custom-reports/${String(report.id)}/export`, { body: { format: 'csv' } });
    const pdf = await request('post', `/custom-reports/${String(report.id)}/export`, { body: { format: 'pdf' } });
    expect(csv.status).toBe(201);
    expect(pdf.status).toBe(201);
    expect((data(csv.body as Record<string, unknown>) as Record<string, unknown>).format).toBe('csv');
    expect((data(pdf.body as Record<string, unknown>) as Record<string, unknown>).printable).toBe(true);
  });
});
