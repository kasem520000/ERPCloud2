import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { files, withTenantTx } from '@erp/database';

import { OBJECT_STORAGE, S3ObjectStorage } from '../src/modules/platform-services/index.js';

import { FakeObjectStorage } from './fakes.js';
import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * 📄 مدير الملفات — R7 (`INCOMPLETE_INVENTORY.md` §7-1: «مدير ملفات في staff»).
 *
 * الشاشة تُقرأ من هذه النقاط: `GET /files` بالترشيح والبحث والصفحات، `DELETE /files/{id}`
 * بالحذف الناعم وإسقاط الكائن، و`POST /files/presign` حين يكون التخزين غير مُهيّأ فيجب أن
 * تقول الشاشة «غير مُهيّأ» **503** لا «عطلٌ في الخادم» **500**.
 *
 * والمجموعة الأولى تعمل على تخزينٍ بديلٍ في الذاكرة (كما `files.spec.ts` — لا MinIO هنا)،
 * والثانية تُشغّل التطبيق **بالمُزوِّد الحقيقي بلا تهيئة**: لا `S3_*` في بيئة الاختبار، فيسقط
 * `presign` على المسار الجديد. وفيها يظهر الفرق الذي تعيش عليه الشاشة: **الميتاداتا تُقرأ
 * بلا تخزين، والبايتات لا**.
 */

const notAFile = '0199aaaa-1111-7000-8000-000000000abc';

