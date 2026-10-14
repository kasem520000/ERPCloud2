import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  operationsAuditActions,
  permissionRegistry,
  type PlatformFileRow,
  type PlatformHealth,
  type PlatformJobRow,
  type WorkerHeartbeat,
} from '@erp/contracts';
import { newId, withPlatformAdminTx, withTenantTx } from '@erp/database';

import { createActor, createTenantFixture, type Actor, type ActorOptions } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * P-C9 — «العمليات» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
 *
 * ثلاثة أسئلة، وكلٌّ منها يُقاس من مصدره لا من الشاشة:
 *
 * 1. **الطابور**: صفٌّ معلَّق يُعاد إلى `pending` بلا محاولات، وميتٌ يُوسم `dead` بسببه،
 *    و`published` يُرفض (تنفيذُ ما نُفِّذ مرّتين قرارُ ناشره)، ومهمّةٌ معلَّقة لا تُعاد
 *    (لا معنى لإعادة ما لم يفشل).
 * 2. **الصحة**: المجسّات الستّة موجودة، والقاعدة `up`، وتخزينٌ بلا اعتمادات
 *    `not_configured` **لا** `down` (قرارُ نشرٍ لا عطل)، ولافتة الحادث من إعدادات المنصة.
 * 3. **الملفات**: مديرٌ عابر للمستأجرين، وحكم الفحص يُقرأ من مسار التدقيق الذي كتبه مسار
 *    الرفع (لا عمودٌ ثانٍ يوازيه)، و`scan` يسجّل حكم الماسح المربوط كما خرج، والحجر يوسم
 *    `deleted` **ويُبقي الصفّ**.
 *
 * والحدّ بين من يقرأ ومن يفعل: المدقّق يقرأ الطابور ويرفض فعله (`console.jobs.view` بلا
 * `console.jobs.manage`)، والتشغيل يفعل الاثنين.
 */

type OperatorOptions = ActorOptions & { platformRoles?: readonly string[] };

const everyPermission = permissionRegistry.map((entry) => entry.code);
const createOperator = createActor as (ctx: TestApp, options: OperatorOptions) => Promise<Actor>;

