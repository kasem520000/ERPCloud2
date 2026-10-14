import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ANNOUNCEMENT_NOTIFICATION_TYPE, type Announcement, type AnnouncementReadRow } from '@erp/contracts';
import { withPlatformAdminTx, withTenantTx } from '@erp/database';

import {
  ALL_TENANT_PERMISSIONS,
  createActor,
  createTenantFixture,
  setMembershipStatusFixture,
  setTenantStatusFixture,
  type Actor,
  type ActorOptions,
} from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * P-C7 — «الإعلانات والإشعارات» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
 *
 * الخطة تطلب ثمانية اختبارات على الأقل؛ هذا الملف يقيس ما يمكن أن يُخطئ في إعلان:
 *
 * 1. **الكتابة**: النصّان إلزاميان، والاستهداف متماسك (باقة/حالة/الجميع بلا خلط).
 * 2. **الجدولة**: ماضٍ يُرفض 422، ومستقبلي يصير `scheduled` ومعه مهمّةٌ بوقتها،
 *    والمنشور لا يُعدَّل (تعديل ما قيل ليس تعديلاً).
 * 3. **النشر والتوزيع**: إشعارٌ لكل عضو نشط، وبريدٌ لمالك المنشأة وحده، والمنشأة المعلّقة
 *    لا تُستهدف، ومنشأة المشغّلين لا تُزعج نفسها.
 * 4. **الإعادة**: نداء النشر ثانيةً لا يضاعف شيئاً (صفّ التسليم فريد) — وهذا مسار الإصلاح.
 * 5. **القراءة**: `GET /:id/reads` يعدّ ما وُزّع، ووسم الإشعار مقروءاً يرفع العدّاد.
 * 6. **الصلاة والعزل**: بلا `console.notifications.manage` لا قائمة، وسطح العميل لا يصل.
 * 7. **حدّ P-C6 المستدرَك**: العميل لا يتجاوز نصّ حدثٍ نطاقه `platform` (إعلان المنصة نصّها).
 */

type OperatorOptions = ActorOptions & { platformRoles?: readonly string[] };
const createOperator = createActor as (ctx: TestApp, options: OperatorOptions) => Promise<Actor>;

/** مُسلِّمٌ في الذاكرة — لا بريد حقيقي في الاختبارات، كحال P-C6. */
const sent: Array<{ to: string; subject: string }> = [];
const testMailerFactory = () => ({
  transport: 'console' as const,
  async send(message: { to: string; subject: string }) {
    sent.push({ to: message.to, subject: message.subject });
  },
});

const inertQueue = {
  driver: 'inert' as const,
  isEnabled: () => false,
  publish: async () => undefined,
  close: async () => undefined,
};

