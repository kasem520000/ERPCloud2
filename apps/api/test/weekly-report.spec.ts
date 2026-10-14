import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { jobTypes, weeklyWindow, type WeeklyReportPreview, type WeeklyReportRunResult } from '@erp/contracts';
import { withPlatformAdminTx } from '@erp/database';

import { windowLabel } from '../src/modules/weekly-report/weekly-report.service.js';
import { JobHandlerRegistry } from '../src/modules/platform-services/jobs/job-handlers.js';
import { WeeklyReportScheduler } from '../src/modules/weekly-report/weekly-report.scheduler.js';
import { WeeklyReportService } from '../src/modules/weekly-report/weekly-report.service.js';

import {
  ALL_TENANT_PERMISSIONS,
  createActor,
  createTenantFixture,
  type Actor,
  type ActorOptions,
} from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * التقرير الأسبوعي بالبريد — التسليم الدوري المؤجَّل من P-C12
 * (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4 و§5).
 *
 * هذه السبيكة تقيس **التسليم** لا الحساب: الأرقام مصدرها `PlatformAnalyticsService` ويقيسها
 * `platform-analytics.spec.ts`؛ وهنا يُقاس أن التقرير:
 *
 * 1. **يُعرَض قبل أن يُرسل**: نافذة الأسبوع المنقضي، والموعد القادم، والمتغيّرات كما ستُصيَّر.
 * 2. **يُنظَّم من الإعدادات**: تشغيلٌ وإيقاف، وعناوين تُنقّى وتُزال تكرارها، ويومٌ وساعة.
 * 3. **يُجدوَل**: نبضة المجدول لا تفعل شيئاً في غير وقتها، وتُرسل مرّة واحدة في وقتها.
 * 4. **لا يُكرَّر**: نبضةٌ ثانية في الساعة نفسها لا تُرسل، والدليل صفّ البريد لا عمود حالة.
 * 5. **يُقاوَم فشلُ مستلمٍ**: الحجر على عنوانٍ يُسجَّل في نتيجته ولا يُسقط بقيّة العناوين.
 * 6. **يُشغَّل يدوياً**: لعنوانٍ واحد بلا مسّ القائمة، وبتجاوز الحجر عند الطلب.
 * 7. **ويُحرَس برمزين**: المعاينة بـ`console.analytics.view` والتشغيل بـ`console.email.manage`.
 */

type OperatorOptions = ActorOptions & { platformRoles?: readonly string[] };
const createOperator = createActor as (ctx: TestApp, options: OperatorOptions) => Promise<Actor>;

