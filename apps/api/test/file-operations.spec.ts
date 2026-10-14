import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * File-level operations — backup, restore, rotation, invoice maintenance — and the report
 * designer.
 *
 * These are the features that can lose a company's data, so the tests are written around
 * what each one must *refuse* to do rather than around its happy path: a backup that never
 * carries identity or the audit trail, a restore that cannot overwrite or be pointed at
 * the wrong file, a rotation that deletes logs but never documents, a maintenance sweep
 * that repairs drafts and leaves posted invoices alone, and a designer that can only
 * rearrange columns the report already produces.
 */
describe('file operations and the report designer', () => {
  let ctx: TestApp;
  let actor: Actor;

  const body = (response: { body: Record<string, unknown> }) => (response.body.data ?? response.body) as Record<string, unknown>;
  const code = (response: { body: Record<string, unknown> }) => (response.body.code ?? (response.body as { error?: { code: string } }).error?.code) as string;

  beforeAll(async () => {
    ctx = await createTestApp('file-operations');
    actor = await createActor(ctx, {
      tenantCode: 'filesco',
      email: 'owner@filesco.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'accounting.account.view',
        'accounting.account.manage',
        'reporting.view',
        'reporting.layout.manage',
        'settings.backup.manage',
        'settings.restore.manage',
        'settings.rotation.manage',
        'settings.maintenance.manage',
        'settings.companyfile.create',
      ],
    });


    // A brand-new tenant has no data at all, and a backup of nothing proves nothing.
    // Two accounts (parent + child) are enough to exercise the copy path, foreign keys and
    // the row counts the assertions below depend on.
    const parent = await api(ctx.server, 'post', '/api/v1/accounts', {
      token: actor.token,
      body: { code: '1000', nameAr: 'الأصول', type: 'asset', isPostable: false },
    });
    expect(parent.status).toBeLessThan(300);
    const parentId = (body(parent) as { id: string }).id;
    const child = await api(ctx.server, 'post', '/api/v1/accounts', {
      token: actor.token,
      body: { code: '1101', nameAr: 'الصندوق', type: 'asset', parentId, isPostable: true },
    });
    expect(child.status).toBeLessThan(300);
  }, 240_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('backs up business data without carrying identity or the audit trail', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/settings/backups', { token: actor.token, body: { note: 'baseline' } });
    expect(created.status).toBeLessThan(300);
    const backup = body(created) as { id: string; tables: string[]; totalRows: number; checksum: string };

    expect(backup.checksum).toHaveLength(64);
    expect(backup.totalRows).toBeGreaterThan(0);
    expect(backup.tables).toContain('accounts');
    // Credentials, role grants and the audit log are never part of a tenant export.
    for (const forbidden of ['users', 'memberships', 'roles', 'role_permissions', 'audit_log', 'backup_runs']) {
      expect(backup.tables, forbidden).not.toContain(forbidden);
    }

    const listed = await api(ctx.server, 'get', '/api/v1/settings/backups', { token: actor.token });
    const rows = body(listed) as unknown as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    // The list is a catalogue, not a data dump: payloads only come from the download route.
    expect(rows[0]).not.toHaveProperty('payload');

    const downloaded = await api(ctx.server, 'get', `/api/v1/settings/backups/${backup.id}/download`, { token: actor.token });
    expect((body(downloaded) as { payload: Record<string, unknown[]> }).payload.accounts?.length).toBeGreaterThan(0);
  });

  it('restores additively and only into the file whose code was typed back', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/settings/backups', { token: actor.token, body: {} });
    const backupId = (body(created) as { id: string }).id;

    const dry = await api(ctx.server, 'post', '/api/v1/settings/restores', { token: actor.token, body: { backupId, mode: 'dry_run' } });
    expect(dry.status).toBeLessThan(300);
    expect((body(dry) as { mode: string }).mode).toBe('dry_run');
    expect((body(dry) as { insertedRows: number }).insertedRows).toBe(0);

    const unconfirmed = await api(ctx.server, 'post', '/api/v1/settings/restores', { token: actor.token, body: { backupId, mode: 'apply' } });
    expect(unconfirmed.status).toBe(422);
    expect(code(unconfirmed)).toBe('RESTORE_CONFIRMATION_REQUIRED');

    const wrongFile = await api(ctx.server, 'post', '/api/v1/settings/restores', {
      token: actor.token,
      body: { backupId, mode: 'apply', confirmTenantCode: 'some-other-file' },
    });
    expect(wrongFile.status).toBe(422);

    const accountsBefore = await api(ctx.server, 'get', '/api/v1/accounts', { token: actor.token });
    const applied = await api(ctx.server, 'post', '/api/v1/settings/restores', {
      token: actor.token,
      body: { backupId, mode: 'apply', confirmTenantCode: 'filesco' },
    });
    expect(applied.status).toBeLessThan(300);
    // Every row already exists, so an additive restore is a no-op rather than a duplicate.
    expect((body(applied) as { insertedRows: number }).insertedRows).toBe(0);

    const accountsAfter = await api(ctx.server, 'get', '/api/v1/accounts', { token: actor.token });
    expect((body(accountsAfter) as unknown as unknown[]).length).toBe((body(accountsBefore) as unknown as unknown[]).length);
  });

  it('rotates operational logs only, and never within the retention floor', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const tooRecent = await api(ctx.server, 'post', '/api/v1/settings/data-rotation', { token: actor.token, body: { cutoffDate: today, mode: 'preview' } });
    expect(tooRecent.status).toBe(422);
    expect(code(tooRecent)).toBe('ROTATION_CUTOFF_TOO_RECENT');

    const cutoff = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
    const preview = await api(ctx.server, 'post', '/api/v1/settings/data-rotation', { token: actor.token, body: { cutoffDate: cutoff, mode: 'preview' } });
    expect(preview.status).toBeLessThan(300);
    const findings = (body(preview) as { findings: { rotatable: Record<string, unknown>; preserved: Record<string, unknown>; retainedByDesign: Record<string, unknown> } }).findings;

    // Documents appear in the preview so the operator can see what is *not* being touched.
    expect(Object.keys(findings.preserved)).toContain('sales_invoices');
    expect(Object.keys(findings.preserved)).toContain('journal_entries');
    expect(Object.keys(findings.rotatable)).not.toContain('sales_invoices');
    expect(Object.keys(findings.retainedByDesign)).toContain('audit_log');

    const unconfirmed = await api(ctx.server, 'post', '/api/v1/settings/data-rotation', { token: actor.token, body: { cutoffDate: cutoff, mode: 'apply' } });
    expect(unconfirmed.status).toBe(422);
    expect(code(unconfirmed)).toBe('ROTATION_CONFIRMATION_REQUIRED');

    const applied = await api(ctx.server, 'post', '/api/v1/settings/data-rotation', { token: actor.token, body: { cutoffDate: cutoff, mode: 'apply', confirm: true } });
    expect(applied.status).toBeLessThan(300);
    expect(Object.keys((body(applied) as { applied: Record<string, number> }).applied)).not.toContain('audit_log');

    const runs = await api(ctx.server, 'get', '/api/v1/settings/maintenance-runs?kind=data_rotation', { token: actor.token });
    expect((body(runs) as unknown as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it('reports invoice inconsistencies and repairs drafts only', async () => {
    const scan = await api(ctx.server, 'post', '/api/v1/settings/invoice-maintenance', { token: actor.token, body: { mode: 'preview' } });
    expect(scan.status).toBeLessThan(300);
    const findings = (body(scan) as { findings: { counts: Record<string, number>; totalsMismatch: Array<{ repairable: boolean; status: string }> } }).findings;
    expect(findings.counts).toHaveProperty('postedWithoutJournal');
    // Whatever the data, the rule holds: only drafts are ever marked repairable.
    for (const row of findings.totalsMismatch) {
      expect(row.repairable).toBe(row.status === 'draft');
    }

    const applied = await api(ctx.server, 'post', '/api/v1/settings/invoice-maintenance', { token: actor.token, body: { mode: 'apply' } });
    expect(applied.status).toBeLessThan(300);
    expect(body(applied)).toHaveProperty('applied');
  });

  it('saves report layouts that can only rearrange columns the report already produces', async () => {
    const catalog = await api(ctx.server, 'get', '/api/v1/reports', { token: actor.token });
    const reports = catalog.body as unknown as Array<{ key: string; columns: Array<{ key: string; labelAr: string }> }>;
    const report = reports[0]!;

    const unknownColumn = await api(ctx.server, 'post', '/api/v1/reports/layouts', {
      token: actor.token,
      body: { reportKey: report.key, name: 'مرفوض', columns: [{ key: 'drop table', visible: true }] },
    });
    expect(unknownColumn.status).toBe(422);
    expect(code(unknownColumn)).toBe('REPORT_LAYOUT_EMPTY');

    const unknownReport = await api(ctx.server, 'post', '/api/v1/reports/layouts', { token: actor.token, body: { reportKey: 'nope', name: 'مرفوض' } });
    expect(unknownReport.status).toBe(404);

    const created = await api(ctx.server, 'post', '/api/v1/reports/layouts', {
      token: actor.token,
      body: {
        reportKey: report.key,
        name: 'مختصر',
        titleAr: 'عرض مختصر',
        isDefault: true,
        columns: [
          { key: report.columns[1]!.key, visible: true, labelAr: 'العمود الأول' },
          { key: report.columns[0]!.key, visible: false },
        ],
      },
    });
    expect(created.status).toBeLessThan(300);
    const layoutId = (body(created) as { id: string }).id;

    const run = await api(ctx.server, 'get', `/api/v1/reports/${report.key}`, { token: actor.token });
    const result = run.body as unknown as { titleAr: string; columns: Array<{ key: string; labelAr: string }>; layout: { id: string } | null };
    expect(result.layout?.id).toBe(layoutId);
    expect(result.columns).toHaveLength(1);
    expect(result.columns[0]!.labelAr).toBe('العمود الأول');
    expect(result.titleAr).toBe('عرض مختصر');

    const raw = await api(ctx.server, 'get', `/api/v1/reports/${report.key}?layout=none`, { token: actor.token });
    expect((raw.body as unknown as { columns: unknown[] }).columns).toHaveLength(report.columns.length);

    const missing = await api(ctx.server, 'get', `/api/v1/reports/${report.key}?layout=does-not-exist`, { token: actor.token });
    expect(missing.status).toBe(404);

    const removed = await api(ctx.server, 'delete', `/api/v1/reports/layouts/${layoutId}`, { token: actor.token });
    expect(removed.status).toBeLessThan(300);
  });

  it('creates a sibling company file that is empty of documents and starts unlicensed', async () => {
    const created = await api(ctx.server, 'post', '/api/v1/settings/company-files', {
      token: actor.token,
      body: { code: 'filesco-two', name: 'ملف ثانٍ', copy: ['accounts'] },
    });
    expect(created.status).toBeLessThan(300);
    const file = body(created) as { code: string; copied: Record<string, number>; subscriptionStatus: string };
    expect(file.code).toBe('filesco-two');
    expect(file.copied.accounts).toBeGreaterThan(0);
    // Creating books must never be a way to license yourself.
    expect(file.subscriptionStatus).toBe('pending');

    const duplicate = await api(ctx.server, 'post', '/api/v1/settings/company-files', { token: actor.token, body: { code: 'filesco-two', name: 'مكرر' } });
    expect(duplicate.status).toBe(409);
  });
});
