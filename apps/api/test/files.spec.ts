import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OBJECT_STORAGE } from '../src/modules/platform-services/index.js';

import { FakeObjectStorage } from './fakes.js';
import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Files — PHASE_04 §5.3 / §12 ("presign → upload → finalize → download flow works").
 * Storage is the in-memory fake (see `fakes.ts` for why); everything the application
 * owns — row lifecycle, allow-lists, tenant-prefixed keys, signed URLs, the 302 — is
 * exercised for real, against RLS, as `erp_api`.
 */
describe('files (API_CONTRACT §2, PHASE_04 §5.3)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let other: Actor;
  let viewer: Actor;
  const storage = new FakeObjectStorage();

  beforeAll(async () => {
    ctx = await createTestApp('files', (builder) =>
      builder.overrideProvider(OBJECT_STORAGE).useValue(storage),
    );
    admin = await createActor(ctx, {
      tenantCode: 'files-a',
      email: 'owner@files-a.test',
      permissions: ALL_PLATFORM_PERMISSIONS,
    });
    other = await createActor(ctx, {
      tenantCode: 'files-b',
      email: 'owner@files-b.test',
      permissions: ALL_PLATFORM_PERMISSIONS,
    });
    viewer = await createActor(ctx, {
      tenantCode: 'files-a',
      email: 'viewer@files-a.test',
      permissions: ['platform.tenant.view'],
      roleNames: ['Viewer'],
      isOwner: false,
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  async function presign(actor: Actor, name = 'invoice.pdf', mime = 'application/pdf', sizeBytes = 2048) {
    return api(ctx.server, 'post', '/api/v1/files/presign', {
      token: actor.token,
      body: { name, mime, sizeBytes },
    });
  }

  it('runs the presign → upload → finalize → download flow', async () => {
    const presigned = await presign(admin);
    expect(presigned.status).toBe(201);

    const issued = presigned.body.data as {
      fileId: string;
      uploadUrl: string;
      objectKey: string;
      requiredHeaders: Record<string, string>;
    };
    expect(issued.uploadUrl).toContain(issued.objectKey);
    expect(issued.requiredHeaders['Content-Type']).toBe('application/pdf');
    // The key is tenant-prefixed, which is what makes a leaked key useless elsewhere.
    expect(issued.objectKey.startsWith(`tenants/${admin.tenantId}/`)).toBe(true);

    // The client PUTs the bytes straight to storage; the API never sees them.
    storage.putObject(issued.objectKey, 'application/pdf');

    const pending = await api(ctx.server, 'get', `/api/v1/files/${issued.fileId}`, { token: admin.token });
    expect((pending.body.data as { status: string }).status).toBe('pending');

    // A pending upload cannot be downloaded.
    const early = await api(ctx.server, 'get', `/api/v1/files/${issued.fileId}/download`, {
      token: admin.token,
    });
    expect(early.status).toBe(422);

    const finalized = await api(ctx.server, 'post', `/api/v1/files/${issued.fileId}/finalize`, {
      token: admin.token,
      body: { checksum: 'sha256:abc' },
    });
    expect(finalized.status).toBe(201);
    expect((finalized.body.data as { status: string }).status).toBe('ready');

    const download = await api(ctx.server, 'get', `/api/v1/files/${issued.fileId}/download`, {
      token: admin.token,
    });
    expect(download.status).toBe(200);
    const link = (download.body.data as { url: string }).url;
    expect(link).toContain(`/files/${issued.fileId}/content?`);
    expect(link).toContain('signature=');

    // The content route is public and redirects to storage.
    const followed = await api(ctx.server, 'get', `/api/v1${link.slice('/api/v1'.length)}`);
    expect(followed.status).toBe(302);
    expect(followed.headers.location).toContain(issued.objectKey);
  });

  it('rejects a tampered or expired download signature', async () => {
    const presigned = await presign(admin, 'contract.pdf');
    const fileId = (presigned.body.data as { fileId: string }).fileId;
    await api(ctx.server, 'post', `/api/v1/files/${fileId}/finalize`, { token: admin.token, body: {} });

    const download = await api(ctx.server, 'get', `/api/v1/files/${fileId}/download`, {
      token: admin.token,
    });
    const url = (download.body.data as { url: string }).url;

    // Flip one character so the token stays well-formed and the *signature* is what fails.
    const tampered = url.replace(/signature=(.)/, (_match, first: string) =>
      `signature=${first === 'A' ? 'B' : 'A'}`,
    );
    expect((await api(ctx.server, 'get', tampered)).status).toBe(401);

    const expired = url.replace(/expires=\d+/, 'expires=1000000000');
    expect((await api(ctx.server, 'get', expired)).status).toBe(401);

    // A valid signature for tenant A cannot be pointed at tenant B.
    const swapped = url.replace(admin.tenantId, other.tenantId);
    expect((await api(ctx.server, 'get', swapped)).status).toBe(401);
  });

  it('enforces the MIME allow-list and the size ceiling', async () => {
    const badMime = await presign(admin, 'payload.exe', 'application/x-msdownload');
    expect(badMime.status).toBe(400);
    expect(badMime.body.code).toBe('VALIDATION_FAILED');

    const tooBig = await presign(admin, 'huge.pdf', 'application/pdf', 5_000_000_000);
    expect(tooBig.status).toBe(400);
  });

  it('refuses to attach a file to an entity that no module has registered', async () => {
    const response = await api(ctx.server, 'post', '/api/v1/files/presign', {
      token: admin.token,
      body: {
        name: 'note.pdf',
        mime: 'application/pdf',
        sizeBytes: 10,
        entity: 'sales_invoice',
        entityId: admin.tenantId,
      },
    });
    expect(response.status).toBe(422);
    expect(String(response.body.detail)).toContain('cannot receive attachments');
  });

  it('hides another tenant file behind a 404 and requires the permission', async () => {
    const presigned = await presign(admin, 'private.pdf');
    const fileId = (presigned.body.data as { fileId: string }).fileId;

    const foreign = await api(ctx.server, 'get', `/api/v1/files/${fileId}`, { token: other.token });
    expect(foreign.status).toBe(404);

    const unauthorised = await api(ctx.server, 'get', '/api/v1/files', { token: viewer.token });
    expect(unauthorised.status).toBe(403);
  });

  it('lists only this tenant files', async () => {
    const listed = await api(ctx.server, 'get', '/api/v1/files?limit=50', { token: admin.token });
    expect(listed.status).toBe(200);
    const rows = listed.body.data as Array<{ id: string }>;
    expect(rows.length).toBeGreaterThan(0);

    const otherTenant = await api(ctx.server, 'get', '/api/v1/files?limit=50', { token: other.token });
    expect((otherTenant.body.data as unknown[]).length).toBe(0);
  });
});