describe('weekly platform report (P-C12 deferred delivery)', () => {
  let ctx: TestApp;
  let owner: Actor;
  /** يقرأ التحليلات ولا يرسل بريداً: `platform_auditor`. */
  let auditor: Actor;
  /** لا هذا ولا ذاك: `platform_support` بلا `analytics.view` وبلا `email.manage`. */
  let support: Actor;
  let tenantOwner: Actor;

  const base = '/api/v1';
  /** لحظة ثابتة داخل الأسبوع: الأربعاء 2026-09-16 — والنافذة 2026-09-06 → 2026-09-12. */
  const wednesday = new Date('2026-09-16T07:05:00.000Z');

  const get = (path: string, actor: Actor = owner) =>
    api(ctx.server, 'get', `${base}${path}`, { token: actor.token });
  const post = (path: string, body: unknown, actor: Actor = owner) =>
    api(ctx.server, 'post', `${base}${path}`, { token: actor.token, body });
  const put = (path: string, body: unknown, actor: Actor = owner) =>
    api(ctx.server, 'put', `${base}${path}`, { token: actor.token, body });

  /**
   * كتابة الإعداد الأربعة — كاتبُها الوحيد في السبيك، وتتحقّق من نجاحها: كتابةُ إعداد
   * ترفضها المدقّقة (422) لو صامتت لظنّ السبيك أنه ضبط وهو لم يضبط (`select` يأخذ نصّاً لا رقماً).
   */
  const configure = async (values: Record<string, unknown>) => {
    const response = await put('/platform/settings', { values });
    expect(response.status).toBe(200);
    return response;
  };

  const messages = () =>
    withPlatformAdminTx(ctx.handle.db, async (tx) => {
      const result = await tx.execute(sql`
        SELECT event, tenant_id, to_email, locale, subject, body, status
          FROM email_messages
         WHERE event = 'report.weekly'
         ORDER BY created_at ASC
      `);
      return result.rows as unknown as Array<{
        event: string;
        tenant_id: string | null;
        to_email: string;
        locale: string;
        subject: string;
        body: string;
        status: string;
      }>;
    });

  const tick = async (now: Date, catchUp = false) => {
    const scheduler = ctx.app.get(WeeklyReportScheduler);
    return scheduler.tick(now, catchUp);
  };

  beforeAll(async () => {
    ctx = await createTestApp('weekly-report');

    // منشأة المشغّلين: صفّ الإعدادات ورسائل المنصة تُكتب في سياقٍ لا يخصّ عميلاً.
    await createTenantFixture(ctx.db.ownerUrl, {
      code: process.env.PLATFORM_TENANT_CODE ?? 'platform',
      name: 'منشأة المشغّلين',
      status: 'active',
    });

    owner = await createOperator(ctx, {
      tenantCode: 'report-ops',
      email: 'owner@report-ops.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_owner'],
    });
    auditor = await createOperator(ctx, {
      tenantCode: 'report-ops',
      email: 'auditor@report-ops.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_auditor'],
    });
    support = await createOperator(ctx, {
      tenantCode: 'report-ops',
      email: 'support@report-ops.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_support'],
    });
    tenantOwner = await createActor(ctx, {
      tenantCode: 'report-customer',
      tenantName: 'شركة العميل',
      email: 'owner@report-customer.test',
      permissions: ALL_TENANT_PERMISSIONS,
      roleNames: ['Admin'],
      isOwner: true,
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ═══════════════════════════════════════════════ 1. المعاينة قبل الإرسال

  it('يعرض النافذة المنقضية والموعد القادم قبل أن يُشغَّل التقرير', async () => {
    await configure({
      'report.weekly_enabled': false,
      'report.weekly_recipients': '',
      'report.weekly_day': '0',
      'report.weekly_hour': 7,
    });

    const response = await get('/platform/reports/weekly');
    expect(response.status).toBe(200);
    const preview = response.body.data as WeeklyReportPreview;

    // النافذة أسبوعٌ **منقضٍ** — تُحسب من اللحظة الحقيقية كما يحسبها الخادم (المعاينة
    // لا تقبل تاريخاً)، فلا تُثبَّت على أسبوعٍ بعينه: اختبارٌ يقول «2026-09-06 → 2026-09-12»
    // يمرّ أسبوعاً ثم يسقط الذي يليه. ويُقبل أحد طرفي اللحظة (قبل النداء وبعده) لأن
    // منتصف ليلة الأحد يبدّل النافذة بين السطرين.
    const before = weeklyWindow(new Date());
    const after = weeklyWindow(new Date());
    expect([before.start.toISOString(), after.start.toISOString()]).toContain(preview.window.start);
    expect([before.end.toISOString(), after.end.toISOString()]).toContain(preview.window.end);
    const window = preview.window.start === after.start.toISOString() ? after : before;
    // أسبوعٌ كامل: سبعة أيام بالضبط، ونهايته لحظةٌ منقضية لا مستقبلية.
    expect(new Date(preview.window.end).getTime() - new Date(preview.window.start).getTime()).toBe(
      7 * 24 * 60 * 60 * 1000,
    );
    expect(new Date(preview.window.end).getTime()).toBeLessThanOrEqual(Date.now());
    expect(preview.window.label).toMatch(/^\d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2}$/);
    expect(preview.window.label).toBe(windowLabel(window.start, window.end));

    expect(preview.enabled).toBe(false);
    expect(preview.recipients).toEqual([]);
    expect(preview.pending).toEqual([]);
    expect(preview.sentTo).toEqual([]);
    // الرابط مبنيّ على `CONSOLE_PUBLIC_URL` إن كان مُعدّاً، وإلا بقي نسبيّاً — لا رابطٌ ميت.
    expect(preview.link.endsWith('/analytics')).toBe(true);
    expect(preview.schedule).toMatchObject({ day: 0, dayLabelAr: 'الأحد', hour: 7, timezone: 'server' });
    expect(new Date(preview.schedule.nextRunAt).getTime()).toBeGreaterThan(Date.now());

    // المتغيّرات كما ستُصيَّر: أرقام التحليلات نفسها، ونصوصٌ لا `undefined`.
    expect(preview.variables.week).toBe(windowLabel(window.start, window.end));
    expect(Number(preview.variables.tenants)).toBeGreaterThanOrEqual(1);
    expect(preview.variables.mrr).toMatch(/^\d+\.\d{2}$/);
    expect(preview.variables.alerts.length).toBeGreaterThan(0);
  });

  it('يقرأ التشغيل واليوم والساعة والعناوين من إعدادات المنصة، وينقّي القائمة', async () => {
    await configure({
      'report.weekly_enabled': true,
      'report.weekly_recipients': ' Ops@Platform.test , ops@platform.test, ليست-عنواناً ',
      'report.weekly_day': '3',
      'report.weekly_hour': 7,
    });

    const preview = (await get('/platform/reports/weekly')).body.data as WeeklyReportPreview;
    expect(preview.enabled).toBe(true);
    // العنوان المكرّر مرّةً واحدة، وغيرُ الصالح لا يدخل، والحروف تُوحَّد.
    expect(preview.recipients).toEqual(['ops@platform.test']);
    expect(preview.pending).toEqual(['ops@platform.test']);
    expect(preview.schedule).toMatchObject({ day: 3, dayLabelAr: 'الأربعاء', hour: 7 });
  });

  // ═══════════════════════════════════════════════ 2. الجدولة

  it('لا يرسل في غير وقته', async () => {
    const nine = new Date('2026-09-16T09:30:00.000Z');
    const result = await tick(nine);
    expect(result).toEqual({ due: false, sent: 0, skipped: 0, failed: 0 });
    expect(await messages()).toHaveLength(0);
  });

  it('يرسل في وقته مرّةً واحدة لكل عنوان، برسالةٍ من قالب الحدث', async () => {
    await configure({
      'report.weekly_recipients': 'ops@platform.test, cfo@platform.test',
    });

    const result = await tick(wednesday);
    expect(result.due).toBe(true);
    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);

    const rows = await messages();
    expect(rows.map((row) => row.to_email).sort()).toEqual(['cfo@platform.test', 'ops@platform.test']);
    for (const row of rows) {
      // تقرير المنصة لا يخصّ عميلاً: بلا `tenant_id` لا يُحتسب على حصّة أحد.
      expect(row.tenant_id).toBeNull();
      expect(row.locale).toBe('ar');
      expect(row.subject).toContain('2026-09-06');
      expect(row.body).toContain('2026-09-06');
      expect(row.status).toBe('sent');
    }
  });

  it('لا يكرّر الإرسال في النبضة نفسها — الدليل صفّ البريد', async () => {
    const second = await tick(wednesday);
    expect(second).toEqual({ due: true, sent: 0, skipped: 2, failed: 0 });
    expect(await messages()).toHaveLength(2);
  });

  it('لحاق الإقلاع: الموعد مرّ ⇒ يشتغل، والحجر يمنع أن يصير إرسالاً ثانياً', async () => {
    const report = ctx.app.get(WeeklyReportService);

    // جدولٌ الأربعاء 07:00 — والنافذة تُغلق صبيحة الأحد.
    const wednesdayAt = (hour: number, minute: number) => new Date(2026, 8, 16, hour, minute);
    expect(report.isDueSinceStartup(wednesdayAt(9, 20), 3, 7)).toBe(true);
    // وقبل الساعة بساعة ⇒ لا إرسال مبكر: الموعد لم يمرّ بعد.
    expect(report.isDueSinceStartup(wednesdayAt(6, 20), 3, 7)).toBe(false);
    // والموعد يخصّ نافذةً واحدة: الاثنين 09:00 ينتظر أربعاء الأسبوع التالي لا أربعاء الماضي.
    expect(report.isDueSinceStartup(new Date(2026, 8, 21, 9, 0), 3, 7)).toBe(false);
    // وأربعاء الأسبوع التالي بعد ساعته ⇒ نافذته مرّ موعدها.
    expect(report.isDueSinceStartup(new Date(2026, 8, 23, 7, 30), 3, 7)).toBe(true);
    expect(
      report.occurrenceForWindow(new Date(2026, 8, 20, 0, 0), 3, 7).getTime(),
    ).toBe(new Date(2026, 8, 23, 7, 0).getTime());

    // والحجر يعمل: النافذة الجارية لها رسالتان أصلاً، فاللحاق يعدّهما تخطّياً لا إرسالاً.
    const before = (await messages()).length;
    const catchUp = await tick(new Date(2026, 8, 17, 9, 20), true);
    expect(catchUp.due).toBe(true);
    expect(catchUp.sent).toBe(0);
    expect(catchUp.skipped).toBe(2);
    expect(await messages()).toHaveLength(before);

    // والنبضة العادية في غير الساعة لا تُشغل شيئاً — ومنها الساعات التي كانت سترسل ثانيةً.
    expect(await tick(new Date(2026, 8, 17, 9, 20))).toEqual({
      due: false,
      sent: 0,
      skipped: 0,
      failed: 0,
    });
  });

  // ═══════════════════════════════════════════════ 3. تشغيلٌ يدوي

  it('يرسل لعنوان تجربةٍ وحده دون مسّ قائمة المستلمين', async () => {
    const response = await post('/platform/reports/weekly/run', { to: ['trial@platform.test'] });
    expect(response.status).toBe(201);
    const result = response.body.data as WeeklyReportRunResult;
    expect(result.sentCount).toBe(1);
    expect(result.outcomes).toEqual([
      { to: 'trial@platform.test', messageId: expect.any(String), status: 'sent', detail: null },
    ]);
    expect((await messages()).map((row) => row.to_email)).toContain('trial@platform.test');

    // والقائمة المضبوطة لم تُمسّ: العنوانان الأولان بلا رسالةٍ ثانية.
    const preview = (await get('/platform/reports/weekly')).body.data as WeeklyReportPreview;
    expect(preview.recipients).toEqual(['ops@platform.test', 'cfo@platform.test']);
    // `sentTo` يعدّ كل من له رسالةٌ في النافذة — وعنوان التجربة منها — والمعلَّق هو الطرح.
    expect(preview.sentTo).toEqual(expect.arrayContaining(['cfo@platform.test', 'ops@platform.test', 'trial@platform.test']));
    expect(preview.pending).toEqual([]);
  });

  it('يعيد الإرسال بتجاوزٍ صريح، ويرفض عنواناً غير صالح', async () => {
    const opsBefore = (await messages()).filter((row) => row.to_email === 'ops@platform.test').length;
    const forced = await post('/platform/reports/weekly/run', {
      to: ['ops@platform.test'],
      force: true,
    });
    expect(forced.status).toBe(201);
    expect((forced.body.data as WeeklyReportRunResult).sentCount).toBe(1);
    expect((await messages()).filter((row) => row.to_email === 'ops@platform.test')).toHaveLength(opsBefore + 1);

    const invalid = await post('/platform/reports/weekly/run', { to: ['ليست-عنواناً'] });
    expect(invalid.status).toBe(400);
  });

  it('يحجر على عنوانٍ محجوب في نتيجته ولا يُسقط بقيّة العناوين', async () => {
    await withPlatformAdminTx(ctx.handle.db, async (tx) => {
      await tx.execute(sql`
        INSERT INTO email_suppressions (id, tenant_id, email, reason, note)
        VALUES (gen_random_uuid(), NULL, 'blocked@platform.test', 'manual', 'سبيك التقرير الأسبوعي')
      `);
    });

    const response = await post('/platform/reports/weekly/run', {
      to: ['blocked@platform.test', 'ok@platform.test'],
    });
    const result = response.body.data as WeeklyReportRunResult;
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes[0]).toMatchObject({ to: 'blocked@platform.test', status: 'skipped' });
    expect(result.outcomes[0]?.detail).toContain('محجوب');
    expect(result.outcomes[1]).toMatchObject({ to: 'ok@platform.test', status: 'sent' });
    expect(result.sentCount).toBe(1);
  });

  it('لا يرسل شيئاً حين تُفرَّغ قائمة العناوين', async () => {
    await configure({ 'report.weekly_recipients': '' });
    const before = (await messages()).length;

    // الوقت وقتُه، لكن لا مستلم: النبضة تُعلن أنها كانت مستحقّة وأنها لم ترسل شيئاً.
    const result = await tick(new Date('2026-09-16T07:05:00.000Z'));
    expect(result).toEqual({ due: true, sent: 0, skipped: 0, failed: 0 });

    const manual = await post('/platform/reports/weekly/run', {});
    expect(manual.status).toBe(201);
    const emptied = manual.body.data as WeeklyReportRunResult;
    expect(emptied.outcomes).toEqual([]);
    expect(emptied.sentCount).toBe(0);
    // ولم تُكتب رسالةٌ جديدة: القائمة الفارغة تعني «لا تقرير» لا «أرسل إلى أحد».
    expect(await messages()).toHaveLength(before);
  });

  it('يتوقّف بتعطيل المفتاح ولو كان اليوم والساعة هما هما', async () => {
    await configure({
      'report.weekly_enabled': false,
      'report.weekly_recipients': 'ops@platform.test',
    });
    const result = await tick(wednesday);
    expect(result.due).toBe(false);
  });

  // ═══════════════════════════════════════════════ 4. التسجيل والصلاحيات

  it('يسجّل معالجه على طابور الصيانة', () => {
    const registry = ctx.app.get(JobHandlerRegistry);
    expect(registry.handlerFor('maintenance', jobTypes.REPORT_WEEKLY)).toBeTypeOf('function');
  });

  it('يحرس رمزاه: المعاينة للقراءة والتشغيل لإدارة البريد', async () => {
    await configure({ 'report.weekly_enabled': true, 'report.weekly_recipients': 'ops@platform.test' });

    // مدقّق المنصة يقرأ التحليلات ولا يرسل بريداً.
    expect((await get('/platform/reports/weekly', auditor)).status).toBe(200);
    expect((await post('/platform/reports/weekly/run', {}, auditor)).status).toBe(403);

    // الدعم لا يقرأ التحليلات ولا يرسل.
    expect((await get('/platform/reports/weekly', support)).status).toBe(403);
    expect((await post('/platform/reports/weekly/run', {}, support)).status).toBe(403);

    // وسطح العميل لا يعرف المسار أصلاً.
    expect((await get('/platform/reports/weekly', tenantOwner)).status).toBe(403);
    expect((await post('/platform/reports/weekly/run', {}, tenantOwner)).status).toBe(403);
  });
});
