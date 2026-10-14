import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  backupAuditActions,
  permissionRegistry,
  platformRetentionApplySchema,
  type PlatformBackupRow,
  type PlatformBackupVerifyResult,
  type PlatformDataRequestRow,
  type PlatformRetention,
} from '@erp/contracts';
import { withPlatformAdminTx, withTenantTx } from '@erp/database';
import request from 'supertest';

import {
  ARTIFACT_STORE_FS,
  ARTIFACT_STORE_S3,
  FileArtifactStore,
  S3ArtifactStore,
  openArtifact,
  sealArtifact,
  selectArtifactStore,
} from '../src/modules/backups/artifact-store.js';

import { createActor, type Actor, type ActorOptions } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * P-C10 — «البيانات والاسترجاع» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
 *
 * ثلاث دعاوى تُقاس هنا من البايتات لا من الاستجابة:
 *
 * 1. **النسخة تُغادر القاعدة.** بعد `POST /platform/backups/run` يوجد ملفٌ على القرص،
 *    ويُقرأ في الاختبار من مساره، ويُقارن حجمه بالمسجَّل. ثم يُحوَّل بايتٌ واحد فيه —
 *    و`verify` يجب أن **يفشل**: لو نجح، لكان يقرأ الاستجابة لا الملف.
 * 2. **الاحتفاظ يُنفَّذ.** سياسةٌ خارج حدودها تُرفض، ونافذةٌ تُكتب تُحفظ وتُقرأ وله أثرٌ
 *    في التدقيق، والتطبيق يحذف **الملف** ويسجّل `pruned_at` **ويُبقي الصفّ**.
 * 3. **حقّ النسيان يمحو الهوية ويُبقي الإيصال.** المحو يحتاج تأكيداً بكتابة البريد، ويُخفي
 *    حقول `users` ويسحب العضوية ويُبطل الجلسات، **وعددُ صفوف التدقيق الباقية يُعاد في
 *    النتيجة** — وعدد الصفوف في الجدول لا ينقص.
 */

type OperatorOptions = ActorOptions & { platformRoles?: readonly string[] };

const everyPermission = permissionRegistry.map((entry) => entry.code);
const createOperator = createActor as (ctx: TestApp, options: OperatorOptions) => Promise<Actor>;

