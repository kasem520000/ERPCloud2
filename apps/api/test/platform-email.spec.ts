import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  emailEventRegistry,
  emailTemplateSeeds,
  type EmailSettings,
  type EmailTemplate,
  type EmailTemplateListResponse,
  type EmailTestResult,
} from '@erp/contracts';
import { withPlatformAdminTx, withTenantTx } from '@erp/database';

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
 * P-C6 — «خدمة البريد» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4 و§7).
 *
 * الخطة تطلب ستة عشر اختباراً على الأقل؛ هذا الملف يقيس ما يمكن أن يفسد في خدمة بريد:
 *
 * 1. **القالب**: الفهرس في الكود (17 حدثاً × لغتين)، والصياغة بمتغيّراتها، والرفض الصريح
 *    لمتغيّرٍ ناقص (قبل الكتابة في السجلّ) ولمتغيّرٍ لا يعرفه الحدث (قبل الحفظ).
 * 2. **التجاوز**: نصّ العميل لا يُلغي نصّ المنصة لغيره، و`null` يُعيد حقلَه وحده، وإرجاع
 *    الحقلين يحذف صفّ التجاوز لأن صفّاً بنصّ المنصة ليس تجاوزاً.
 * 3. **الحجر**: يمنع **قبل** الطابور، ويُسجَّل `suppressed` بسببه، ولا يُصلحه إلا رفعه.
 * 4. **الفشل**: يُسجَّل ويُجدَّل بالسلّم 1د · 5د · 30د، ثم يُفشل نهائياً بعد السقف، وإعادة
 *    المحاولة اليدوية تُرجع الرسالة إلى المسار نفسه.
 * 5. **الحصّتان**: حصّة العميل المطبَّقة (409) تُفحص **قبل** الكتابة، وسقف الإعدادات (429)
 *    يمنع إغراق المزوّد، ورسالة الاختبار لا تُحتسب على العميل.
 * 6. **العزل والصلاحيات**: سجلّ كل منشأة لا يرى غيره، والقراءة مفصولة عن الكتابة على
 *    سطحَي المنصة والعميل.
 *
 * **ولا بريد حقيقي**: المصنّع يُستبدل بمُسلِّمٍ في الذاكرة، والطابور بمهايئٍ خامل — وهو ما
 * يوثّق سلوك هذا المستودع (بلا Redis) بدل أن يعتمد عليه.
 */

type OperatorOptions = ActorOptions & { platformRoles?: readonly string[] };
const createOperator = createActor as (ctx: TestApp, options: OperatorOptions) => Promise<Actor>;

/** حالة المُسلِّم البديل: `0` لا يفشل، `n` يفشل n مرة، `-1` يفشل دائماً. */
const mailerState = { failFor: 0, calls: 0 };
const sentMessages: Array<{ to: string; subject: string; from?: string }> = [];

/** مُسلِّمٌ في الذاكرة: ينجح أو يفشل عند الطلب، ويحتفظ بما أُرسل للفحص. */
const testMailerFactory = () => ({
  transport: 'console' as const,
  async send(message: { to: string; subject: string; text: string; from?: string; fromName?: string }) {
    mailerState.calls += 1;
    const shouldFail =
      mailerState.failFor === -1 || (mailerState.failFor > 0 && mailerState.calls <= mailerState.failFor);
    if (shouldFail) throw new Error('SMTP 550 relay denied (مُسلِّم الاختبار)');
    sentMessages.push({
      to: message.to,
      subject: message.subject,
      from: message.fromName ? `${message.fromName} <${message.from}>` : message.from,
    });
  },
});

/** طابورٌ خامل: نفس ما يحدث حين لا يكون `REDIS_URL` مضبوطاً — لا تسليم مؤجَّل، تسليمٌ فوري. */
const inertQueue = {
  driver: 'inert' as const,
  isEnabled: () => false,
  publish: async () => undefined,
  close: async () => undefined,
};