describe('platform announcements (P-C7)', () => {
  let ctx: TestApp;
  let owner: Actor;
  let support: Actor;
  let customerA: Actor;
  let customerB: Actor;
  /** عضوٌ ثانٍ في الشركة الأولى: يستقبل الإشعار، ولا يستقبل البريد (المالك وحده). */
  let guestA: Actor;
  /** عضوٌ معطَّل: لا إشعارَ له ما دام موقوفاً. */
  let bystander: Actor;
  let platformTenantId: string;

  const base = '/api/v1';

  const platformGet = (path: string, actor: Actor = owner) =>
    api(ctx.server, 'get', `${base}${path}`, { token: actor.token });
  const platformPost = (path: string, body: unknown, actor: Actor = owner) =>
    api(ctx.server, 'post', `${base}${path}`, { token: actor.token, body });
  const platformPatch = (path: string, body: unknown, actor: Actor = owner) =>
    api(ctx.server, 'patch', `${base}${path}`, { token: actor.token, body });

  const draft = (overrides: Record<string, unknown> = {}) => ({
    titleAr: 'صيانة مجدولة',
    titleEn: 'Scheduled maintenance',
    bodyAr: 'سنوقف الخدمة ساعةً يوم الجمعة لإجراء تحديث.',
    bodyEn: 'The service will be paused for an hour on Friday for an update.',
    reason: 'تحقّق P-C7',
    ...overrides,
  });

  // `notifications` تحمل سياسة عزل المستأجر وحدها (0001)، فقراءتها بمعاملة المنصة لا ترى شيئاً.
  const notificationsFor = (tenantId: string) =>
    withTenantTx(ctx.handle.db, tenantId, (tx) =>
      tx.execute(
        sql`SELECT n.id, n.membership_id, n.read_at, n.type, n.payload
              FROM notifications n
             WHERE n.tenant_id = ${tenantId} ORDER BY n.created_at ASC`,
      ),
    );

  const messagesFor = (tenantId: string) =>
    withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(
        sql`SELECT id, to_email, status, event, subject FROM email_messages
             WHERE tenant_id = ${tenantId} ORDER BY created_at ASC`,
      ),
    );

  const auditActions = () =>
    withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT action, meta FROM audit_log ORDER BY created_at ASC`),
    );

  beforeAll(async () => {
    const { QUEUE_PORT } = await import('../src/modules/platform-services/jobs/queue.service.js');
    const { EMAIL_MAILER_FACTORY } = await import('../src/modules/email/email-mailer.factory.js');

    ctx = await createTestApp('platform-announcements', (builder) =>
      builder
        .overrideProvider(QUEUE_PORT)
        .useValue(inertQueue)
        .overrideProvider(EMAIL_MAILER_FACTORY)
        .useValue(testMailerFactory),
    );

    const platformTenant = await createTenantFixture(ctx.db.ownerUrl, {
      code: 'platform',
      name: 'منشأة المشغّلين',
      status: 'active',
    });
    platformTenantId = platformTenant.id;

    owner = await createOperator(ctx, {
      tenantCode: 'ann-ops',
      email: 'owner@ann-ops.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_owner'],
    });
    support = await createOperator(ctx, {
      tenantCode: 'ann-ops',
      email: 'support@ann-ops.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_support'],
    });

    customerA = await createActor(ctx, {
      tenantCode: 'ann-a',
      tenantName: 'الشركة الأولى',
      email: 'owner@ann-a.test',
      permissions: ALL_TENANT_PERMISSIONS,
      roleNames: ['Admin'],
      isOwner: true,
    });
    customerB = await createActor(ctx, {
      tenantCode: 'ann-b',
      tenantName: 'الشركة الثانية',
      email: 'owner@ann-b.test',
      permissions: ALL_TENANT_PERMISSIONS,
      roleNames: ['Admin'],
      isOwner: true,
    });

    guestA = await createActor(ctx, {
      tenantCode: 'ann-a',
      email: 'staff@ann-a.test',
      permissions: ALL_TENANT_PERMISSIONS,
      roleNames: ['Staff'],
      isOwner: false,
    });
    // عضوٌ سيُعطَّل قبل النشر: عضويّته موقوفة فلا إشعار.
    bystander = await createActor(ctx, {
      tenantCode: 'ann-a',
      email: 'away@ann-a.test',
      permissions: ALL_TENANT_PERMISSIONS,
      roleNames: ['Staff'],
      isOwner: false,
    });
    await setMembershipStatusFixture(ctx.db.ownerUrl, bystander.membershipId, 'suspended');

    // باقةٌ وترخيصٌ حيّ، لقياس الاستهداف بالباقة.
    await withPlatformAdminTx(ctx.handle.db, async (tx) => {
      await tx.execute(sql`
        INSERT INTO billing_plans (id, code, name, interval, amount, currency, active)
        VALUES (gen_random_uuid(), 'growth', 'نمو', 'month', 499, 'SAR', true)
        ON CONFLICT DO NOTHING
      `);
      await tx.execute(sql`
        INSERT INTO tenant_subscriptions (id, tenant_id, plan_id, status, provider)
        SELECT gen_random_uuid(), ${customerB.tenantId},
               (SELECT id FROM billing_plans WHERE code = 'growth'), 'active', 'manual'
      `);
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('يكتب مسودّةً بلا نشر، ويرفض نصّاً بلغةٍ واحدة', async () => {
    const created = await platformPost('/platform/announcements', draft());
    expect(created.status).toBe(201);
    const item = created.body.data as Announcement;
    expect(item.status).toBe('draft');
    expect(item.publishedAt).toBeNull();
    expect(item.stats).toEqual({ tenants: 0, inApp: 0, emails: 0, reads: 0 });

    const incomplete = await platformPost('/platform/announcements', {
      titleAr: 'عنوانٌ فقط',
      bodyAr: 'نصٌّ عربي بلا مقابل إنجليزي.',
      reason: 'تحقّق P-C7',
    });
    expect(incomplete.status).toBe(400);
  });

  it('يرفض استهدافاً غير متماسك: باقةٌ بلا كود، و«الجميع» مع باقة', async () => {
    const withoutCode = await platformPost(
      '/platform/announcements',
      draft({ audience: 'plan', planCode: undefined }),
    );
    expect(withoutCode.status).toBe(400);

    const mixed = await platformPost(
      '/platform/announcements',
      draft({ audience: 'all', planCode: 'growth' }),
    );
    expect(mixed.status).toBe(400);

    const unknownPlan = await platformPost(
      '/platform/announcements',
      draft({ audience: 'plan', planCode: 'nope' }),
    );
    expect(unknownPlan.status).toBe(422);
    expect(unknownPlan.body.errors?.[0]?.field).toBe('planCode');
  });

  it('يرفض جدولةً في الماضي، ويقبل المستقبل بمهمّةٍ بوقتها', async () => {
    const past = await platformPost(
      '/platform/announcements',
      draft({ publishAt: new Date(Date.now() - 60_000).toISOString() }),
    );
    expect(past.status).toBe(422);
    expect(past.body.errors?.[0]?.field).toBe('publishAt');

    const when = new Date(Date.now() + 3_600_000);
    const created = await platformPost('/platform/announcements', draft({ publishAt: when.toISOString() }));
    expect(created.status).toBe(201);
    const item = created.body.data as Announcement;
    expect(item.status).toBe('scheduled');

    const jobs = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`
        SELECT type, run_at, status, tenant_id FROM outbox_jobs
         WHERE type = 'announcement.publish' ORDER BY created_at DESC LIMIT 1
      `),
    );
    expect(jobs.rows[0]?.tenant_id).toBe(platformTenantId);
    expect(new Date(jobs.rows[0]?.run_at as string).getTime()).toBe(when.getTime());
  });

  it('ينشر الآن إلى كل الأعضاء في التطبيق، وبالبريد إلى المالك وحده', async () => {
    sent.length = 0;
    const created = await platformPost('/platform/announcements', draft());
    const id = (created.body.data as Announcement).id;

    const published = await platformPost(`/platform/announcements/${id}/publish`, {
      reason: 'تحقّق P-C7: نشر',
    });
    expect(published.status).toBe(201);
    const item = published.body.data as Announcement;
    expect(item.status).toBe('published');
    expect(item.publishedAt).not.toBeNull();

    // الشركة الأولى: العضو + المالك = إشعاران، وبريدٌ واحد.
    const first = await notificationsFor(customerA.tenantId);
    expect(first.rows.length).toBe(2);
    expect(first.rows.every((row) => row.type === ANNOUNCEMENT_NOTIFICATION_TYPE)).toBe(true);
    const memberIds = new Set(first.rows.map((row) => String(row.membership_id)));
    expect(memberIds.has(bystander.membershipId)).toBe(false);

    const firstMail = await messagesFor(customerA.tenantId);
    expect(firstMail.rows.length).toBe(1);
    expect(firstMail.rows[0].event).toBe('announcement');
    expect(String(firstMail.rows[0].to_email)).toBe('owner@ann-a.test');
    expect(sent.filter((message) => message.to === 'owner@ann-a.test')).toHaveLength(1);
    expect(sent.some((message) => message.to === 'staff@ann-a.test')).toBe(false);

    // الشركة الثانية: المالك وحده فيه، فلا إشعارَ ثانياً ولا بريدَ ثانٍ.
    const second = await notificationsFor(customerB.tenantId);
    expect(second.rows.length).toBe(1);
    expect((await messagesFor(customerB.tenantId)).rows.length).toBe(1);
  });

  it('لا يستهدف منشأة المشغّلين، ولا المعلّقة', async () => {
    await setTenantStatusFixture(ctx.db.ownerUrl, customerB.tenantId, 'suspended');

    const created = await platformPost('/platform/announcements', draft({ titleAr: 'الجميع مرة أخرى' }));
    const id = (created.body.data as Announcement).id;
    await platformPost(`/platform/announcements/${id}/publish`, { reason: 'تحقّق P-C7: الجميع' });

    const rows = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT tenant_id FROM announcement_reads WHERE announcement_id = ${id}`),
    );
    const targeted = new Set(rows.rows.map((row) => String(row.tenant_id)));
    expect(targeted.has(customerA.tenantId)).toBe(true);
    expect(targeted.has(platformTenantId)).toBe(false);
    expect(targeted.has(customerB.tenantId)).toBe(false);

    const suspendedOnly = await platformPost(
      '/platform/announcements',
      draft({ titleAr: 'للمعلّقين', audience: 'status', tenantStatus: 'suspended' }),
    );
    const suspendedId = (suspendedOnly.body.data as Announcement).id;
    await platformPost(`/platform/announcements/${suspendedId}/publish`, { reason: 'تحقّق P-C7: المعلّقة' });
    const suspendedRows = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(
        sql`SELECT DISTINCT tenant_id FROM announcement_reads WHERE announcement_id = ${suspendedId}`,
      ),
    );
    expect(suspendedRows.rows.map((row) => String(row.tenant_id))).toEqual([customerB.tenantId]);

    await setTenantStatusFixture(ctx.db.ownerUrl, customerB.tenantId, 'active');
  });

  it('يستهدف حاملي باقةٍ بعينها وحدهم', async () => {
    const created = await platformPost(
      '/platform/announcements',
      draft({ titleAr: 'لعملاء باقة نمو', audience: 'plan', planCode: 'growth' }),
    );
    const id = (created.body.data as Announcement).id;
    await platformPost(`/platform/announcements/${id}/publish`, { reason: 'تحقّق P-C7: الباقة' });

    const reads = await platformGet(`/platform/announcements/${id}/reads?limit=50`);
    const rows = reads.body.data as AnnouncementReadRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe(customerB.tenantId);
    expect(rows[0].tenantCode).toBe('ann-b');
    expect(rows[0].inApp).toBe(1);
    expect(rows[0].emails).toBe(1);
  });

  it('إعادة النشر لا تُضاعف إشعاراً ولا بريداً — تكمل الناقص فقط', async () => {
    const created = await platformPost('/platform/announcements', draft({ titleAr: 'إعادة نشر' }));
    const id = (created.body.data as Announcement).id;
    await platformPost(`/platform/announcements/${id}/publish`, { reason: 'تحقّق P-C7: أول نشر' });

    const before = await notificationsFor(customerA.tenantId);
    const mailBefore = await messagesFor(customerA.tenantId);

    const replay = await platformPost(`/platform/announcements/${id}/publish`, {
      reason: 'تحقّق P-C7: إعادة',
    });
    expect(replay.status).toBe(201);

    const after = await notificationsFor(customerA.tenantId);
    expect(after.rows.length).toBe(before.rows.length);
    expect((await messagesFor(customerA.tenantId)).rows.length).toBe(mailBefore.rows.length);

    const replayed = (await auditActions()).rows.filter((row) =>
      String((row.meta as { reason?: string })?.reason ?? '').includes('إعادة'),
    );
    expect(replayed.length).toBe(1);
    expect((replayed[0].meta as { replayed?: boolean }).replayed).toBe(true);
  });

  it('لا يعدّل المنشور، ويعدّل المجدولة بموعدٍ جديد', async () => {
    const created = await platformPost('/platform/announcements', draft({ titleAr: 'قابلة للتعديل' }));
    const id = (created.body.data as Announcement).id;

    const scheduled = await platformPatch(`/platform/announcements/${id}`, {
      publishAt: new Date(Date.now() + 7_200_000).toISOString(),
      reason: 'تحقّق P-C7: جدولة',
    });
    expect(scheduled.status).toBe(200);
    expect((scheduled.body.data as Announcement).status).toBe('scheduled');

    const unscheduled = await platformPatch(`/platform/announcements/${id}`, {
      publishAt: null,
      reason: 'تحقّق P-C7: إلغاء الجدولة',
    });
    expect((unscheduled.body.data as Announcement).status).toBe('draft');

    await platformPost(`/platform/announcements/${id}/publish`, { reason: 'تحقّق P-C7: نشر' });
    const frozen = await platformPatch(`/platform/announcements/${id}`, {
      titleAr: 'محاولة تعديل المنشور',
      reason: 'تحقّق P-C7',
    });
    expect(frozen.status).toBe(422);
  });

  it('يعدّ القراءة من الإشعار نفسه: وسمُ عضوٍ واحد يرفع العدّاد', async () => {
    const created = await platformPost('/platform/announcements', draft({ titleAr: 'تُقاس قراءتها' }));
    const id = (created.body.data as Announcement).id;
    await platformPost(`/platform/announcements/${id}/publish`, { reason: 'تحقّق P-C7: القراءة' });

    const before = await platformGet(`/platform/announcements/${id}/reads?limit=50`);
    const rowBefore = (before.body.data as AnnouncementReadRow[]).find(
      (row) => row.tenantId === customerA.tenantId,
    );
    expect(rowBefore?.reads).toBe(0);
    expect(rowBefore?.inApp).toBe(2); // المالك + العضو (المعطَّل خارج الحساب)
    expect(rowBefore?.emails).toBe(1);

    // صندوق إشعارات العضو: إعلانٌ واصل باسمه، ووسمُه مقروءاً يرفع العدّاد.
    const mine = await api(ctx.server, 'get', `${base}/notifications?limit=10`, { token: guestA.token });
    const notification = (mine.body.data as Array<{ id: string; type: string }>).find(
      (item) => item.type === ANNOUNCEMENT_NOTIFICATION_TYPE,
    );
    expect(notification).toBeDefined();
    const marked = await api(ctx.server, 'post', `${base}/notifications/${notification?.id}/read`, {
      token: guestA.token,
    });
    expect(marked.status).toBe(201);

    const after = await platformGet(`/platform/announcements/${id}/reads?limit=50`);
    const rowAfter = (after.body.data as AnnouncementReadRow[]).find(
      (row) => row.tenantId === customerA.tenantId,
    );
    expect(rowAfter?.reads).toBe(1);
    expect(rowAfter?.lastReadAt).not.toBeNull();
  });

  it('يحرس الرمز: بلا console.notifications.manage لا قائمة، والعميل لا يصل', async () => {
    // الدعم ليست له الكتابة ولا القائمة: الإعلان ليس متابعةً يومية للحالة.
    const refused = await platformGet('/platform/announcements?limit=5', support);
    expect(refused.status).toBe(403);
    const refusedWrite = await platformPost(
      '/platform/announcements',
      draft({ titleAr: 'من الدعم' }),
      support,
    );
    expect(refusedWrite.status).toBe(403);

    const tenantAttempt = await api(ctx.server, 'get', `${base}/platform/announcements`, {
      token: customerA.token,
    });
    expect(tenantAttempt.status).toBe(403);
  });

  it('يمنع العميل من تجاوز نصّ حدثٍ نطاقه المنصة (استدراك P-C7)', async () => {
    const attempt = await api(ctx.server, 'put', `${base}/email/templates/announcement?locale=ar`, {
      token: customerA.token,
      body: { body: 'نصٌّ من عندنا — {{title}}', reason: 'تحقّق P-C7' },
    });
    expect(attempt.status).toBe(422);

    // وحدث العميل يبقى قابلاً للتجاوز كما كان.
    const allowed = await api(ctx.server, 'put', `${base}/email/templates/payment.received?locale=ar`, {
      token: customerA.token,
      body: { body: 'شكراً {{name}} — استلمنا {{amount}} على {{invoice_no}}.', reason: 'تحقّق P-C7' },
    });
    expect(allowed.status).toBe(200);
  });
});