describe('platform backups and data requests (P-C10)', () => {
  let ctx: TestApp;
  let owner: Actor;
  let operations: Actor;
  let auditor: Actor;
  let subject: Actor;
  let tenantId: string;
  let artifactDir: string;

  const base = '/api/v1';

  const platform = (method: 'get' | 'post' | 'put', path: string, body?: unknown, actor: Actor = owner) =>
    api(ctx.server, method, `${base}${path}`, { token: actor.token, body });

  const backupRows = async (): Promise<PlatformBackupRow[]> => {
    const response = await platform('get', '/platform/backups');
    return (response.body as { data: PlatformBackupRow[] }).data;
  };

  const dataRequests = async (filter: string): Promise<PlatformDataRequestRow[]> => {
    const response = await platform('get', `/platform/data-requests?filter[kind]=${filter}`);
    return (response.body as { data: PlatformDataRequestRow[] }).data;
  };

  /** الطلب كما يفتحه المتصفّح: بلا رمز حامل — نصٌّ خام لأن الجسم `application/x-ndjson`. */
  const rawDownload = async (path: string): Promise<{ status: number; text: string }> => {
    const response = await request(ctx.server).get(path);
    return { status: response.status, text: response.text ?? '' };
  };

  const storedArtifacts = async (): Promise<string[]> =>
    (await readdir(artifactDir, { recursive: true }))
      .map((name) => String(name))
      .filter((name) => name.endsWith('.enc'));

  beforeAll(async () => {
    artifactDir = await mkdtemp(join(tmpdir(), 'erp-backup-spec-'));
    ctx = await createTestApp('platform-backups', (builder) =>
      builder
        // التخزين غير مُهيّأ في الاختبار ⇒ النسخة تكتب إلى نظام الملفات، وهو المسار الذي
        // يُختبر هنا فعلاً. والمنفذ المزيّف يُعلن `isConfigured: false` صراحةً.
        .overrideProvider(ARTIFACT_STORE_S3)
        .useValue({
          name: 'object-storage',
          isConfigured: () => false,
          put: vi.fn(),
          get: vi.fn(),
          remove: vi.fn(),
        })
        .overrideProvider(ARTIFACT_STORE_FS)
        .useValue(new FileArtifactStore(artifactDir)),
    );

    owner = await createOperator(ctx, {
      tenantCode: 'p-c10-console',
      email: 'owner@p-c10-console.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_owner'],
    });
    operations = await createOperator(ctx, {
      tenantCode: 'p-c10-console',
      email: 'ops@p-c10-console.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_operations'],
    });
    auditor = await createOperator(ctx, {
      tenantCode: 'p-c10-console',
      email: 'auditor@p-c10-console.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_auditor'],
    });
    subject = await createActor(ctx, {
      tenantCode: 'p-c10-customer',
      tenantName: 'شركة صاحب البيانات',
      email: 'subject@p-c10-customer.test',
      permissions: everyPermission,
      roleNames: ['Admin'],
      isOwner: true,
    });
    tenantId = subject.tenantId;
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    await rm(artifactDir, { recursive: true, force: true });
  });

  // ─────────────────────────────────────────────────────────── الصلاحية

  describe('الصلاحية: من يملك النسخة يملك ما فيها', () => {
    it('مدقّق المنصة لا يرى النسخ (403)، ومشغّل المنصة يراها (200)', async () => {
      expect((await platform('get', '/platform/backups', undefined, auditor)).status).toBe(403);
      expect((await platform('get', '/platform/backups', undefined, operations)).status).toBe(200);
    });

    it('مستخدم مستأجرٍ عادي لا يصل إلى سطح النسخ ولا إلى طلبات البيانات', async () => {
      expect((await platform('get', '/platform/backups', undefined, subject)).status).toBe(403);
      expect((await platform('get', '/platform/data-requests', undefined, subject)).status).toBe(403);
    });

    it('الرمز الجديد معلنٌ في القاعدة وفي السجلّ المنصّي', async () => {
      const rows = await withPlatformAdminTx(ctx.handle.db, (tx) =>
        tx.execute(sql`SELECT code, module FROM permissions WHERE code = 'console.backups.manage'`),
      );
      expect(rows.rows).toHaveLength(1);
      expect((rows.rows[0] as { module: string }).module).toBe('console');
    });
  });

  // ─────────────────────────────────────────────────────────── النسخة

  describe('النسخة: تُكتب، تُقاس من الملف، وتُحقّق', () => {
    let run: PlatformBackupRow;

    it('تشغيل نسخة المنصّة ينجح ويكتب ملفاً حقيقياً مشفّراً على القرص', async () => {
      const response = await platform('post', '/platform/backups/run', { note: 'نسخة اختبار P-C10' });
      expect(response.status).toBe(201);
      run = (response.body as { data: PlatformBackupRow }).data;

      expect(run.status).toBe('succeeded');
      expect(run.scope).toBe('platform');
      expect(run.store).toBe('filesystem');
      expect(run.bytes).toBeGreaterThan(0);
      expect(run.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(run.rows).toBeGreaterThan(0);
      expect(run.tables).toBeGreaterThan(5);
      expect(run.tenants).toBeGreaterThanOrEqual(2);
      expect(run.durationMs).toBeGreaterThanOrEqual(0);

      const files = await storedArtifacts();
      const stored = files.find((name) => name.includes(run.id));
      expect(stored).toBeDefined();
      const bytes = await readFile(join(artifactDir, stored!));
      expect(bytes.byteLength).toBe(run.bytes);
      // والمكتوب مشفّر: ترويسةٌ صريحة، ثم بايتاتٌ ليست نصّ NDJSON.
      expect(bytes.subarray(0, 10).toString('utf8')).toBe('ERP-BACKUP');
      expect(bytes.toString('utf8')).not.toContain('"kind":"erp-platform-dump"');
    });

    it('نسخة مستأجرٍ بلا معرّف تُرفض 400، وبمعرّفٍ غير موجود 404', async () => {
      expect((await platform('post', '/platform/backups/run', { scope: 'tenant' })).status).toBe(400);
      const missing = await platform('post', '/platform/backups/run', {
        scope: 'tenant',
        tenantId: '11111111-2222-4333-8444-555555555555',
      });
      expect(missing.status).toBe(404);
    });

    it('نسخة مستأجرٍ واحد تُعلن نطاقها، وتُسقط جداول المنصّة وتُسمّيها في الذيل', async () => {
      const response = await platform('post', '/platform/backups/run', {
        scope: 'tenant',
        tenantId,
        note: 'نسخة مستأجرٍ واحد',
      });
      const single = (response.body as { data: PlatformBackupRow }).data;
      expect(single.status).toBe('succeeded');
      expect(single.scope).toBe('tenant');
      expect(single.tenantId).toBe(tenantId);
      expect(single.tenants).toBe(1);

      const content = await platform('get', `/platform/backups/${single.id}/download`);
      const data = (content.body as { data: { url: string; name: string; checksum: string } }).data;
      expect(data.name).toBe(`${single.id}.ndjson`);
      expect(data.checksum).toBe(single.checksum);

      // الرابط يُفتح كما يفتحه المتصفّح: بلا رمز حامل — القدرة هي التوقيع.
      const downloaded = await rawDownload(data.url.replace('/api/v1', base));
      expect(downloaded.status).toBe(200);
      const text = downloaded.text;
      const header = JSON.parse(text.split('\n')[0]!) as { scope: string; tenantId: string };
      expect(header.scope).toBe('tenant');
      expect(header.tenantId).toBe(tenantId);
      const footer = JSON.parse(text.trim().split('\n').pop()!) as {
        complete: boolean;
        skippedTables: string[];
      };
      expect(footer.complete).toBe(true);
      expect(footer.skippedTables).toContain('tenants');
      expect(text).not.toContain('"table":"permissions"');
      // وصفوفُه صفوفه: سطر كل جدول يحمل مستأجره.
      expect(text).toContain(`"tenantId":"${tenantId}"`);
    });

    it('رابط التنزيل: الرمز المنتهي 410، والتوقيع المزوَّر 403', async () => {
      const inOneHour = Math.floor(Date.now() / 1000) + 3600;
      const expired = await platform(
        'get',
        `/platform/backups/${run.id}/content?expires=1&signature=deadbeef`,
      );
      expect(expired.status).toBe(410);
      const forged = await platform(
        'get',
        `/platform/backups/${run.id}/content?expires=${inOneHour}&signature=deadbeef`,
      );
      expect(forged.status).toBe(403);
    });

    it('verify يعيد قراءة الملف ويُطابق البصمة ويُخطّط استعادةً تجريبية', async () => {
      const response = await platform('post', `/platform/backups/${run.id}/verify`);
      expect(response.status).toBe(201);
      const verified = (response.body as { data: PlatformBackupVerifyResult }).data;

      expect(verified.verified, verified.detail ?? '').toBe(true);
      expect(verified.checksum.matches, verified.detail ?? '').toBe(true);
      expect(verified.checksum.actual).toBe(run.checksum);
      expect(verified.totalRows).toBe(run.rows);
      expect(verified.bytes).toBe(run.bytes);
      expect(verified.truncated).toBe(false);
      expect(verified.restore.verdict).toBe('ready');
      expect(verified.restore.missingTables).toEqual([]);
      const names = verified.tables.map((entry) => entry.table);
      expect(names).toContain('users');
      expect(names).toContain('tenants');
      // العدّاد يُقاس: عددُ الجداول في الصفّ = عددُ الجداول التي قرأها التحقّق من الملف.
      expect(names.length).toBe(run.tables);
    });

    it('تغيير بايتٍ واحد في الملف يُفشل التحقّق — والتحقّق يقرأ الملف لا الاستجابة', async () => {
      const stored = (await storedArtifacts()).find((name) => name.includes(run.id));
      expect(stored).toBeDefined();
      const path = join(artifactDir, stored!);
      const original = await readFile(path);

      const tampered = Buffer.from(original);
      tampered[tampered.byteLength - 20] = (tampered[tampered.byteLength - 20] ?? 0) ^ 0xff;
      await writeFile(path, tampered);

      const failed = (await platform('post', `/platform/backups/${run.id}/verify`)).body as {
        data: PlatformBackupVerifyResult;
      };
      expect(failed.data.verified, failed.data.detail ?? '').toBe(false);
      expect(failed.data.checksum.matches).toBe(false);
      expect(failed.data.restore.verdict).toBe('unreadable');
      expect(failed.data.detail).toBeTruthy();

      await writeFile(path, original);
      const passed = (await platform('post', `/platform/backups/${run.id}/verify`)).body as {
        data: PlatformBackupVerifyResult;
      };
      expect(passed.data.verified, passed.data.detail ?? '').toBe(true);
      expect(passed.data.checksum.matches).toBe(true);
    });

    it('verify لمعرّفٍ غير موجود 404', async () => {
      expect(
        (await platform('post', '/platform/backups/11111111-2222-4333-8444-555555555555/verify')).status,
      ).toBe(404);
    });
  });

  // ─────────────────────────────────────────────────────────── التخزين والصيغة

  describe('منفذ التخزين والصيغة', () => {
    it('S3ArtifactStore يرفع WithPUT ويُنزّل بقية البايتات نفسها', async () => {
      const uploaded = new Map<string, Buffer>();
      vi.stubGlobal('fetch', async (url: string | URL, init?: { method?: string; body?: unknown }) => {
        const key = String(url);
        if (init?.method === 'PUT') {
          uploaded.set(key, Buffer.from(init.body as Uint8Array));
          return new Response(null, { status: 200 });
        }
        const body = uploaded.get(key);
        return body === undefined ? new Response(null, { status: 404 }) : new Response(body, { status: 200 });
      });

      const storage = {
        bucket: 'backups',
        isConfigured: () => true,
        presignUpload: (key: string) => ({ url: `mem://${key}`, expiresAt: new Date(), requiredHeaders: {} }),
        presignDownload: (key: string) => ({
          url: `mem://${key}`,
          expiresAt: new Date(),
          requiredHeaders: {},
        }),
        deleteObject: async (key: string) => uploaded.delete(`mem://${key}`),
      };
      const store = new S3ArtifactStore(storage);
      expect(store.isConfigured()).toBe(true);

      const stored = await store.put('backups/k.dump.enc', Buffer.from('hello platform'));
      expect(stored.store).toBe('object-storage');
      expect(stored.bytes).toBeGreaterThan(0);
      expect(uploaded.size).toBe(1);

      const fetched = await store.get('backups/k.dump.enc');
      // المخزن يعيد البايتات المشفّرة كما هي، والفكّ بالمفتاح يعيد النصّ.
      expect(fetched.toString('utf8')).not.toBe('hello platform');
      expect(openArtifact(fetched).toString('utf8')).toBe('hello platform');
      expect(await store.remove('backups/k.dump.enc')).toBe(true);

      vi.unstubAllGlobals();
    });

    it('فشل الرفع يُعلَن (502) ولا يُحوَّل إلى نجاح', async () => {
      vi.stubGlobal('fetch', async () => new Response('nope', { status: 503 }));
      const store = new S3ArtifactStore({
        bucket: 'backups',
        isConfigured: () => true,
        presignUpload: (key: string) => ({ url: `mem://${key}`, expiresAt: new Date(), requiredHeaders: {} }),
        presignDownload: (key: string) => ({
          url: `mem://${key}`,
          expiresAt: new Date(),
          requiredHeaders: {},
        }),
        deleteObject: async () => true,
      });
      await expect(store.put('k', Buffer.from('x'))).rejects.toThrow(/refused the artifact upload/i);
      vi.unstubAllGlobals();
    });

    it('الاختيار يُفضّل التخزين حين يكون مُهيّأً، وإلا فنظام الملفات', () => {
      const configured = {
        name: 'object-storage' as const,
        isConfigured: () => true,
        put: vi.fn(),
        get: vi.fn(),
        remove: vi.fn(),
      };
      const plain = {
        name: 'filesystem' as const,
        isConfigured: () => true,
        put: vi.fn(),
        get: vi.fn(),
        remove: vi.fn(),
      };
      expect(selectArtifactStore(configured, plain).name).toBe('object-storage');
      expect(selectArtifactStore({ ...configured, isConfigured: () => false }, plain).name).toBe(
        'filesystem',
      );
    });

    it('الصيغة: seal/open دورةٌ كاملة، وبايتٌ محوَّل يُرفض بتأكيد GCM', () => {
      const sealed = sealArtifact(Buffer.from('{"kind":"erp-platform-dump"}\n'));
      expect(sealed.checksum).toBe(
        createHash('sha256').update('{"kind":"erp-platform-dump"}\n').digest('hex'),
      );

      // `sealed.body` هو الملف كاملاً: ترويسةٌ ثم مشفّرٌ ثم وسم التأكيد.
      expect(openArtifact(sealed.body).toString('utf8')).toBe('{"kind":"erp-platform-dump"}\n');

      const corrupted = Buffer.from(sealed.body);
      corrupted[corrupted.byteLength - 1] = (corrupted[corrupted.byteLength - 1] ?? 0) ^ 0xff;
      expect(() => openArtifact(corrupted)).toThrow(/authentication tag/i);
      expect(() => openArtifact(Buffer.from('not a backup'))).toThrow(/readable header/i);
    });
  });

  // ─────────────────────────────────────────────────────────── الاحتفاظ

  describe('الاحتفاظ: يُضبط، يُقاس، ويُنفَّذ', () => {
    it('القراءة تُرجع السياسة والعدّادات، ومنعُ المسح النهائي للتدقيق ثابت', async () => {
      const response = await platform('get', '/platform/retention');
      expect(response.status).toBe(200);
      const retention = (response.body as { data: PlatformRetention }).data;
      expect(retention.policy).toEqual({
        auditArchiveDays: 365,
        idempotencyPurgeDays: 30,
        outboxPurgeDays: 90,
        fileOrphanPurgeDays: 2,
        artifactRetentionDays: 30,
      });
      expect(retention.defaults).toEqual(retention.policy);
      expect(retention.auditHardDeleteAllowed).toBe(false);
      expect(retention.purges.auditArchivable).toBeGreaterThanOrEqual(0);
      expect(retention.purges.artifactsExpired).toBe(0);
    });

    it('نافذةٌ خارج الحدود تُرفض 400 ولا تُكتب', async () => {
      expect((await platform('put', '/platform/retention', { idempotencyPurgeDays: 1 })).status).toBe(400);
      expect((await platform('put', '/platform/retention', { auditArchiveDays: 10 })).status).toBe(400);
      const after = await platform('get', '/platform/retention');
      expect((after.body as { data: PlatformRetention }).data.policy.idempotencyPurgeDays).toBe(30);
    });

    it('نافذةٌ صالحة تُحفظ وتُقرأ، ويكتُب لها صفّ تدقيق', async () => {
      const response = await platform('put', '/platform/retention', { outboxPurgeDays: 45 });
      expect(response.status).toBe(200);
      const retention = (response.body as { data: PlatformRetention }).data;
      expect(retention.policy.outboxPurgeDays).toBe(45);
      expect(retention.policy.artifactRetentionDays).toBe(30);
      expect(retention.updatedAt).not.toBeNull();
      expect(retention.updatedBy).toBe(owner.userId);

      const audit = await withPlatformAdminTx(ctx.handle.db, (tx) =>
        tx.execute(
          sql`SELECT count(*)::int AS value FROM audit_log WHERE action = ${backupAuditActions.retentionUpdate}`,
        ),
      );
      expect(Number((audit.rows[0] as { value: number }).value)).toBeGreaterThan(0);

      const reread = (await platform('get', '/platform/retention')).body as { data: PlatformRetention };
      expect(reread.data.policy.outboxPurgeDays).toBe(45);
    });

    it('التطبيق التجريبي يقيس ولا يمسح ولا يحذف ملفاً', async () => {
      const before = (await storedArtifacts()).length;
      const response = await platform('post', '/platform/retention/apply', {
        mode: 'dry_run',
        reason: 'قياس قبل التنفيذ',
      });
      expect(response.status).toBe(201);
      const result = (
        response.body as {
          data: { mode: string; results: Array<{ target: string; objectsRemoved: number }> };
        }
      ).data;
      expect(result.mode).toBe('dry_run');
      expect(result.results.map((entry) => entry.target)).toEqual([
        'artifacts',
        'idempotency',
        'outbox',
        'files',
      ]);
      expect(result.results.every((entry) => entry.objectsRemoved === 0)).toBe(true);
      expect((await storedArtifacts()).length).toBe(before);
    });

    it('التطبيق الفعلي يحذف الملف المنتهي ويُبقي الصفّ موسوماً pruned_at', async () => {
      const run = (await backupRows())[0]!;
      // نسخةٌ أقدم من النافذة: يُعاد تأريخها بدل انتظار ثلاثين يوماً.
      await withPlatformAdminTx(ctx.handle.db, (tx) =>
        tx.execute(
          sql`UPDATE backup_artifacts SET created_at = now() - interval '400 days' WHERE id = ${run.artifactId}`,
        ),
      );

      const response = await platform('post', '/platform/retention/apply', {
        mode: 'apply',
        targets: ['artifacts'],
        reason: 'حذف نسخةٍ منتهية في الاختبار',
      });
      expect(response.status).toBe(201);
      const result = (
        response.body as {
          data: { results: Array<{ target: string; objectsRemoved: number }>; auditId: string | null };
        }
      ).data;
      expect(result.results[0]).toMatchObject({ target: 'artifacts', objectsRemoved: 1 });
      expect(result.auditId).not.toBeNull();

      expect((await storedArtifacts()).filter((name) => name.includes(run.id))).toHaveLength(0);

      const after = (await backupRows()).find((entry) => entry.id === run.id)!;
      expect(after.prunedAt).not.toBeNull();
      // الإيصال يبقى: الحجم والبصمة يُقرآن بعد الحذف.
      expect(after.bytes).toBe(run.bytes);
      expect(after.checksum).toBe(run.checksum);

      expect((await platform('get', `/platform/backups/${run.id}/download`)).status).toBe(410);
    });
  });

  // ─────────────────────────────────────────────────────────── طلبات البيانات

  describe('طلبات البيانات: تصديرٌ ينتج ملفاً، ومحوٌ يُخفي الهوية', () => {
    let exportRequestId: string;

    it('طلبٌ لمستأجرٍ غير موجود 404، وطلبٌ صالح يُنشأ pending ببريده مُطبَّعاً', async () => {
      const missing = await platform('post', '/platform/data-requests', {
        kind: 'export',
        tenantId: '11111111-2222-4333-8444-555555555555',
        subjectEmail: 'nobody@demo.test',
      });
      expect(missing.status).toBe(404);

      const response = await platform('post', '/platform/data-requests', {
        kind: 'export',
        tenantId,
        subjectEmail: subject.email.toUpperCase(),
        note: 'طلب صاحب البيانات',
      });
      expect(response.status).toBe(201);
      const request = (response.body as { data: PlatformDataRequestRow }).data;
      expect(request.status).toBe('pending');
      expect(request.kind).toBe('export');
      expect(request.subjectEmail).toBe(subject.email);
      expect(request.tenantCode).toBe('p-c10-customer');
      exportRequestId = request.id;
    });

    it('التنفيذ قبل القرار 422، والقرار مرّتين 422', async () => {
      expect((await platform('post', `/platform/data-requests/${exportRequestId}/execute`, {})).status).toBe(
        422,
      );

      const decided = await platform('post', `/platform/data-requests/${exportRequestId}/decide`, {
        decision: 'approve',
        reason: 'طلبٌ مشروع من صاحب البيانات',
      });
      expect(decided.status).toBe(201);
      expect((decided.body as { data: PlatformDataRequestRow }).data.status).toBe('approved');

      const again = await platform('post', `/platform/data-requests/${exportRequestId}/decide`, {
        decision: 'reject',
        reason: 'محاولة قرارٍ ثانٍ',
      });
      expect(again.status).toBe(422);
    });

    it('التصدير ينتج ملفاً مشفّراً يُنزَّل بمحتواه الموقّع', async () => {
      const response = await platform('post', `/platform/data-requests/${exportRequestId}/execute`, {});
      expect(response.status).toBe(201);
      const result = (
        response.body as {
          data: {
            export: {
              downloadUrl: string;
              bytes: number;
              checksum: string;
              subjectRef: string;
              totalRows: number;
            };
          };
        }
      ).data.export;
      expect(result.bytes).toBeGreaterThan(0);
      expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(result.subjectRef).toMatch(/^sub_[0-9a-f]{12}$/);
      expect(result.totalRows).toBeGreaterThan(0);

      const downloaded = await rawDownload(result.downloadUrl.replace('/api/v1', base));
      expect(downloaded.status).toBe(200);
      const text = downloaded.text;
      expect(text).toContain('"kind":"erp-data-export"');
      expect(text).toContain(subject.email);
      expect(JSON.parse(text.trim().split('\n').pop()!) as { complete: boolean }).toMatchObject({
        complete: true,
      });

      // ورابط التصدير نفسه لا يُفتح بتوقيعٍ مزوَّر.
      const forged = await rawDownload(
        `${result.downloadUrl.split('&signature=')[0]}&signature=xx`.replace('/api/v1', base),
      );
      expect(forged.status).toBe(403);

      const completed = (await dataRequests('export'))[0]!;
      expect(completed.status).toBe('completed');
      expect(completed.result?.artifactId).not.toBeNull();
      expect(completed.result?.rows).toBe(result.totalRows);
    });

    it('المحو بلا تأكيدٍ أو بتأكيدٍ خاطئ يُرفض 422 — والطلب يبقى approved', async () => {
      const created = await platform('post', '/platform/data-requests', {
        kind: 'erase',
        tenantId,
        subjectEmail: subject.email,
      });
      const request = (created.body as { data: PlatformDataRequestRow }).data;
      await platform('post', `/platform/data-requests/${request.id}/decide`, {
        decision: 'approve',
        reason: 'طلب محوٍ موثّق',
      });

      expect((await platform('post', `/platform/data-requests/${request.id}/execute`, {})).status).toBe(422);
      expect(
        (
          await platform('post', `/platform/data-requests/${request.id}/execute`, {
            confirm: 'other@demo.test',
          })
        ).status,
      ).toBe(422);

      expect((await dataRequests('erase'))[0]!.status).toBe('approved');
      const still = await withPlatformAdminTx(ctx.handle.db, (tx) =>
        tx.execute(sql`SELECT email::text AS email FROM users WHERE id = ${subject.userId}`),
      );
      expect((still.rows[0] as { email: string }).email).toBe(subject.email);
    });

    it('المحو يُخفي الهوية ويسحب العضوية ويُبقي الإيصال ويُبلّغ بعدد صفوف التدقيق', async () => {
      const auditBefore = await withPlatformAdminTx(ctx.handle.db, (tx) =>
        tx.execute(sql`SELECT count(*)::int AS value FROM audit_log`),
      );
      const request = (await dataRequests('erase'))[0]!;

      const response = await platform('post', `/platform/data-requests/${request.id}/execute`, {
        confirm: subject.email,
        reason: 'تنفيذ طلب المحو',
      });
      expect(response.status).toBe(201);
      const erased = (
        response.body as {
          data: {
            erased: {
              anonymisedUsers: number;
              suspendedMemberships: number;
              revokedSessions: number;
              retainedAuditRows: number;
              anonymisedFields: string[];
              subjectRef: string;
            };
          };
        }
      ).data.erased;

      expect(erased.anonymisedUsers).toBe(1);
      expect(erased.suspendedMemberships).toBe(1);
      expect(erased.anonymisedFields).toContain('email');
      expect(erased.anonymisedFields).toContain('full_name');
      expect(erased.subjectRef).toMatch(/^sub_[0-9a-f]{12}$/);

      const user = await withPlatformAdminTx(ctx.handle.db, (tx) =>
        tx.execute(
          sql`SELECT email::text AS email, full_name, phone, password_hash, status FROM users WHERE id = ${subject.userId}`,
        ),
      );
      const row = user.rows[0] as { email: string; full_name: string; phone: string | null; status: string };
      expect(row.email).toMatch(/^erased\+[0-9a-f]{12}@erased\.invalid$/);
      expect(row.full_name).toBe('Erased user');
      expect(row.phone).toBeNull();
      expect(row.status).toBe('suspended');

      const membership = await withTenantTx(ctx.handle.db, tenantId, (tx) =>
        tx.execute(sql`SELECT status FROM memberships WHERE user_id = ${subject.userId}`),
      );
      expect((membership.rows[0] as { status: string }).status).toBe('suspended');

      // الإيصال: صفّ التدقيق يحمل البريد المطلوب — وهو آخر مكانٍ يظهر فيه بعد المحو.
      const receipt = await withPlatformAdminTx(ctx.handle.db, (tx) =>
        tx.execute(
          sql`SELECT before::text || after::text AS raw FROM audit_log
              WHERE action = ${backupAuditActions.dataRequestErase}
              ORDER BY created_at DESC LIMIT 1`,
        ),
      );
      // البريد المطلوب يبقى في `before` (وهو الإيصال)، والهوية المُخفاة في `after`.
      expect((receipt.rows[0] as { raw: string }).raw).toContain(subject.email);
      expect((receipt.rows[0] as { raw: string }).raw).toContain('@erased.invalid');

      // ولا صفّ تدقيقٍ واحد يُحذف: العدد لا ينقص.
      const auditAfter = await withPlatformAdminTx(ctx.handle.db, (tx) =>
        tx.execute(sql`SELECT count(*)::int AS value FROM audit_log`),
      );
      expect(Number((auditAfter.rows[0] as { value: number }).value)).toBeGreaterThanOrEqual(
        Number((auditBefore.rows[0] as { value: number }).value),
      );

      const completed = (await dataRequests('erase'))[0]!;
      expect(completed.status).toBe('completed');
      expect(completed.result?.retainedAuditRows).toBe(erased.retainedAuditRows);
      expect(completed.result?.anonymisedUsers).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────── العقود

  describe('العقود: صيغ المُدخل', () => {
    it('تطبيق الاحتفاظ يحتاج سبباً، ووضعُه الافتراضي تجريبي', () => {
      expect(platformRetentionApplySchema.safeParse({}).success).toBe(false);
      expect(platformRetentionApplySchema.parse({ reason: 'سببٌ مكتوب' }).mode).toBe('dry_run');
    });
  });
});