describe('platform e-mail service (P-C6)', () => {
  let ctx: TestApp;
  let email: import('../src/modules/email/email.service.js').EmailService;
  let templates: import('../src/modules/email/email-templates.service.js').EmailTemplatesService;
  let usage: import('../src/modules/usage/usage.service.js').UsageService;
  let owner: Actor;
  let support: Actor;
  let customerA: Actor;
  let customerB: Actor;
  let customerBlind: Actor;

  const OPERATOR_TENANT = 'mail-ops';
  const base = '/api/v1';

  const platformGet = (path: string, actor: Actor = owner) =>
    api(ctx.server, 'get', `${base}${path}`, { token: actor.token });
  const platformPost = (path: string, body: unknown, actor: Actor = owner) =>
    api(ctx.server, 'post', `${base}${path}`, { token: actor.token, body });
  const platformPut = (path: string, body: unknown, actor: Actor = owner) =>
    api(ctx.server, 'put', `${base}${path}`, { token: actor.token, body });

  const messagesFor = (tenantId: string) =>
    withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(
        sql`SELECT id, status, attempts, last_error, is_test, outbox_job_id, subject, body,
                   next_attempt_at, to_email, event
              FROM email_messages WHERE tenant_id = ${tenantId} ORDER BY created_at ASC`,
      ),
    );

  const auditActions = () =>
    withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT action, tenant_id, after, meta FROM audit_log ORDER BY created_at ASC`),
    );

  /** نصّ القالب العامّ لحدثٍ ولغة — المرجع الذي يعود إليه العميل حين يكتب `null`. */
  const platformText = async (event: string, locale: 'ar' | 'en' = 'ar') => {
    const response = await platformGet(`/platform/email/templates?event=${event}&locale=${locale}`);
    const item = (response.body.data as EmailTemplate[])[0];
    if (!item) throw new Error(`no platform template for ${event}/${locale}`);
    return item;
  };

  const setLimit = (tenantId: string, key: string, value: number | null) =>
    platformPut(`/platform/tenants/${tenantId}/settings/${key}`, { value });

  beforeAll(async () => {
    const { QUEUE_PORT } = await import('../src/modules/platform-services/jobs/queue.service.js');
    const { EMAIL_MAILER_FACTORY } = await import('../src/modules/email/email-mailer.factory.js');
    const { EmailService } = await import('../src/modules/email/email.service.js');
    const { EmailTemplatesService } = await import('../src/modules/email/email-templates.service.js');
    const { UsageService } = await import('../src/modules/usage/usage.service.js');

    ctx = await createTestApp('platform-email', (builder) =>
      builder
        .overrideProvider(QUEUE_PORT)
        .useValue(inertQueue)
        .overrideProvider(EMAIL_MAILER_FACTORY)
        .useValue(testMailerFactory),
    );
    email = ctx.app.get(EmailService);
    templates = ctx.app.get(EmailTemplatesService);
    usage = ctx.app.get(UsageService);

    // «وطن» المشغّل الذي تنشئه البذرة عادةً: بريد المنصة يُنسب إليه في `outbox_jobs`
    // (الجدول يطلب منشأةً لكل مهمّة)، والاختبار ينشئه ليقيس المسار كما يعمل في التثبيت.
    await createTenantFixture(ctx.db.ownerUrl, {
      code: 'platform',
      name: 'منشأة المشغّلين',
      status: 'active',
    });

    owner = await createOperator(ctx, {
      tenantCode: OPERATOR_TENANT,
      email: 'owner@mail-ops.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_owner'],
    });
    support = await createOperator(ctx, {
      tenantCode: OPERATOR_TENANT,
      email: 'support@mail-ops.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_support'],
    });
    customerA = await createActor(ctx, {
      tenantCode: 'mail-a',
      tenantName: 'شركة البريد الأولى',
      email: 'owner@mail-a.test',
      permissions: ALL_TENANT_PERMISSIONS,
      roleNames: ['Admin'],
      isOwner: true,
    });
    customerB = await createActor(ctx, {
      tenantCode: 'mail-b',
      tenantName: 'شركة البريد الثانية',
      email: 'owner@mail-b.test',
      permissions: ALL_TENANT_PERMISSIONS,
      roleNames: ['Admin'],
      isOwner: true,
    });
    // بلا صلاحيات بريد: `tenant.view` وحدها لا تكفي لقراءة السجلّ ولا لكتابة نصّ.
    customerBlind = await createActor(ctx, {
      tenantCode: 'mail-c',
      tenantName: 'شركة بلا بريد',
      email: 'owner@mail-c.test',
      permissions: ['tenant.view'],
      roleNames: ['Viewer'],
      isOwner: false,
    });
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  });

  // كل اختبار يبدأ بمُسلِّمٍ ناجح: الفشل يُطلَب داخل الاختبار الذي يقيسه، فلا يتسرّب إلى غيره.
  beforeEach(() => {
    mailerState.failFor = 0;
    mailerState.calls = 0;
  });

  // ─────────────────────────────────────────────── 1. الفهرس والقوالب

  it('يزرع قوالب المنصة لكل حدثٍ ولغة (17 × 2) من بذور الكود', async () => {
    const response = await platformGet('/platform/email/templates');
    expect(response.status).toBe(200);
    const body = response.body as unknown as EmailTemplateListResponse;
    expect(body.data).toHaveLength(emailTemplateSeeds.length);
    expect(new Set(body.data.map((item) => item.event)).size).toBe(emailEventRegistry.length);
    for (const item of body.data) {
      expect(item.source).toBe('platform');
      expect(item.id).not.toBeNull();
      expect(item.labelAr.length).toBeGreaterThan(0);
      expect(item.subject.length).toBeGreaterThan(0);
      // بذورٌ كاملة: كل متغيّرٍ معلَنٍ للحدث مستعمَلٌ في نصّه، فلا تحذير «متغيّر مفقود».
      expect(item.missingVariables).toEqual([]);
    }
  });

  it('يرشّح القوالب بالحدث واللغة، ويقول من أين جاء النصّ', async () => {
    const invite = await platformGet('/platform/email/templates?event=user.invite&locale=en');
    expect(invite.status).toBe(200);
    const items = (invite.body.data as EmailTemplate[]).filter((item) => item.event === 'user.invite');
    expect(items).toHaveLength(1);
    expect(items[0]?.locale).toBe('en');
    expect(items[0]?.variables).toContain('link');

    const one = await platformText('user.invite', 'ar');
    expect(one.source).toBe('platform');
    expect(one.body).toContain('{{link}}');
  });

  it('يصيّر القالب بمتغيّراته ويحفظ النصّ المُرسَل كما هو في السجلّ', async () => {
    const template = await platformText('user.invite', 'ar');
    const response = await platformPost(`/platform/email/templates/${template.id}/test`, {
      to: 'Invited@Mail-A.test',
      locale: 'ar',
      variables: { name: 'سالم الحربي', tenant: 'شركة الأمل', link: 'https://app.test/i/7' },
    });
    expect(response.status).toBe(201);
    const result = response.body.data as EmailTestResult;
    expect(result.status).toBe('sent');
    expect(result.deliveredAt).not.toBeNull();
    expect(result.provider).toBe('console');
    expect(result.suppressionReason).toBeNull();

    const rows = await messagesFor(customerA.tenantId);
    expect(rows.rows).toHaveLength(0); // رسالة اختبار المنصة ليست رسالة عميل.
    const message = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT * FROM email_messages WHERE id = ${result.messageId}`),
    );
    const row = message.rows[0];
    expect(String(row.subject)).toBe('دعوة للانضمام إلى شركة الأمل');
    expect(String(row.body)).toContain('سالم الحربي');
    expect(String(row.body)).toContain('https://app.test/i/7');
    expect(String(row.to_email)).toBe('invited@mail-a.test');
    expect(Boolean(row.is_test)).toBe(true);
    expect(sentMessages.some((entry) => entry.subject === String(row.subject))).toBe(true);
  });

  it('يرفض الإرسال بمتغيّر ناقص قبل الكتابة في السجلّ — وبخطوة `missing` صريحة', async () => {
    const before = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM email_messages`),
    );

    await expect(
      email.send({
        tenantId: customerA.tenantId,
        event: 'invoice.created',
        to: 'buyer@mail-a.test',
        variables: { name: 'نورة', invoice_no: 'INV-1001' },
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
      details: { missing: expect.arrayContaining(['amount', 'due']) },
    });

    const after = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM email_messages`),
    );
    expect(Number(after.rows[0]?.n)).toBe(Number(before.rows[0]?.n));

    // ونفس الرفض على المسار الـHTTP: الرسالة تقول أيّ متغيّراتٍ نقصت.
    const template = await platformText('invoice.created', 'ar');
    const http = await platformPost(`/platform/email/templates/${template.id}/test`, {
      to: 'buyer@mail-a.test',
      locale: 'ar',
      variables: { invoice_no: 'INV-1001' },
    });
    expect(http.status).toBe(400);
    const errors = (http.body.errors ?? []) as Array<{ missing?: string[] }>;
    expect(errors[0]?.missing).toEqual(expect.arrayContaining(['amount', 'due']));
  });

  it('يرفض متغيّراً لا يعرفه الحدث عند الحفظ ولا يزيد نسخة القالب', async () => {
    const template = await platformText('user.invite', 'ar');
    const rejected = await platformPut(`/platform/email/templates/${template.id}`, {
      subject: template.subject,
      body: `${template.body}\n{{unknown_variable}}`,
      reason: 'تجربة متغيّر غير معلَن',
    });
    expect(rejected.status).toBe(400);

    const after = await platformText('user.invite', 'ar');
    expect(after.version).toBe(template.version);
    expect(after.body).not.toContain('unknown_variable');

    // ونفس المسار يقبل نصّاً بلا متغيّراتٍ مجهولة: النسخة تزيد، والتدقيق يكتب الفعل.
    const saved = await platformPut(`/platform/email/templates/${template.id}`, {
      subject: template.subject,
      body: template.body,
      reason: 'تثبيت النصّ الحالي بعد المحاولة المرفوضة',
    });
    expect(saved.status).toBe(200);
    expect((saved.body.data as EmailTemplate).version).toBe(template.version + 1);
  });

  // ─────────────────────────────────────────────── 2. تجاوز العميل

  it('تجاوز العميل يلغي نصّ المنصة له وحده، ولا يمسّ قالب المنصة', async () => {
    const platformRow = await platformText('invoice.created', 'ar');
    const override = await api(ctx.server, 'put', `${base}/email/templates/invoice.created`, {
      token: customerA.token,
      body: {
        body: 'فاتورة {{invoice_no}} من {{name}} بمبلغ {{amount}} — تستحق {{due}}.',
        reason: 'صياغة شركتنا',
      },
    });
    expect(override.status).toBe(200);
    const saved = override.body.data as EmailTemplate;
    expect(saved.source).toBe('tenant');
    expect(saved.tenantId).toBe(customerA.tenantId);
    expect(saved.subject).toBe(platformRow.subject); // الحقل الذي لم يكتبه العميل يرث المنصة.
    const tenantRowId = saved.id;

    const mineList = await api(ctx.server, 'get', `${base}/email/templates`, {
      token: customerA.token,
    });
    expect(mineList.status).toBe(200);
    const mine = (mineList.body.data as EmailTemplate[]).find(
      (item) => item.event === 'invoice.created' && item.locale === 'ar',
    );
    expect(mine?.source).toBe('tenant');
    expect(mine?.body).toContain('{{invoice_no}}');
    expect(mine?.body).toContain('فاتورة {{invoice_no}} من {{name}}');

    // قالب المنصة نفسه لم يتغيّر، وعميلٌ آخر ما زال يرى نصّ المنصة.
    const platformAgain = await platformText('invoice.created', 'ar');
    expect(platformAgain.body).toBe(platformRow.body);
    expect(platformAgain.version).toBe(platformRow.version);

    const otherList = await api(ctx.server, 'get', `${base}/email/templates`, {
      token: customerB.token,
    });
    const other = (otherList.body.data as EmailTemplate[]).find(
      (item) => item.event === 'invoice.created' && item.locale === 'ar',
    );
    expect(other?.source).toBe('platform');
    expect(other?.body).toBe(platformRow.body);

    // واللوحة ترى التجاوز موسوماً لمنشأته.
    const forCustomer = await platformGet(
      `/platform/email/templates?tenantId=${customerA.tenantId}&event=invoice.created`,
    );
    const scoped = (forCustomer.body.data as EmailTemplate[])[0];
    expect(scoped?.source).toBe('tenant');
    expect(scoped?.id).toBe(tenantRowId);
  });

  it('`null` في التجاوز يُعيد نصّ المنصة للحقل وحده، وإرجاع الحقلين يحذف صفّ التجاوز', async () => {
    const platformRow = await platformText('invoice.created', 'ar');

    const revertedSubject = await api(ctx.server, 'put', `${base}/email/templates/invoice.created`, {
      token: customerA.token,
      body: { subject: null, reason: 'عودٌ إلى موضوع المنصة' },
    });
    expect(revertedSubject.status).toBe(200);
    const afterSubject = revertedSubject.body.data as EmailTemplate;
    expect(afterSubject.subject).toBe(platformRow.subject);
    expect(afterSubject.source).toBe('tenant'); // النصّ ما زال تجاوزاً — الجسمُ تغييره.

    const revertedAll = await api(ctx.server, 'put', `${base}/email/templates/invoice.created`, {
      token: customerA.token,
      body: { body: null, reason: 'التراجع عن التخصيص كله' },
    });
    expect(revertedAll.status).toBe(200);
    const afterAll = revertedAll.body.data as EmailTemplate;
    expect(afterAll.source).toBe('platform');
    expect(afterAll.body).toBe(platformRow.body);
    expect(afterAll.id).toBe(platformRow.id);

    const rows = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`
        SELECT count(*)::int AS n FROM email_templates
         WHERE tenant_id = ${customerA.tenantId} AND event = 'invoice.created'
      `),
    );
    expect(Number(rows.rows[0]?.n)).toBe(0);
  });

  // ─────────────────────────────────────────────── 3. الحجر

  it('الحجر يمنع قبل الطابور ويُسجَّل `suppressed` بسببه', async () => {
    const added = await platformPost('/platform/email/suppressions', {
      email: 'blocked@mail-a.test',
      reason: 'manual',
      note: 'طلب العميل عدم المراسلة',
    });
    expect(added.status).toBe(201);

    const queued = await email.send({
      tenantId: customerA.tenantId,
      event: 'statement.ready',
      to: 'blocked@mail-a.test',
      variables: { name: 'نورة', period: '2026-08', link: 'https://app.test/s/1' },
    });
    expect(queued.status).toBe('suppressed');
    expect(queued.deliveryMode).toBe('inline');
    expect(queued.sentAt).toBeNull();

    const rows = await messagesFor(customerA.tenantId);
    const row = rows.rows.find((entry) => String(entry.id) === queued.id);
    expect(row?.outbox_job_id).toBeNull(); // لا مهمّة في الطابور: الحجر سبق الطابور.

    const testSend = await platformPost(
      `/platform/email/templates/${(await platformText('statement.ready', 'ar')).id}/test`,
      { to: 'blocked@mail-a.test', locale: 'ar', variables: { period: '2026-08', link: 'x' } },
    );
    const result = testSend.body.data as EmailTestResult;
    expect(result.status).toBe('suppressed');
    expect(result.suppressionReason).toBe('manual');
    expect(result.deliveredAt).toBeNull();
  });

  it('الحجر العامّ يسري على كل العملاء، ورفعه يُعيد الإرسال', async () => {
    const global = await platformPost('/platform/email/suppressions', {
      email: 'global-block@mail.test',
      reason: 'complaint',
      note: 'شكوى من المرسل إليه',
    });
    expect(global.status).toBe(201);

    const blocked = await email.send({
      tenantId: customerB.tenantId,
      event: 'payment.received',
      to: 'global-block@mail.test',
      variables: { name: 'ب', invoice_no: 'INV-2', amount: '100.00' },
    });
    expect(blocked.status).toBe('suppressed');

    const removed = await api(
      ctx.server,
      'delete',
      `${base}/platform/email/suppressions/${String(global.body.data.id)}`,
      { token: owner.token },
    );
    expect(removed.status).toBe(200);

    const delivered = await email.send({
      tenantId: customerB.tenantId,
      event: 'payment.received',
      to: 'global-block@mail.test',
      variables: { name: 'ب', invoice_no: 'INV-2', amount: '100.00' },
    });
    expect(delivered.status).toBe('sent');
  });

  // ─────────────────────────────────────────────── 4. الفشل والتراجع

  it('الفشل يُسجَّل ويُجدَّل بالسلّم: محاولةٌ أولى بعد دقيقة، وثانية بعد خمس', async () => {
    mailerState.failFor = -1;
    mailerState.calls = 0;

    const failed = await email.send({
      tenantId: customerA.tenantId,
      event: 'stock.below_min',
      to: 'stock@mail-a.test',
      variables: { name: 'ن', item: 'صنف', on_hand: '2', min: '10' },
    });
    expect(failed.status).toBe('queued');
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toContain('550');

    const first = await messagesFor(customerA.tenantId);
    const firstRow = first.rows.find((row) => String(row.id) === failed.id);
    const firstDelay = minutesFromNow(firstRow?.next_attempt_at as string);
    expect(firstDelay).toBeGreaterThanOrEqual(0.5);
    expect(firstDelay).toBeLessThanOrEqual(1.5);

    const second = await email.deliver(failed.id, 'inline');
    expect(second.attempts).toBe(2);
    const rows = await messagesFor(customerA.tenantId);
    const secondRow = rows.rows.find((row) => String(row.id) === failed.id);
    const secondDelay = minutesFromNow(secondRow?.next_attempt_at as string);
    expect(secondDelay).toBeGreaterThanOrEqual(4);
    expect(secondDelay).toBeLessThanOrEqual(6);

    const audit = await auditActions();
    const failures = audit.rows.filter((row) => row.action === 'email.message_failed');
    expect(failures).toHaveLength(2);
    expect((failures[0]?.after as { willRetry?: boolean }).willRetry).toBe(true);
  });

  it('بعد ثلاث محاولات تصير الرسالة failed بلا محاولةٍ رابعة، والتدقيق يقول لماذا', async () => {
    mailerState.failFor = -1; // المزوّد ما زال معطّلاً — نكمل السلّم إلى نهايته.
    const list = await messagesFor(customerA.tenantId);
    const target = list.rows.find((row) => String(row.last_error ?? '').includes('550'));
    expect(target).toBeDefined();

    const third = await email.deliver(String(target?.id), 'inline');
    expect(third.status).toBe('failed');
    expect(third.attempts).toBe(3);
    expect(third.sentAt).toBeNull();

    const rows = await messagesFor(customerA.tenantId);
    const row = rows.rows.find((entry) => String(entry.id) === String(target?.id));
    expect(row?.next_attempt_at).toBeNull();

    const audit = await auditActions();
    const finalFailure = audit.rows
      .filter((entry) => entry.action === 'email.message_failed')
      .find((entry) => (entry.after as { willRetry?: boolean }).willRetry === false);
    expect(finalFailure).toBeDefined();
    expect((finalFailure?.after as { attempt?: number }).attempt).toBe(3);
  });

  it('إعادة المحاولة اليدوية تُعيد الرسالة إلى المسار نفسه وتُسلّمها عند نجاح المزوّد', async () => {
    const list = await messagesFor(customerA.tenantId);
    const failed = list.rows.find((row) => String(row.status) === 'failed');
    expect(failed).toBeDefined();

    const sent = await platformPost(
      `/platform/email/messages/${String(failed?.id)}/retry`,
      { reason: 'أُصلح مُسلِّم المنصة' },
    );
    expect(sent.status).toBe(200);
    const message = sent.body.data as { status: string; sentAt: string | null };
    expect(message.status).toBe('sent');
    expect(message.sentAt).not.toBeNull();

    const again = await platformPost(`/platform/email/messages/${String(failed?.id)}/retry`, {
      reason: 'محاولة ثانية على رسالةٍ أُرسلت',
    });
    expect(again.status).toBe(422);

    const audit = await auditActions();
    expect(audit.rows.some((row) => row.action === 'email.message_retry')).toBe(true);
    expect(audit.rows.some((row) => row.action === 'email.message_sent')).toBe(true);
  });

  // ─────────────────────────────────────────────── 5. الحصّتان

  it('حصّة العميل المطبَّقة تمنع الإرسال بـ409 قبل الكتابة في السجلّ', async () => {
    const limit = await setLimit(customerA.tenantId, 'limits.max_emails_per_month', 1);
    expect(limit.status).toBe(200);
    await usage.record(customerA.tenantId, 'email_sends_per_month');

    const before = await messagesFor(customerA.tenantId);
    await expect(
      email.send({
        tenantId: customerA.tenantId,
        event: 'payment.received',
        to: 'quota@mail-a.test',
        variables: { name: 'ن', invoice_no: 'INV-3', amount: '50.00' },
      }),
    ).rejects.toMatchObject({ code: 'USAGE_LIMIT_REACHED', status: 409 });
    const after = await messagesFor(customerA.tenantId);
    expect(after.rows).toHaveLength(before.rows.length);

    const audit = await withTenantTx(ctx.handle.db, customerA.tenantId, (tx) =>
      tx.execute(
        sql`SELECT action, after FROM audit_log WHERE tenant_id = ${customerA.tenantId} AND action = 'usage.limit_reached'`,
      ),
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect((audit.rows.at(-1)?.after as { metric?: string }).metric).toBe('email_sends_per_month');

    await setLimit(customerA.tenantId, 'limits.max_emails_per_month', null);
  });

  it('سقف الإعدادات يمنع إغراق المزوّد بـ429، ورسالة الاختبار لا تُحتسب عليه', async () => {
    const capped = await platformPut('/platform/email/settings', {
      dailyLimit: 1,
      reason: 'سقف تشغيلي في الاختبار',
    });
    expect(capped.status).toBe(200);
    expect((capped.body.data as EmailSettings).dailyLimit).toBe(1);

    const first = await email.send({
      tenantId: null,
      event: 'announcement',
      to: 'subscriber@mail.test',
      variables: { name: 'مشترك', title: 'إعلان', body: 'نصّ', link: 'https://app.test/a' },
    });
    expect(first.status).toBe('sent');

    await expect(
      email.send({
        tenantId: null,
        event: 'announcement',
        to: 'subscriber2@mail.test',
        variables: { name: 'مشترك', title: 'إعلان', body: 'نصّ', link: 'https://app.test/a' },
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });

    // رسالة اختبار المنصة لا تُحتسب على السقف: المُختبَر هو الاتصال لا الاستهلاك.
    const test = await platformPost('/platform/email/settings/test', { to: 'probe@mail.test' });
    expect(test.status).toBe(201);
    expect((test.body.data as EmailTestResult).status).toBe('sent');

    const cleared = await platformPut('/platform/email/settings', {
      dailyLimit: null,
      reason: 'رفع السقف بعد الاختبار',
    });
    expect((cleared.body.data as EmailSettings).dailyLimit).toBeNull();
  });

  it('رسالة الاختبار على عميلٍ لا تحسب على حصّته', async () => {
    await setLimit(customerB.tenantId, 'limits.max_emails_per_month', 1);
    await usage.record(customerB.tenantId, 'email_sends_per_month');

    // إرسالٌ حقيقيّ يُرفض…
    await expect(
      email.send({
        tenantId: customerB.tenantId,
        event: 'payment.received',
        to: 'blocked-by-quota@mail-b.test',
        variables: { name: 'ب', invoice_no: 'INV-9', amount: '10.00' },
      }),
    ).rejects.toMatchObject({ status: 409 });

    // …ورسالة اختبارٍ تمرّ، لأنها ليست استهلاك العميل.
    const template = await platformText('payment.received', 'ar');
    const test = await platformPost(`/platform/email/templates/${template.id}/test`, {
      to: 'probe@mail-b.test',
      locale: 'ar',
      variables: { invoice_no: 'INV-9', amount: '10.00' },
    });
    expect(test.status).toBe(201);

    await setLimit(customerB.tenantId, 'limits.max_emails_per_month', null);
  });

  // ─────────────────────────────────────────────── 6. العزل والصلاحيات والطابور

  it('سجلّ الرسائل معزول: كل عميل يرى رسائله، والمنصة ترى الكلّ وترشّح بعميل', async () => {
    const mine = await api(ctx.server, 'get', `${base}/email/messages`, { token: customerA.token });
    expect(mine.status).toBe(200);
    const mineRows = (mine.body.data as Array<{ tenantId: string | null }>).filter(Boolean);
    expect(mineRows.length).toBeGreaterThan(0);
    expect(mineRows.every((row) => row.tenantId === customerA.tenantId)).toBe(true);

    const otherTenant = await api(ctx.server, 'get', `${base}/email/messages`, {
      token: customerB.token,
    });
    const otherRows = otherTenant.body.data as Array<{ tenantId: string | null }>;
    expect(otherRows.every((row) => row.tenantId === customerB.tenantId)).toBe(true);
    expect(otherRows.some((row) => row.tenantId === customerA.tenantId)).toBe(false);

    const scoped = await platformGet(
      `/platform/email/messages?tenantId=${customerA.tenantId}&limit=100`,
    );
    const scopedRows = scoped.body.data as Array<{ tenantId: string | null; status: string }>;
    expect(scopedRows.length).toBeGreaterThan(0);
    expect(scopedRows.every((row) => row.tenantId === customerA.tenantId)).toBe(true);
    const counts = scoped.body.counts as Record<string, number>;
    const summed = Object.values(counts).reduce((sum, value) => sum + value, 0);
    expect(summed).toBe((scoped.body.meta as { total: number }).total);

    const searched = await platformGet('/platform/email/messages?search=stock@mail-a.test');
    const searchedRows = searched.body.data as Array<{ toEmail: string }>;
    expect(searchedRows.length).toBeGreaterThan(0);
    expect(searchedRows.every((row) => row.toEmail.includes('stock@mail-a.test'))).toBe(true);
  });

  it('صلاحيات المنصة تفصل القراءة عن الكتابة، وصلاحيات العميل تفصل السجلّ عن النصّ', async () => {
    // دعم المنصة يقرأ ولا يكتب.
    expect((await platformGet('/platform/email/templates', support)).status).toBe(200);
    expect((await platformGet('/platform/email/settings', support)).status).toBe(200);
    const supportWrite = await platformPut(
      '/platform/email/settings',
      { fromName: 'اسم من الدعم' },
      support,
    );
    expect(supportWrite.status).toBe(403);
    const supportTemplate = await platformText('user.invite', 'ar');
    expect(
      (
        await platformPut(
          `/platform/email/templates/${supportTemplate.id}`,
          { subject: supportTemplate.subject, body: supportTemplate.body, reason: 'محاولة دعم' },
          support,
        )
      ).status,
    ).toBe(403);
    expect(
      (await platformPost('/platform/email/suppressions', { email: 'x@y.test', reason: 'manual' }, support))
        .status,
    ).toBe(403);

    // عميلٌ بلا صلاحية بريدٍ لا يقرأ السجلّ ولا يكتب النصّ.
    expect(
      (await api(ctx.server, 'get', `${base}/email/messages`, { token: customerBlind.token })).status,
    ).toBe(403);
    expect(
      (await api(ctx.server, 'get', `${base}/email/templates`, { token: customerBlind.token })).status,
    ).toBe(403);

    // وجلسة عميلٍ لا تدخل إلى طائرة المنصة.
    expect((await platformGet('/platform/email/messages', customerA)).status).toBe(403);
    // ورموز المنصة لا تلمس سطح العميل: لا سياق منشأة للرمز الإداري.
    const withoutTenant = await api(ctx.server, 'get', `${base}/email/messages`);
    expect(withoutTenant.status).toBe(401);
  });

  it('تجاوز العميل لا يستطيع تغيير المزوّد من سطحه', async () => {
    const attempt = await api(ctx.server, 'put', `${base}/email/settings`, {
      token: customerA.token,
      body: { provider: 'smtp', reason: 'محاولة تبديل المزوّد' },
    });
    expect(attempt.status).toBe(422);
    const settings = await api(ctx.server, 'get', `${base}/email/settings`, {
      token: customerA.token,
    });
    expect(settings.status).toBe(200);
    expect((settings.body.data as EmailSettings).provider).toBe('console');
  });

  it('كل إرسال يكتب مهمّة `email.send` في الطابور بنفس معاملة الرسالة، بلا أسرار', async () => {
    const queued = await email.send({
      tenantId: customerB.tenantId,
      event: 'password.reset',
      to: 'reset@mail-b.test',
      variables: { name: 'ب', link: 'https://app.test/r/1', expires: '30 دقيقة' },
    });
    expect(queued.status).toBe('sent'); // الطابور خامل في الاختبار: التسليم فوري.

    const row = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT outbox_job_id FROM email_messages WHERE id = ${queued.id}`),
    );
    const jobId = String(row.rows[0]?.outbox_job_id);
    expect(jobId).not.toBe('null');

    const job = await withTenantTx(ctx.handle.db, customerB.tenantId, (tx) =>
      tx.execute(sql`SELECT queue, type, payload, status FROM outbox_jobs WHERE id = ${jobId}`),
    );
    const entry = job.rows[0];
    expect(String(entry?.queue)).toBe('notifications');
    expect(String(entry?.type)).toBe('email.send');
    expect(entry?.payload).toEqual({ messageId: queued.id });
    expect(Object.keys(entry?.payload as Record<string, unknown>)).toEqual(['messageId']);
  });

  it('تدقيق الخدمة يُثبت كل فعلٍ معلَن — من الكتابة إلى التسليم', async () => {
    const audit = await auditActions();
    const seen = new Set(audit.rows.map((row) => String(row.action)));
    for (const action of [
      'email.template_update',
      'email.tenant_template_update',
      'email.template_reset',
      'email.message_queued',
      'email.message_sent',
      'email.message_failed',
      'email.message_retry',
      'email.message_suppressed',
      'email.suppression_add',
      'email.suppression_remove',
      'email.settings_update',
    ]) {
      expect(seen.has(action), `missing audit action ${action}`).toBe(true);
    }
  });

  it('كل قالبٍ فعّالٍ لعميلٍ يذكر مصدره — والعدّاد لا يتضخّم بلا سبب', async () => {
    const listed = await platformGet(
      `/platform/email/templates?tenantId=${customerB.tenantId}&locale=ar`,
    );
    const items = listed.body.data as EmailTemplate[];
    expect(items).toHaveLength(emailEventRegistry.length);
    expect(items.every((item) => ['platform', 'tenant'].includes(item.source))).toBe(true);

    const effective = await templates.effective(customerB.tenantId, {
      event: 'user.invite',
      locale: 'ar',
    });
    expect(effective[0]?.source).toBe('platform');
    expect(effective[0]?.id).not.toBeNull();
  });
});

/** عدد الدقائق بين الآن ووقتٍ مستقبلي — يُقاس من `next_attempt_at` في القاعدة. */
function minutesFromNow(iso: string | null | undefined): number {
  if (!iso) throw new Error('next_attempt_at غير مضبوط');
  return (new Date(iso).getTime() - Date.now()) / 60_000;
}
