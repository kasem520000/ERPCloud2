import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { COMPANY_PROFILE_FILE_ENTITY } from '@erp/contracts';

import { FileAttachmentRegistry, OBJECT_STORAGE } from '../src/modules/platform-services/index.js';

import { FakeObjectStorage } from './fakes.js';
import {
  ALL_ORGANIZATION_PERMISSIONS,
  ALL_PLATFORM_PERMISSIONS,
  createActor,
  type Actor,
} from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Company profile and branch posting profiles — API_CONTRACT §3, PHASE_05 §5.5 / §5.8.
 *
 * These two carry the phase's integrations with PHASE_04: the company logo is the first
 * entity registered in the `FileAttachmentRegistry`, and both resources write an
 * explicit before/after audit row in the same transaction as the change.
 */
describe('company profile and posting profiles (PHASE_05 §5.5, §5.8)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let branchId: string;
  let otherBranchId: string;
  const storage = new FakeObjectStorage();

  const salesMapping = {
    version: 1 as const,
    salesAccountId: '018f3b8a-0000-7000-8000-0000000000c1',
    vatOutputAccountId: '018f3b8a-0000-7000-8000-0000000000c2',
  };

  beforeAll(async () => {
    ctx = await createTestApp('org-profiles', (builder) =>
      builder.overrideProvider(OBJECT_STORAGE).useValue(storage),
    );
    admin = await createActor(ctx, {
      tenantCode: 'org-profiles',
      email: 'admin@org-profiles.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, ...ALL_ORGANIZATION_PERMISSIONS],
    });

    const main = await api(ctx.server, 'post', '/api/v1/branches', {
      token: admin.token,
      body: { code: 'MAIN', nameAr: 'الرئيسي' },
    });
    branchId = (main.body.data as { id: string }).id;

    const other = await api(ctx.server, 'post', '/api/v1/branches', {
      token: admin.token,
      body: { code: 'ALT', nameAr: 'فرع آخر' },
    });
    otherBranchId = (other.body.data as { id: string }).id;
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  const token = () => admin.token;

  // --- company profile ------------------------------------------------------------

  it('404s until the profile is written, then reads back what was stored', async () => {
    const missing = await api(ctx.server, 'get', '/api/v1/company-profile', { token: token() });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NOT_FOUND');

    const written = await api(ctx.server, 'put', '/api/v1/company-profile', {
      token: token(),
      body: {
        nameAr: 'شركة الاختبار',
        nameEn: 'Test Company',
        taxNo: '300000000000003',
        crNo: '1010101010',
        address: { building: '1234', street: 'King Fahd', district: 'Olaya', city: 'Riyadh', postal: '12345' },
        phones: ['+966110000000', '+966500000000'],
        email: 'billing@test.example',
        countryCode: 'SA',
        einvoiceFlags: { zatca: true },
      },
    });
    expect(written.status).toBe(200);
    const profile = written.body.data as { tenantId: string; version: number; countryCode: string };
    expect(profile.tenantId).toBe(admin.tenantId);
    expect(profile.version).toBe(1);
    expect(profile.countryCode).toBe('SA');

    const read = await api(ctx.server, 'get', '/api/v1/company-profile', { token: token() });
    expect(read.status).toBe(200);
    expect((read.body.data as { nameEn: string }).nameEn).toBe('Test Company');
    expect((read.body.data as { phones: string[] }).phones).toEqual(['+966110000000', '+966500000000']);
  });

  it('upserts rather than duplicating, and honours the version token', async () => {
    const current = await api(ctx.server, 'get', '/api/v1/company-profile', { token: token() });
    const version = (current.body.data as { version: number }).version;

    const updated = await api(ctx.server, 'put', '/api/v1/company-profile', {
      token: token(),
      body: { nameAr: 'شركة الاختبار المحدثة', nameEn: 'Test Company', version },
    });
    expect(updated.status).toBe(200);
    expect((updated.body.data as { version: number }).version).toBe(version + 1);

    // The same token again is now stale — a second writer would be overwriting a row it
    // never read.
    const stale = await api(ctx.server, 'put', '/api/v1/company-profile', {
      token: token(),
      body: { nameAr: 'اسم قديم', version },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    // PUT replaces: a field left out is cleared, not silently kept.
    expect((updated.body.data as { taxNo: string | null }).taxNo).toBeNull();

    const client = new Client({ connectionString: ctx.db.ownerUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM company_profiles WHERE tenant_id = $1',
        [admin.tenantId],
      );
      expect(rows[0]?.count).toBe('1');
    } finally {
      await client.end();
    }
  });

  it('writes an explicit before/after audit row for the profile', async () => {
    const client = new Client({ connectionString: ctx.db.ownerUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{
        action: string;
        before: { nameAr: string } | null;
        after: { nameAr: string } | null;
      }>(
        `SELECT action, before, after FROM audit_log
          WHERE entity = 'company_profile' AND entity_id = $1 ORDER BY created_at ASC`,
        [admin.tenantId],
      );

      expect(rows[0]?.action).toBe('create');
      expect(rows[0]?.before).toBeNull();
      expect(rows.at(-1)?.action).toBe('update');
      expect(rows.at(-1)?.before?.nameAr).toBe('شركة الاختبار');
      expect(rows.at(-1)?.after?.nameAr).toBe('شركة الاختبار المحدثة');
    } finally {
      await client.end();
    }
  });

  it('accepts a finalised image as the logo and refuses anything else', async () => {
    const registry = ctx.app.get(FileAttachmentRegistry);
    // PHASE_04 shipped this registry empty; the company logo is its first entry.
    expect(registry.registeredEntities()).toContain(COMPANY_PROFILE_FILE_ENTITY);

    const presigned = await api(ctx.server, 'post', '/api/v1/files/presign', {
      token: token(),
      body: {
        name: 'logo.png',
        mime: 'image/png',
        sizeBytes: 4096,
        entity: COMPANY_PROFILE_FILE_ENTITY,
        entityId: admin.tenantId,
      },
    });
    expect(presigned.status).toBe(201);
    const issued = presigned.body.data as { fileId: string; objectKey: string };

    // A pending upload is not a logo: the bytes are not there yet.
    const early = await api(ctx.server, 'put', '/api/v1/company-profile', {
      token: token(),
      body: { nameAr: 'شركة', logoFileId: issued.fileId },
    });
    expect(early.status).toBe(422);
    expect(early.body.detail).toContain('finalised');

    storage.putObject(issued.objectKey, 'image/png');
    const finalized = await api(ctx.server, 'post', `/api/v1/files/${issued.fileId}/finalize`, {
      token: token(),
      body: {},
    });
    expect(finalized.status).toBe(201);

    const saved = await api(ctx.server, 'put', '/api/v1/company-profile', {
      token: token(),
      body: { nameAr: 'شركة الاختبار المحدثة', logoFileId: issued.fileId },
    });
    expect(saved.status).toBe(200);
    expect((saved.body.data as { logoFileId: string }).logoFileId).toBe(issued.fileId);

    const unknown = await api(ctx.server, 'put', '/api/v1/company-profile', {
      token: token(),
      body: { nameAr: 'شركة', logoFileId: '018f3b8a-0000-7000-8000-0000000000ee' },
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body.detail).toContain('does not exist');
  });

  it('refuses a non-image logo', async () => {
    const presigned = await api(ctx.server, 'post', '/api/v1/files/presign', {
      token: token(),
      body: { name: 'brochure.pdf', mime: 'application/pdf', sizeBytes: 2048 },
    });
    const issued = presigned.body.data as { fileId: string; objectKey: string };
    storage.putObject(issued.objectKey, 'application/pdf');
    await api(ctx.server, 'post', `/api/v1/files/${issued.fileId}/finalize`, {
      token: token(),
      body: {},
    });

    const response = await api(ctx.server, 'put', '/api/v1/company-profile', {
      token: token(),
      body: { nameAr: 'شركة', logoFileId: issued.fileId },
    });
    expect(response.status).toBe(422);
    expect(response.body.detail).toContain('image');
  });

  it('refuses to attach a logo to anything but the tenant’s own profile', async () => {
    // Presign only checks that the entity is *registered*; the validator runs on
    // finalize, which is where the entity id is proved to exist in this tenant.
    const presigned = await api(ctx.server, 'post', '/api/v1/files/presign', {
      token: token(),
      body: {
        name: 'logo2.png',
        mime: 'image/png',
        sizeBytes: 1024,
        entity: COMPANY_PROFILE_FILE_ENTITY,
        entityId: branchId,
      },
    });
    expect(presigned.status).toBe(201);
    const issued = presigned.body.data as { fileId: string; objectKey: string };
    storage.putObject(issued.objectKey, 'image/png');

    const finalized = await api(ctx.server, 'post', `/api/v1/files/${issued.fileId}/finalize`, {
      token: token(),
      body: {},
    });
    expect(finalized.status).toBe(422);
    expect(finalized.body.detail).toContain(COMPANY_PROFILE_FILE_ENTITY);
  });

  // --- posting profiles -----------------------------------------------------------

  it('fails with ACCOUNT_PROFILE_MISSING while nothing is mapped', async () => {
    const response = await api(
      ctx.server,
      'get',
      `/api/v1/branch-posting-profiles/resolve?branchId=${branchId}&docType=sales_invoice`,
      { token: token() },
    );
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('ACCOUNT_PROFILE_MISSING');
  });

  it('walks the fallback chain from tenant wildcard up to branch override', async () => {
    const resolve = (branch: string, docType = 'sales_invoice') =>
      api(ctx.server, 'get', `/api/v1/branch-posting-profiles/resolve?branchId=${branch}&docType=${docType}`, {
        token: token(),
      });

    // Rung 4 — the tenant-wide catch-all, heir of the legacy `SettingGeneral.*Acc`.
    const tenantWildcard = await api(ctx.server, 'post', '/api/v1/branch-posting-profiles', {
      token: token(),
      body: { docType: '*', mapping: { version: 1, salesAccountId: salesMapping.salesAccountId } },
    });
    expect(tenantWildcard.status).toBe(201);
    expect((tenantWildcard.body.data as { branchId: string | null }).branchId).toBeNull();

    let resolved = await resolve(branchId);
    expect(resolved.status).toBe(200);
    expect(resolved.body.data).toMatchObject({ matchedBranchId: null, matchedDocType: '*' });

    // Rung 3 — tenant default for this doc type.
    await api(ctx.server, 'post', '/api/v1/branch-posting-profiles', {
      token: token(),
      body: { docType: 'sales_invoice', mapping: salesMapping },
    });
    resolved = await resolve(branchId);
    expect(resolved.body.data).toMatchObject({ matchedBranchId: null, matchedDocType: 'sales_invoice' });

    // Rung 2 — the branch's own catch-all.
    await api(ctx.server, 'post', '/api/v1/branch-posting-profiles', {
      token: token(),
      body: { branchId, docType: '*', mapping: { version: 1, cashAccountId: salesMapping.salesAccountId } },
    });
    resolved = await resolve(branchId);
    expect(resolved.body.data).toMatchObject({ matchedBranchId: branchId, matchedDocType: '*' });

    // Rung 1 — the branch override for this doc type wins outright.
    const branchExact = await api(ctx.server, 'post', '/api/v1/branch-posting-profiles', {
      token: token(),
      body: {
        branchId,
        docType: 'sales_invoice',
        mapping: { version: 1, salesAccountId: '018f3b8a-0000-7000-8000-0000000000d1' },
      },
    });
    expect(branchExact.status).toBe(201);

    resolved = await resolve(branchId);
    expect(resolved.body.data).toMatchObject({
      matchedBranchId: branchId,
      matchedDocType: 'sales_invoice',
      mapping: { version: 1, salesAccountId: '018f3b8a-0000-7000-8000-0000000000d1' },
    });

    // The other branch never borrows the override — it still lands on the tenant row.
    const foreign = await resolve(otherBranchId);
    expect(foreign.body.data).toMatchObject({ matchedBranchId: null, matchedDocType: 'sales_invoice' });

    // A doc type nobody mapped falls back to the wildcard chain.
    const unmapped = await resolve(branchId, 'payroll_run');
    expect(unmapped.body.data).toMatchObject({ matchedBranchId: branchId, matchedDocType: '*' });
  });

  it('upserts on (branch, docType) instead of stacking duplicates', async () => {
    const first = await api(ctx.server, 'post', '/api/v1/branch-posting-profiles', {
      token: token(),
      body: {
        branchId: otherBranchId,
        docType: 'journal_entry',
        mapping: { version: 1, cashAccountId: '018f3b8a-0000-7000-8000-0000000000e1' },
      },
    });
    const profileId = (first.body.data as { id: string; version: number }).id;

    const second = await api(ctx.server, 'post', '/api/v1/branch-posting-profiles', {
      token: token(),
      body: {
        branchId: otherBranchId,
        docType: 'journal_entry',
        mapping: { version: 1, cashAccountId: '018f3b8a-0000-7000-8000-0000000000e2' },
      },
    });
    expect((second.body.data as { id: string }).id).toBe(profileId);
    expect((second.body.data as { version: number }).version).toBe(2);

    const list = await api(
      ctx.server,
      'get',
      `/api/v1/branch-posting-profiles?filter[branchId]=${otherBranchId}&filter[docType]=journal_entry`,
      { token: token() },
    );
    expect((list.body.meta as { total: number }).total).toBe(1);

    const removed = await api(ctx.server, 'delete', `/api/v1/branch-posting-profiles/${profileId}`, {
      token: token(),
    });
    expect(removed.status).toBe(204);
    const gone = await api(ctx.server, 'get', `/api/v1/branch-posting-profiles/${profileId}`, {
      token: token(),
    });
    expect(gone.status).toBe(404);
  });

  it('rejects a mapping that is unversioned, empty or aimed at an unknown branch', async () => {
    const unversioned = await api(ctx.server, 'post', '/api/v1/branch-posting-profiles', {
      token: token(),
      body: { docType: 'credit_note', mapping: { salesAccountId: salesMapping.salesAccountId } },
    });
    expect(unversioned.status).toBe(400);

    const empty = await api(ctx.server, 'post', '/api/v1/branch-posting-profiles', {
      token: token(),
      body: { docType: 'credit_note', mapping: { version: 1 } },
    });
    expect(empty.status).toBe(400);

    const ghostBranch = await api(ctx.server, 'post', '/api/v1/branch-posting-profiles', {
      token: token(),
      body: {
        branchId: '018f3b8a-0000-7000-8000-0000000000ff',
        docType: 'credit_note',
        mapping: salesMapping,
      },
    });
    expect(ghostBranch.status).toBe(404);
  });

  it('audits posting-profile writes with a before/after pair', async () => {
    const client = new Client({ connectionString: ctx.db.ownerUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{ action: string; before: unknown; after: unknown }>(
        `SELECT action, before, after FROM audit_log
          WHERE entity = 'branch_posting_profile' ORDER BY created_at ASC`,
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.map((row) => row.action)).toContain('update');
      const update = rows.find((row) => row.action === 'update');
      expect(update?.before).not.toBeNull();
      expect(update?.after).not.toBeNull();
      const remove = rows.find((row) => row.action === 'delete');
      expect(remove?.after).toBeNull();
    } finally {
      await client.end();
    }
  });
});