describe('platform operations (P-C9)', () => {
  let ctx: TestApp;
  let owner: Actor;
  let operations: Actor;
  let auditor: Actor;
  let support: Actor;
  let customer: Actor;
  let supportTicketTenantId: string;

  const base = '/api/v1';

  const platform = (method: 'get' | 'post' | 'delete', path: string, body?: unknown, actor: Actor = owner) =>
    api(ctx.server, method, `${base}${path}`, { token: actor.token, body });

  /** صفُّ مهمّة حقيقي في القاعدة: لا mock — الطابور يُقاس كما هو. */
  const seedJob = async (
    tenantId: string,
    overrides: { status?: string; attempts?: number; type?: string; queue?: string; lastError?: string } = {},
  ): Promise<string> => {
    const id = newId();
    await withTenantTx(ctx.handle.db, tenantId, (tx) =>
      tx.execute(sql`
        INSERT INTO outbox_jobs (id, tenant_id, queue, type, payload, status, attempts, last_error, run_at)
        VALUES (${id}, ${tenantId}, ${overrides.queue ?? 'maintenance'}, ${overrides.type ?? 'files.orphan-gc'},
                ${JSON.stringify({ tenantHint: 'x', secretish: 'never-shown' })}::jsonb,
                ${overrides.status ?? 'pending'}, ${overrides.attempts ?? 0}, ${overrides.lastError ?? null}, now())
      `),
    );
    return id;
  };

  const jobRow = async (jobId: string) => {
    const result = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT status, attempts, last_error, processed_at FROM outbox_jobs WHERE id = ${jobId}`),
    );
    return result.rows[0] as {
      status: string;
      attempts: number;
      last_error: string | null;
      processed_at: Date | null;
    };
  };

  const auditActions = async () => {
    const result = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT action, entity, meta FROM audit_log ORDER BY created_at ASC`),
    );
    return result.rows as Array<{ action: string; entity: string; meta: Record<string, unknown> }>;
  };

  /** ملفٌّ حقيقي في القاعدة + حكم فحصٍ في التدقيق — كما يفعل مسار الرفع بالضبط. */
  const seedFile = async (
    tenantId: string,
    verdict: { status: string; scanner: string; detail?: string } | null,
    overrides: { name?: string; status?: string } = {},
  ): Promise<string> => {
    const id = newId();
    await withTenantTx(ctx.handle.db, tenantId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO files (id, tenant_id, bucket, object_key, name, mime, size_bytes, status, entity, entity_id,
                           created_at, updated_at)
        VALUES (${id}, ${tenantId}, 'erp', ${`files/${tenantId}/${id}`}, ${overrides.name ?? 'تقرير.pdf'},
                'application/pdf', 2048, ${overrides.status ?? 'ready'}, NULL, NULL, now(), now())
      `);
      if (verdict) {
        await tx.execute(sql`
          INSERT INTO audit_log (id, tenant_id, action, entity, entity_id, meta, created_at)
          VALUES (${newId()}, ${tenantId}, 'update', 'files', ${id},
                  ${JSON.stringify({ scan: { status: verdict.status, scanner: verdict.scanner, detail: verdict.detail ?? 'from-test' } })}::jsonb,
                  now())
        `);
      }
    });
    return id;
  };

  beforeAll(async () => {
    ctx = await createTestApp('platform-operations');

    await createTenantFixture(ctx.db.ownerUrl, {
      code: 'platform',
      name: 'منشأة المشغّلين',
      status: 'active',
    });

    owner = await createOperator(ctx, {
      tenantCode: 'ops-console',
      email: 'owner@ops-console.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_owner'],
    });
    operations = await createOperator(ctx, {
      tenantCode: 'ops-console',
      email: 'ops@ops-console.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_operations'],
    });
    auditor = await createOperator(ctx, {
      tenantCode: 'ops-console',
      email: 'auditor@ops-console.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_auditor'],
    });
    // دورٌ منصّي آخر لا يملك `console.jobs.manage` ولا `console.health.view`.
    support = await createOperator(ctx, {
      tenantCode: 'ops-console',
      email: 'support@ops-console.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_support'],
    });

    customer = await createActor(ctx, {
      tenantCode: 'ops-a',
      tenantName: 'شركة العميل',
      email: 'owner@ops-a.test',
      permissions: everyPermission,
      roleNames: ['Admin'],
      isOwner: true,
    });
    supportTicketTenantId = customer.tenantId;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ─────────────────────────────────────────────────────────── الطابور

  it('يعيد المهمّة الميتة إلى الطابور بلا محاولاتٍ ولا خطأ — ويُدقّق السبب', async () => {
    const jobId = await seedJob(customer.tenantId, {
      status: 'dead',
      attempts: 3,
      lastError: 'SMTP refused',
    });

    const response = await platform('post', `/platform/jobs/${jobId}/retry`, { reason: 'المزوّد عاد للعمل' });
    expect(response.status).toBe(201);
    const row = response.body.data as PlatformJobRow;
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBeNull();
    expect(row.processedAt).toBeNull();
    expect(row.tenantCode).toBe('ops-a');
    // الحمولة لا تُعرض على اللوحة: أسماء الحقول فقط.
    expect(row.payloadKeys.sort()).toEqual(['secretish', 'tenantHint']);
    expect(JSON.stringify(row)).not.toContain('never-shown');

    const stored = await jobRow(jobId);
    expect(stored.status).toBe('pending');
    expect(stored.attempts).toBe(0);
    expect(stored.last_error).toBeNull();

    const audit = await auditActions();
    const entry = audit.filter((row) => row.action === operationsAuditActions.jobRetry).at(-1);
    expect(entry?.entity).toBe('outbox_jobs');
    expect(entry?.meta.reason).toBe('المزوّد عاد للعمل');
  });

  it('يلغي المهمّة فيوسمها dead بسببه ولا يحذف صفّها', async () => {
    const jobId = await seedJob(customer.tenantId, { status: 'pending', attempts: 1 });

    const response = await platform('post', `/platform/jobs/${jobId}/cancel`, {
      reason: 'عميلٌ أُلغي اشتراكه',
    });
    expect(response.status).toBe(201);
    const row = response.body.data as PlatformJobRow;
    expect(row.status).toBe('dead');
    expect(row.processedAt).not.toBeNull();
    expect(row.lastError).toContain('عميلٌ أُلغي اشتراكه');

    // الصفّ باقٍ (لا حذف): الإلغاء قرارٌ يُقرأ لاحقاً لا أثرٌ يُمحى.
    const stored = await jobRow(jobId);
    expect(stored.status).toBe('dead');
    expect(stored.processed_at).not.toBeNull();
  });

  it('يرفض إعادة مهمّة نُفِّذت، وإعادة مهمّةٍ معلَّقة بلا سبب', async () => {
    const published = await seedJob(customer.tenantId, { status: 'published' });
    const refused = await platform('post', `/platform/jobs/${published}/retry`, { reason: 'أعيدوها لأرى' });
    expect(refused.status).toBe(422);

    const pending = await seedJob(customer.tenantId, { status: 'pending' });
    expect(
      (await platform('post', `/platform/jobs/${pending}/retry`, { reason: 'إعادة بلا سبب' })).status,
    ).toBe(422);
    // سببٌ قصير لا يُقبل: الفعل يغيّر ما سيراه العميل، فلا بدّ من كلمةٍ تُفسّره.
    expect((await platform('post', `/platform/jobs/${pending}/cancel`, { reason: 'لا' })).status).toBe(400);
    expect(
      (await platform('post', `/platform/jobs/${newId()}/retry`, { reason: 'مهمّةٌ لا وجود لها' })).status,
    ).toBe(404);
  });

  it('يفهرس الطابور بالحالة والعميل والنوع — ويرفض مرشِّحاً خارج الفهرس', async () => {
    await seedJob(customer.tenantId, { status: 'dead', type: 'email.send' });
    const byStatus = await platform(
      'get',
      `/platform/jobs?filter[status]=dead&filter[tenantId]=${customer.tenantId}&filter[type]=email.send&limit=200`,
    );
    expect(byStatus.status).toBe(200);
    const rows = (byStatus.body as { data: PlatformJobRow[] }).data;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((row) => row.status === 'dead' && row.type === 'email.send')).toBe(true);
    expect(rows.every((row) => row.tenantId === customer.tenantId)).toBe(true);

    expect((await platform('get', '/platform/jobs?filter[status=dead')).status).toBe(400);
    expect((await platform('get', '/platform/jobs?filter[status]=exploded')).status).toBe(400);
    expect((await platform('get', '/platform/jobs?filter[subject]=x')).status).toBe(400);
  });

  it('يقرأ نبض العامل من الطابور: أقدم معلَّقة تُقاس لا تُوصف', async () => {
    const heartbeat = await platform('get', '/platform/jobs/heartbeat');
    expect(heartbeat.status).toBe(200);
    const data = (heartbeat.body as { data: WorkerHeartbeat }).data;
    // `WORKER=0` في الاختبارات: الحقل يقول ذلك بصراحة بدل أن يُخفي الحقيقة.
    expect(typeof data.running).toBe('boolean');
    expect(typeof data.enabled).toBe('boolean');
    expect(data.oldestPendingAgeSeconds === null || data.oldestPendingAgeSeconds >= 0).toBe(true);
  });

  // ─────────────────────────────────────────────────────────── الصحة

  it('يقدّم ستّ مجسّات، ولا يسمّي «غير المهيّأ» عطلاً', async () => {
    const response = await platform('get', '/platform/health/detailed');
    expect(response.status).toBe(200);
    const health = (response.body as { data: PlatformHealth }).data;

    expect(health.probes.map((probe) => probe.name).sort()).toEqual([
      'database',
      'email',
      'queue',
      'redis',
      'storage',
      'worker',
    ]);
    const database = health.probes.find((probe) => probe.name === 'database');
    expect(database?.status).toBe('up');
    expect(database?.latencyMs).toBeGreaterThanOrEqual(0);

    // تخزينٌ بلا اعتمادات قرارُ نشر: `not_configured` لا `down` — وإلا لأعلنت كل بيئة تطوير
    // حادثةً كاذبة أسقطت الشاشة كلها إلى `down`.
    const storage = health.probes.find((probe) => probe.name === 'storage');
    expect(['up', 'not_configured']).toContain(storage?.status);
    expect(health.probes.some((probe) => probe.status === 'down')).toBe(health.status === 'down');

    expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(health.requests.count).toBeGreaterThan(0);
    expect(health.requests.errorRate).toBeGreaterThanOrEqual(0);
    expect(health.requests.errorRate).toBeLessThanOrEqual(1);
    expect(health.requests.p95Ms).toBeGreaterThanOrEqual(0);
    expect(health.backlog.pending + health.backlog.published + health.backlog.dead).toBeGreaterThan(0);
    expect(health.incident.active).toBe(false);
  });

  it('لافتة الحادث من إعدادات المنصة — لا نصٌّ في الشاشة', async () => {
    const written = await platform('put', '/platform/settings', {
      values: { 'platform.maintenance': true, 'platform.maintenance_message': 'ترقية قاعدة البيانات' },
    });
    if (written.status !== 200) {
      // الواجهة تسمح بالكتابة للمالك؛ وإن غابت الكتابة فالحقل يبقى مقروءاً.
      expect([200, 403]).toContain(written.status);
    }
    try {
      const health = (await platform('get', '/platform/health/detailed')).body.data as PlatformHealth;
      expect(health.incident.active).toBe(true);
      expect(health.incident.message).toBe('ترقية قاعدة البيانات');
    } finally {
      await platform('put', '/platform/settings', {
        values: { 'platform.maintenance': false, 'platform.maintenance_message': '' },
      });
    }
  });

  // ─────────────────────────────────────────────────────────── الملفات

  it('يعرض الملفات عبر المستأجرين بحكم الفحص المقروء من التدقيق', async () => {
    const clean = await seedFile(
      customer.tenantId,
      { status: 'clean', scanner: 'clamav-stub' },
      { name: 'كشف-حساب.pdf' },
    );
    const skipped = await seedFile(customer.tenantId, {
      status: 'skipped',
      scanner: 'noop',
      detail: 'no scanner configured',
    });
    const unscanned = await seedFile(customer.tenantId, null, { name: 'بلا-فحص.png' });

    const all = await platform('get', `/platform/files?filter[tenantId]=${customer.tenantId}&limit=200`);
    expect(all.status).toBe(200);
    const rows = (all.body as { data: PlatformFileRow[] }).data;
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(clean)?.scan?.verdict).toBe('clean');
    expect(byId.get(clean)?.scan?.scanner).toBe('clamav-stub');
    expect(byId.get(skipped)?.scan?.verdict).toBe('skipped');
    // لا حكم = لا فحص. الشاشة تقول «لم يُفحص» ولا تكتب «نظيف» نيابةً عن ماسحٍ لم يعمل.
    expect(byId.get(unscanned)?.scan).toBeNull();
    expect(byId.get(clean)?.tenantCode).toBe('ops-a');

    const cleanOnly = await platform(
      'get',
      `/platform/files?filter[tenantId]=${customer.tenantId}&filter[scan]=clean`,
    );
    const cleanRows = (cleanOnly.body as { data: PlatformFileRow[] }).data;
    expect(cleanRows.every((row) => row.scan?.verdict === 'clean')).toBe(true);

    const noneOnly = await platform(
      'get',
      `/platform/files?filter[tenantId]=${customer.tenantId}&filter[scan]=none`,
    );
    const noneRows = (noneOnly.body as { data: PlatformFileRow[] }).data;
    expect(noneRows.every((row) => row.scan === null)).toBe(true);
    expect(noneRows.some((row) => row.id === unscanned)).toBe(true);

    const byName = await platform('get', `/platform/files?filter[tenantId]=${customer.tenantId}&q=كشف`);
    expect((byName.body as { data: PlatformFileRow[] }).data.every((row) => row.name.includes('كشف'))).toBe(
      true,
    );

    expect((await platform('get', '/platform/files?filter[scan]=maybe')).status).toBe(400);
    expect((await platform('get', '/platform/files?filter[bucket]=erp')).status).toBe(400);
  });

  it('يفحص الآن ويسجّل حكم الماسح كما خرج — بلا تجميل', async () => {
    const fileId = await seedFile(customer.tenantId, null, { name: 'يفحص-الآن.txt' });

    const response = await platform('post', `/platform/files/${fileId}/scan`, {});
    expect(response.status).toBe(201);
    const result = response.body.data as { verdict: string; scanner: string; detail: string | null };
    // الماسح المربوط في هذا المستودع لا يفعل شيئاً، فيقول `skipped` — وهذا هو الصدق المطلوب.
    expect(result.verdict).toBe('skipped');
    expect(result.scanner).toBe('noop');

    const listed = await platform('get', `/platform/files?filter[tenantId]=${customer.tenantId}&q=يفحص-الآن`);
    const row = (listed.body as { data: PlatformFileRow[] }).data[0];
    expect(row.scan?.verdict).toBe('skipped');

    const audit = await auditActions();
    expect(
      audit.filter((entry) => entry.action === operationsAuditActions.fileScan).length,
    ).toBeGreaterThanOrEqual(1);
    expect((await platform('post', `/platform/files/${newId()}/scan`, {})).status).toBe(404);
  });

  it('يحجر الملف فيوسمه deleted ويُبقي صفّه وميتاداتاه', async () => {
    const fileId = await seedFile(customer.tenantId, { status: 'clean', scanner: 'clamav-stub' });

    const response = await platform('delete', `/platform/files/${fileId}`, { reason: 'محتوى مشتبه به' });
    expect(response.status).toBe(200);
    expect((response.body.data as PlatformFileRow).status).toBe('deleted');
    expect((response.body.data as PlatformFileRow).deletedAt).not.toBeNull();

    const stored = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT status, deleted_at, name FROM files WHERE id = ${fileId}`),
    );
    const row = stored.rows[0] as { status: string; deleted_at: Date | null; name: string };
    expect(row.status).toBe('deleted');
    expect(row.deleted_at).not.toBeNull();
    expect(row.name).toBe('تقرير.pdf');

    // مرّةٌ ثانية: الصفّ محجورٌ أصلاً — 422 لا نجاحٌ كاذب.
    expect((await platform('delete', `/platform/files/${fileId}`, { reason: 'مرّةٌ أخرى' })).status).toBe(
      422,
    );
    expect((await platform('delete', `/platform/files/${newId()}`, { reason: 'لا وجود له' })).status).toBe(
      404,
    );
    expect((await platform('delete', `/platform/files/${fileId}`, { reason: 'لا' })).status).toBe(400);
  });

  // ─────────────────────────────────────────────────────────── الحدود

  it('يفصل القراءة عن الفعل: المدقّق يرى الطابور ولا يُعيده', async () => {
    const jobId = await seedJob(customer.tenantId, { status: 'dead', attempts: 2 });

    expect((await platform('get', '/platform/jobs', undefined, auditor)).status).toBe(200);
    expect((await platform('get', '/platform/health/detailed', undefined, auditor)).status).toBe(200);
    // مدقّقٌ يملك `console.jobs.view` ولا يملك `console.jobs.manage`.
    const refused = await platform('post', `/platform/jobs/${jobId}/retry`, { reason: 'أعيدوها' }, auditor);
    expect(refused.status).toBe(403);
    expect(refused.body?.errors?.[0]?.code ?? refused.body?.code).toContain('FORBIDDEN');

    // التشغيل يفعل الاثنين.
    expect((await platform('get', '/platform/jobs', undefined, operations)).status).toBe(200);
    expect(
      (await platform('post', `/platform/jobs/${jobId}/retry`, { reason: 'التشغيل أعادها' }, operations))
        .status,
    ).toBe(201);

    // ودورُ الدعم **يقرأ الصحة** (يحمل `console.health.view` — فحصُ «هل الخلل عندنا أم
    // عند العميل؟» جزءٌ من عمله) ولا يرى الطابور ولا الملفات ولا يفعل شيئاً.
    expect((await platform('get', '/platform/health/detailed', undefined, support)).status).toBe(200);
    expect((await platform('get', '/platform/jobs', undefined, support)).status).toBe(403);
    expect((await platform('get', '/platform/files', undefined, support)).status).toBe(403);

    // وبلا رمز: 401 — ولا فرق بين مسار قراءةٍ ومسار فعل.
    expect((await api(ctx.server, 'get', `${base}/platform/jobs`, {})).status).toBe(401);
    expect(
      (await api(ctx.server, 'post', `${base}/platform/jobs/${jobId}/retry`, { body: { reason: 'بلا رمز' } }))
        .status,
    ).toBe(401);
    // وجلسة عميل عادية لا تعبر إلى سطح المنصة.
    expect(
      (await api(ctx.server, 'get', `${base}/platform/health/detailed`, { token: customer.token })).status,
    ).toBe(403);
    expect((await api(ctx.server, 'get', `${base}/platform/jobs`, { token: customer.token })).status).toBe(
      403,
    );
  });

  it('يُبقي تذاكر الدعم خارج هذا السطح — جزءٌ واحد لا يلمس جزءاً آخر', async () => {
    // وجود تذكرةٍ في القاعدة لا يمنع شيئاً هنا، وغياب كود الدعم لا يعطّل العمليات.
    const listed = await platform('get', `/platform/tickets?filter[tenantId]=${supportTicketTenantId}`);
    // مالك المنصة يملك `console.support.manage` أيضاً، فالمسار قائم — والغرض إثبات أن
    // الوحدتين متجاورتان بلا تداخلٍ في الترتيب أو التهيئة.
    expect([200, 403]).toContain(listed.status);
    expect((await platform('get', '/platform/jobs')).status).toBe(200);
  });
});