describe('مدير الملفات — الحذف والقائمة (R7)', () => {
  let ctx: TestApp;
  let owner: Actor;
  let other: Actor;
  let reader: Actor;
  const storage = new FakeObjectStorage();

  beforeAll(async () => {
    ctx = await createTestApp('files-manager', (builder) =>
      builder.overrideProvider(OBJECT_STORAGE).useValue(storage),
    );
    // `ALL_PLATFORM_PERMISSIONS` هي رموز `platform.*` القديمة، وهي تُترجم إلى `tenant.*`
    // بالخريطة (`platform.file.upload` → `tenant.file.upload`)؛ ورمز الحذف جديد فلا سلفَ له.
    owner = await createActor(ctx, {
      tenantCode: 'files-mgr-a',
      email: 'owner@files-mgr-a.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'tenant.file.manage'],
    });
    other = await createActor(ctx, {
      tenantCode: 'files-mgr-b',
      email: 'owner@files-mgr-b.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'tenant.file.manage'],
    });
    // دورٌ يقرأ الملفات ولا يحذفها: `tenant.file.upload` بلا `tenant.file.manage`.
    reader = await createActor(ctx, {
      tenantCode: 'files-mgr-a',
      email: 'reader@files-mgr-a.test',
      permissions: ['tenant.file.upload'],
      roleNames: ['Reader'],
      isOwner: false,
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  /** presign → «رفع» في التخزين البديل → finalize. الحالة النهائية: `ready`. */
  async function readyFile(actor: Actor, name: string, mime = 'application/pdf'): Promise<string> {
    const presigned = await api(ctx.server, 'post', '/api/v1/files/presign', {
      token: actor.token,
      body: { name, mime, sizeBytes: 1024 },
    });
    const issued = presigned.body.data as { fileId: string; objectKey: string };
    storage.putObject(issued.objectKey, mime);
    const finalized = await api(ctx.server, 'post', `/api/v1/files/${issued.fileId}/finalize`, {
      token: actor.token,
      body: {},
    });
    expect(finalized.status).toBe(201);
    return issued.fileId;
  }

  it('يحذف الملف: الصفّ يُوسم، والكائن يُسقَط، والقراءة بعده 404', async () => {
    const fileId = await readyFile(owner, 'contract.pdf');
    const before = await api(ctx.server, 'get', `/api/v1/files/${fileId}`, { token: owner.token });
    const objectKey = (before.body.data as { objectKey: string }).objectKey;

    const removed = await api(ctx.server, 'delete', `/api/v1/files/${fileId}`, { token: owner.token });
    expect(removed.status).toBe(200);
    const result = removed.body.data as {
      id: string;
      name: string;
      deleted: boolean;
      objectRemoved: boolean;
    };
    expect(result.id).toBe(fileId);
    expect(result.name).toBe('contract.pdf');
    expect(result.deleted).toBe(true);
    // التخزين البديل يذكر أن الكائن طُلب إسقاطه فعلاً — لا وسمُ صفٍّ فحسب.
    expect(result.objectRemoved).toBe(true);
    expect(storage.deleted).toContain(objectKey);

    const gone = await api(ctx.server, 'get', `/api/v1/files/${fileId}`, { token: owner.token });
    expect(gone.status).toBe(404);

    // والحذف الثاني 404 كذلك: الصفّ المحذوف لا وجود له، لا «حُذف مرّتين».
    const again = await api(ctx.server, 'delete', `/api/v1/files/${fileId}`, { token: owner.token });
    expect(again.status).toBe(404);

    const listed = await api(ctx.server, 'get', '/api/v1/files?limit=100', { token: owner.token });
    expect((listed.body.data as Array<{ id: string }>).some((row) => row.id === fileId)).toBe(false);
  });

  it('يترك أثراً في مسار التدقيق: مَن حذف وماذا كان قبل الحذف', async () => {
    const fileId = await readyFile(owner, 'audited.pdf');
    await api(ctx.server, 'delete', `/api/v1/files/${fileId}`, { token: owner.token });

    const trail = await api(
      ctx.server,
      'get',
      `/api/v1/audit-log?filter[entity]=files&filter[entityId]=${fileId}&limit=20`,
      { token: owner.token },
    );
    expect(trail.status).toBe(200);
    type TrailRow = {
      action: string;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    };
    const rows = trail.body.data as TrailRow[];

    // سطران يُكتبان للحذف: سطر المُعترِض العام (ماذا ردّ الطلب) وسطر الخدمة (الفرق).
    // والدليل المقصود هو الثاني: الحالة قبل وبعد، ومفتاح الكائن باقٍ في الصفّ المحذوف.
    const diff = rows.find(
      (row) => row.action === 'delete' && (row.after as { status?: string } | null)?.status === 'deleted',
    );
    expect(diff).toBeDefined();
    expect((diff?.before as { status?: string } | null)?.status).toBe('ready');
    expect((diff?.after as { name?: string } | null)?.name).toBe('audited.pdf');
    expect((diff?.before as { objectKey?: string } | null)?.objectKey).toContain('/audited.pdf');
  });

  it('يحذف رفعاً لم يُثبَّت (صفٌّ «بانتظار الرفع») — وهذا ما تعرضه الشاشة بوسمٍ مميّز', async () => {
    const presigned = await api(ctx.server, 'post', '/api/v1/files/presign', {
      token: owner.token,
      body: { name: 'abandoned.pdf', mime: 'application/pdf', sizeBytes: 512 },
    });
    const fileId = (presigned.body.data as { fileId: string }).fileId;

    const pending = await api(ctx.server, 'get', `/api/v1/files?filter[status]=pending&limit=100`, {
      token: owner.token,
    });
    expect((pending.body.data as Array<{ id: string }>).some((row) => row.id === fileId)).toBe(true);

    const removed = await api(ctx.server, 'delete', `/api/v1/files/${fileId}`, { token: owner.token });
    expect(removed.status).toBe(200);
  });

  it('يرشّح بالحالة ويبحث في الاسم ويرقّم الصفحات — كل ما تحتاجه شبكة الشاشة', async () => {
    await readyFile(owner, 'quarterly-report-2026.pdf');
    await readyFile(owner, 'logo.png', 'image/png');

    const byName = await api(ctx.server, 'get', '/api/v1/files?q=quarterly-report-2026', {
      token: owner.token,
    });
    expect((byName.body.data as Array<{ name: string }>).map((row) => row.name)).toEqual([
      'quarterly-report-2026.pdf',
    ]);

    // البحث لا يخرج عن المنشأة (العزل في `withTenantTx` لا في هذه الصفحة).
    const theirs = await api(ctx.server, 'get', '/api/v1/files?q=quarterly-report-2026', {
      token: other.token,
    });
    expect((theirs.body.data as unknown[]).length).toBe(0);

    const page = await api(
      ctx.server,
      'get',
      '/api/v1/files?limit=1&offset=0&filter[status]=ready&sort=name',
      { token: owner.token },
    );
    expect((page.body.data as unknown[]).length).toBe(1);
    const meta = page.body.meta as { total: number; limit: number; offset: number };
    expect(meta.limit).toBe(1);
    expect(meta.offset).toBe(0);
    expect(meta.total).toBeGreaterThanOrEqual(2);

    // المرشّح بمستندٍ لم يُربط به ملفٌّ بعد يعود فارغاً — لا «كل الملفات».
    const entity = await api(ctx.server, 'get', '/api/v1/files?filter[entity]=company_profile', {
      token: owner.token,
    });
    expect(entity.status).toBe(200);
    expect((entity.body.data as unknown[]).length).toBe(0);
  });

  it('يفصل صلاحية الحذف عن صلاحية الرفع، ويحترم حدود المنشأة', async () => {
    const fileId = await readyFile(owner, 'guarded.pdf');

    const allowed = await api(ctx.server, 'get', '/api/v1/files', { token: reader.token });
    expect(allowed.status).toBe(200);

    const refused = await api(ctx.server, 'delete', `/api/v1/files/${fileId}`, { token: reader.token });
    expect(refused.status).toBe(403);

    // جارٌ لا يحذف ملفّنا، وملفّنا يبقى لصاحبه.
    const foreign = await api(ctx.server, 'delete', `/api/v1/files/${fileId}`, { token: other.token });
    expect(foreign.status).toBe(404);
    const still = await api(ctx.server, 'get', `/api/v1/files/${fileId}`, { token: owner.token });
    expect(still.status).toBe(200);
  });

  it('يردّ على معرّفٍ معطوب بـ`INVALID_ID` لا بـ`VALIDATION_FAILED` — رمزٌ واحد لكل المسارات', async () => {
    // مسار الملفات يقرأ المعاملات **ككائن** (`@Param(idParamSchema)`)، وهو النموذج الذي كان
    // يسقط إلى zod فيخرج `VALIDATION_FAILED`؛ صار الحارس العام يفحص مفاتيح الكائن نفسها.
    for (const method of ['get', 'delete'] as const) {
      const response = await api(ctx.server, method, '/api/v1/files/not-a-uuid', { token: owner.token });
      expect(response.status, method).toBe(400);
      expect(response.body.code, method).toBe('INVALID_ID');
      expect((response.body.errors as Array<{ field: string }>)[0]?.field, method).toBe('id');
    }

    // ومعرّفٌ صحيح لا وجود له يبقى «غير موجود» — الحارس يفحص الشكل لا الوجود.
    const missing = await api(ctx.server, 'get', `/api/v1/files/${notAFile}`, { token: owner.token });
    expect(missing.status).toBe(404);
  });
});

describe('تخزينٌ غير مُهيّأ — 503 `STORAGE_NOT_CONFIGURED` لا 500 (R7)', () => {
  let ctx: TestApp;
  let owner: Actor;

  beforeAll(async () => {
    // المحوّل **الحقيقي** في حالته غير المُهيّأة (`null` صريحة) — لا بديلٌ مزيّف: السلوك
    // المقيس هو سلوك `S3ObjectStorage` نفسه، والبيئة هنا تحمل `S3_*` من `.env`.
    ctx = await createTestApp('files-unconfigured', (builder) =>
      builder.overrideProvider(OBJECT_STORAGE).useValue(new S3ObjectStorage(null)),
    );
    owner = await createActor(ctx, {
      tenantCode: 'files-nostore',
      email: 'owner@files-nostore.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'tenant.file.manage'],
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('يرفض الرفع بـ503 يسمّي متغيّرات البيئة الناقصة', async () => {
    const response = await api(ctx.server, 'post', '/api/v1/files/presign', {
      token: owner.token,
      body: { name: 'anything.pdf', mime: 'application/pdf', sizeBytes: 1024 },
    });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('STORAGE_NOT_CONFIGURED');
    expect(String(response.body.detail)).toContain('Object storage is not configured');
    // الحقل الآليّ الذي تقرأه الشاشة موجود، وتسمية المتغيّرات الناقصة بعينها يضمنها
    // `packages/config/src/object-storage-env.spec.ts:25` (وحدة التهيئة لا هذه الشاشة).
    const problems = response.body.errors as Array<{ missing: string[] }>;
    expect(Array.isArray(problems[0]?.missing)).toBe(true);
    // ولا تسريب لقيَم: أسماءٌ لا أسرار.
    expect(JSON.stringify(response.body.errors)).not.toContain('minioadmin');
  });

  it('ويظلّ الميتاداتا مقروءاً: القائمة والصفّ لا يحتاجان تخزيناً', async () => {
    const fileId = '01a0bc0e-3518-777d-b132-397b04651c8a';
    // صفٌّ «جاهز» مزروعٌ مباشرةً: الشاشة تقرأ الصفوف حتى لو تعذّر الوصول إلى البايتات.
    await withTenantTx(ctx.handle.db, owner.tenantId, (tx) =>
      tx.insert(files).values({
        id: fileId,
        tenantId: owner.tenantId,
        bucket: 'erp-dev',
        objectKey: `tenants/${owner.tenantId}/orphan.pdf`,
        name: 'orphan.pdf',
        mime: 'application/pdf',
        sizeBytes: 10,
        status: 'ready',
        uploadedBy: owner.userId,
        createdBy: owner.userId,
      }),
    );

    const listed = await api(ctx.server, 'get', '/api/v1/files?limit=10', { token: owner.token });
    expect(listed.status).toBe(200);
    expect((listed.body.data as Array<{ name: string }>).some((row) => row.name === 'orphan.pdf')).toBe(true);

    const read = await api(ctx.server, 'get', `/api/v1/files/${fileId}`, { token: owner.token });
    expect(read.status).toBe(200);

    // الرابط الموقّع يُصدر (توقيعٌ محلي)، لكن **اتّباعه** يحتاج تخزيناً فيسقط بـ503.
    const link = await api(ctx.server, 'get', `/api/v1/files/${fileId}/download`, { token: owner.token });
    expect(link.status).toBe(200);
    const url = (link.body.data as { url: string }).url;
    const followed = await api(ctx.server, 'get', url);
    expect(followed.status).toBe(503);
    expect(followed.body.code).toBe('STORAGE_NOT_CONFIGURED');
  });

  it('ويظلّ الحذف ممكناً: الصفّ يُوسم و`objectRemoved` تقول الحقيقة (لم يُسقَط شيء)', async () => {
    const listed = await api(ctx.server, 'get', '/api/v1/files?limit=10', { token: owner.token });
    const fileId = (listed.body.data as Array<{ id: string }>)[0]?.id as string;

    const removed = await api(ctx.server, 'delete', `/api/v1/files/${fileId}`, { token: owner.token });
    expect(removed.status).toBe(200);
    // لا تخزين ⇒ لا إسقاط. والشاشة تنقل هذا الوسم كما هو بدل أن تقول «حُذف الملف».
    expect((removed.body.data as { objectRemoved: boolean }).objectRemoved).toBe(false);
  });
});

describe('S3ObjectStorage بلا تهيئة', () => {
  it('يرمي `STORAGE_NOT_CONFIGURED` 503 من المُزوِّد نفسه', () => {
    const storage = new S3ObjectStorage(null);
    expect(storage.isConfigured()).toBe(false);
    try {
      storage.presignUpload('tenants/x/y.pdf', 'application/pdf');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('STORAGE_NOT_CONFIGURED');
      expect((error as { status?: number }).status).toBe(503);
    }
  });
});
