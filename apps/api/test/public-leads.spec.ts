import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { env } from '@erp/config';
import {
  LEAD_HONEYPOT_FIELD,
  leadStatusLabelsAr,
  type LeadAccepted,
  type LeadConversion,
  type LeadView,
  type SubscriberAccepted,
} from '@erp/contracts';
import { newId, withPlatformAdminTx, withTenantTx } from '@erp/database';

import { RateLimiterService } from '../src/modules/platform/index.js';

import { api } from './http.js';
import { createActor, createTenantFixture, type Actor } from './fixtures.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * P-M6 — «التقاط العملاء المتوقّعين وإدارتهم» (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * وكل اختبار هنا يقيس حدًّا لا شاشة:
 *
 * 1. **المصيدة صامتة**: الطلب الآليّ لا يُنشئ صفّاً ولا يُرسل بريداً، ويُقابَل بـ202 — فلا
 *    نُعلّم الآلة أنها كُشِفت.
 * 2. **عنوانٌ واحد = طلبٌ واحد**: الطلب الثاني لا يُنشئ صفّاً، بل يُلحق رسالته ملاحظةً على
 *    الطلب القائم ويُسجّل ذلك أثراً — فلا يتّصل مندوبان بالشخص نفسه.
 * 3. **التحويل فعلٌ حقيقي**: منشأةٌ ومديرٌ ودليلُ حساباتٍ **وفرع**، وترخيصٌ بحالة `trialing`
 *    مدّته من إعداد `billing.trial_days`، والمدير يدخل فعلاً بعد التحويل، ومنشأته معزولة.
 * 4. **الحالة النهائية لا تعود**: `won` و`rejected` نهايةُ الطريق، والرجوع ملاحظةٌ لا حالة.
 * 5. **النشرة تأكيدٌ مزدوج**: لا `confirmed` إلا بفتح رابطٍ وُلد لحظة الطلب وخُزِّن مُجزَّأً.
 * 6. **الصلاحية تفصل**: `console.leads.view` يقرأ، و`console.leads.manage` وحده يحوّل — والـAPI
 *    هو الحاكم لا الشاشة.
 */
describe('public leads (P-M6)', () => {
  let ctx: TestApp;
  let operator: Actor;
  let support: Actor;
  let planId: string;

  const LEADS = '/api/v1/public/leads';
  const SUBSCRIBE = '/api/v1/public/subscribe';
  const QUEUE = '/api/v1/platform/leads';

  const post = (path: string, body: Record<string, unknown>, token?: string) =>
    api(ctx.server, 'post', path, { body, ...(token ? { token } : {}) });
  const get = (path: string, token?: string) => api(ctx.server, 'get', path, token ? { token } : {});
  const patch = (path: string, body: Record<string, unknown>, token: string) =>
    api(ctx.server, 'patch', path, { body, token });

  const unique = () => Math.random().toString(36).slice(2, 8);

  const leadBody = (overrides: Record<string, unknown> = {}) => ({
    fullName: 'سالم العمري',
    companyName: `مؤسسة ${unique()}`,
    email: `lead.${unique()}@leads.test`,
    phone: '+967700000000',
    branchCount: 3,
    planInterest: 'business',
    message: 'نحتاج نظاماً لفروعنا الثلاثة، ونريد عرضاً قبل نهاية الشهر.',
    locale: 'ar',
    acceptsMarketing: true,
    utm: { source: 'google', medium: 'cpc', campaign: 'ramadan-2026' },
    ...overrides,
  });

  const capture = async (overrides: Record<string, unknown> = {}) => {
    const body = leadBody(overrides);
    const response = await post(LEADS, body);
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    return { email: String(body.email).toLowerCase(), data: (response.body as { data: LeadAccepted }).data };
  };

  const leadRow = async (email: string): Promise<Record<string, unknown> | null> => {
    const result = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT * FROM leads WHERE dedupe_key = ${email.toLowerCase()} LIMIT 1`),
    );
    return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
  };

  /** عدد رسائل حدثٍ ما إلى عنوان — يُقاس من سجلّ البريد لا من الاستجابة. */
  const mailCount = async (event: string, email: string): Promise<number> => {
    const result = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`
        SELECT count(*)::int AS n FROM email_messages
         WHERE event = ${event} AND lower(to_email) = ${email.toLowerCase()}
      `),
    );
    return Number((result.rows[0] as { n: number }).n);
  };

  const confirmLink = async (email: string): Promise<string> => {
    const result = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`
        SELECT body FROM email_messages
         WHERE event = 'subscriber.confirm' AND lower(to_email) = ${email.toLowerCase()}
         ORDER BY created_at DESC LIMIT 1
      `),
    );
    const body = String((result.rows[0] as { body?: string } | undefined)?.body ?? '');
    const match = body.match(/\/api\/v1\/public\/subscribe\/confirm\/([0-9a-f]{48})/);
    expect(match, `لا رابط تأكيد في نصّ الرسالة: ${body.slice(0, 160)}`).not.toBeNull();
    return String(match?.[1]);
  };

  beforeAll(async () => {
    ctx = await createTestApp('public-leads');

    // منشأة المشغّلين: إعدادات المنصّة وبريدها المنصّي (بلا مستأجر) يُسجَّل باسمها.
    await createTenantFixture(ctx.db.ownerUrl, {
      code: process.env.PLATFORM_TENANT_CODE ?? 'platform',
      name: 'منشأة المشغّلين',
      status: 'active',
    });

    operator = await createActor(ctx, {
      tenantCode: 'm6-ops',
      tenantName: 'مشغّلو M6',
      email: 'owner@m6-ops.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_owner'],
    });

    // مندوب دعم: يقرأ الطابور ولا يحوّل — الفرق بين الرمزين يُقاس هنا لا في الشاشة.
    support = await createActor(ctx, {
      tenantCode: 'm6-support',
      tenantName: 'دعم M6',
      email: 'support@m6-support.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_support'],
    });

    const created = await api(ctx.server, 'post', '/api/v1/platform/plans', {
      token: operator.token,
      body: { code: 'm6-business', name: 'باقة الأعمال', interval: 'month', amount: '249.00' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    planId = String((created.body as { data: { id: string } }).data.id);

    // التجربة **إعدادٌ لا ثابت**: يُكتب هنا 7 أيام، ويُقاس أثرُه على الترخيص المُصدَر.
    await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`
        INSERT INTO platform_settings (id, key, tenant_id, value, updated_at)
        VALUES (${newId()}::uuid, 'billing.trial_days', NULL, '7'::jsonb, now())
        ON CONFLICT (key, tenant_id) DO UPDATE SET value = '7'::jsonb, updated_at = now()
      `),
    );
  });

  /** دلو `public-form` (١٠/دقيقة) مقصودٌ في الإنتاج وضارٌّ هنا: كل اختبار يُرسل استمارة. */
  beforeEach(() => {
    ctx.app.get(RateLimiterService).reset();
  });

  afterAll(async () => {
    await ctx.close();
  });

  // ═══════════════════════════════════════════════════ ١ · الالتقاط

  it('المصيدة: الطلب الآليّ لا يُحفظ ولا يُرسل له بريد', async () => {
    const body = leadBody({ [LEAD_HONEYPOT_FIELD]: 'http://spam.example' });
    const response = await post(LEADS, body);
    expect(response.status).toBe(202);
    expect((response.body as { data: LeadAccepted }).data).toEqual({ received: true, reference: 'L-00000000' });
    expect(await leadRow(String(body.email))).toBeNull();
    expect(await mailCount('lead.received', String(body.email))).toBe(0);
  });

  it('طلبٌ صحيح يُحفظ بكل حقوله ويُقال لصاحبه مرجعٌ قصير', async () => {
    const body = leadBody();
    const response = await post(LEADS, body);
    expect(response.status).toBe(202);
    const { reference } = (response.body as { data: LeadAccepted }).data;
    expect(reference).toMatch(/^L-[0-9A-F]{12}$/);

    const row = await leadRow(String(body.email));
    expect(row, 'الطلب لم يُحفظ').not.toBeNull();
    expect(row?.reference).toBe(reference);
    expect(row?.status).toBe('new');
    expect(row?.source).toBe('form');
    expect(Number(row?.branch_count)).toBe(3);
    expect(row?.utm).toMatchObject({ source: 'google', medium: 'cpc', campaign: 'ramadan-2026' });
    expect(row?.accepts_marketing).toBe(true);
  });

  it('البريد يُطبَّع: العنوان نفسه بحروفٍ كبيرة لا يُنشئ طلباً ثانياً', async () => {
    const body = leadBody({ email: `Mixed.${unique()}@Leads.Test` });
    const first = await post(LEADS, body);
    const second = await post(LEADS, { ...body, email: String(body.email).toUpperCase() });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);

    const stored = await leadRow(String(body.email));
    expect(stored?.email).toBe(String(body.email).toLowerCase());
    const count = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM leads WHERE dedupe_key = ${String(body.email).toLowerCase()}`),
    );
    expect(Number((count.rows[0] as { n: number }).n)).toBe(1);
  });

  it('طلبٌ ثانٍ من العنوان نفسه: لا صفّ جديد، بل ملاحظةٌ وأثرٌ بنفس المرجع', async () => {
    const body = leadBody();
    const first = await post(LEADS, body);
    const reference = (first.body as { data: LeadAccepted }).data.reference;

    const second = await post(LEADS, { ...body, message: 'تعديل: لدينا فرعان لا ثلاثة، والمعرض قريب.' });
    expect(second.status).toBe(202);
    expect((second.body as { data: LeadAccepted }).data.reference).toBe(reference);

    const lead = await leadRow(String(body.email));
    const leadId = String(lead?.id);
    const notes = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT body, author_label FROM lead_notes WHERE lead_id = ${leadId} ORDER BY created_at`),
    );
    expect(notes.rows).toHaveLength(1);
    expect(String((notes.rows[0] as { body: string }).body)).toContain('تعديل: لدينا فرعان');

    const events = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT kind FROM lead_events WHERE lead_id = ${leadId} ORDER BY created_at`),
    );
    const kinds = events.rows.map((row) => String((row as { kind: string }).kind));
    expect(kinds).toContain('lead.created');
    expect(kinds).toContain('lead.duplicated');
    // ورسالة استلامٍ واحدة لا ثنتان (الطلب الثاني لا يزعج صاحبه برسالةٍ ثانية).
    expect(await mailCount('lead.received', String(body.email))).toBe(1);
  });

  it('استمارةٌ ناقصة تُرفض 400 بحقلٍ مُسمّى', async () => {
    const response = await post(LEADS, { fullName: 'أ', email: 'not-an-email', message: 'قصيرة' });
    expect(response.status).toBe(400);
    expect(String((response.body as { code?: string }).code)).toBe('VALIDATION_FAILED');
  });

  it('محدّد المعدّل يحرس الباب العامّ: بعد الحدّ يُرفض الطلب 429', async () => {
    for (let index = 0; index < env.RATE_LIMIT_PUBLIC_FORM_PER_MINUTE; index += 1) {
      const response = await post(LEADS, leadBody());
      expect(response.status).toBe(202);
    }
    const blocked = await post(LEADS, leadBody());
    expect(blocked.status).toBe(429);
    expect(String((blocked.body as { code?: string }).code)).toBe('RATE_LIMITED');
  });

  // ═══════════════════════════════════════════════════ ٢ · الطابور

  it('الطابور: العدّادات وترتيب المفتوح أوّلاً، والبحث بالمرجع', async () => {
    const fresh = await capture();
    const queue = await get(QUEUE, operator.token);
    expect(queue.status).toBe(200);
    const payload = queue.body as { data: LeadView[]; counts: Record<string, number>; unassigned: number };
    expect(payload.data.length).toBeGreaterThan(0);
    // `?? 0` لأن `Record<string, number>` مع `noUncheckedIndexedAccess` يُعيد `number | undefined`.
    expect(payload.counts.new ?? 0).toBeGreaterThan(0);
    expect(payload.unassigned).toBeGreaterThanOrEqual(payload.counts.new ?? 0);
    // الجديد في رأس القائمة: الطابور أداة عملٍ لا أرشيف.
    expect(payload.data[0]?.status).toBe('new');

    const search = await get(`${QUEUE}?q=${fresh.data.reference}`, operator.token);
    const found = (search.body as { data: LeadView[] }).data;
    expect(found).toHaveLength(1);
    expect(found[0]?.email).toBe(fresh.email);
  });

  it('الإسناد إلى مشغّلٍ نشط يُسجَّل، وإلى غير نشطٍ يُرفض 422', async () => {
    const body = leadBody();
    await post(LEADS, body);
    const lead = await leadRow(String(body.email));
    const id = String(lead?.id);

    const assigned = await patch(`${QUEUE}/${id}`, { assignedTo: operator.userId }, operator.token);
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect((assigned.body as { data: LeadView }).data.assignedTo).toBe(operator.userId);

    const events = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT kind, actor_label FROM lead_events WHERE lead_id = ${id} ORDER BY created_at DESC LIMIT 1`),
    );
    expect(String((events.rows[0] as { kind: string }).kind)).toBe('lead.assigned');

    const stranger = await patch(`${QUEUE}/${id}`, { assignedTo: '00000000-0000-4000-8000-000000000000' }, operator.token);
    expect(stranger.status).toBe(422);
  });

  it('الحالة النهائية لا تعود: من «مرفوض» إلى «قيد التواصل» ممنوع 422', async () => {
    const body = leadBody();
    await post(LEADS, body);
    const id = String((await leadRow(String(body.email)))?.id);

    const rejected = await patch(
      `${QUEUE}/${id}`,
      { status: 'rejected', reason: 'خارج نطاقنا الجغرافي حالياً' },
      operator.token,
    );
    expect(rejected.status).toBe(200);

    const reopen = await patch(`${QUEUE}/${id}`, { status: 'contacted' }, operator.token);
    expect(reopen.status).toBe(422);
    expect(String((reopen.body as { code?: string }).code)).toBe('LEAD_STATUS_LOCKED');
    expect((reopen.body as { detail?: string }).detail).toContain(leadStatusLabelsAr.rejected);

    const after = await leadRow(String(body.email));
    expect(after?.status).toBe('rejected');
  });

  it('الملاحظة تُخزَّن منسوبةً وتظهر في تفاصيل الطلب', async () => {
    const body = leadBody();
    await post(LEADS, body);
    const id = String((await leadRow(String(body.email)))?.id);

    const created = await post(`${QUEUE}/${id}/notes`, { body: 'اتصلنا، طلب عرضاً يوم الثلاثاء.' }, operator.token);
    expect(created.status).toBe(201);
    const detail = await get(`${QUEUE}/${id}`, operator.token);
    const payload = (detail.body as { data: { notes: Array<{ body: string; authorName: string | null }> } }).data;
    expect(payload.notes[0]?.body).toContain('اتصلنا');
    expect(payload.notes[0]?.authorName).toBeTruthy();
  });

  it('الصلاحية تفصل: الدعم يقرأ الطابور ولا يُسنِد ولا يحوّل', async () => {
    const read = await get(QUEUE, support.token);
    expect(read.status).toBe(200);

    const { data } = await capture();
    const id = await idOf(data.reference);

    const write = await patch(`${QUEUE}/${id}`, { status: 'contacted' }, support.token);
    expect(write.status).toBe(403);

    const convert = await post(`${QUEUE}/${id}/convert`, { planId }, support.token);
    expect(convert.status).toBe(403);

    const anonymous = await get(QUEUE);
    expect(anonymous.status).toBe(401);
  });

  // ═══════════════════════════════════════════════════ ٣ · التحويل

  it('التحويل: منشأةٌ ومديرٌ وفرعٌ ودليلٌ وترخيصُ تجربة — والمدير يدخل فعلاً', async () => {
    const body = leadBody({ companyName: `شركة التحويل ${unique()}` });
    await post(LEADS, body);
    const lead = await leadRow(String(body.email));
    const id = String(lead?.id);

    const converted = await post(`${QUEUE}/${id}/convert`, { planId, tenantCode: `m6-${unique()}` }, operator.token);
    expect(converted.status, JSON.stringify(converted.body)).toBe(201);
    const result = (converted.body as { data: LeadConversion }).data;

    // التجربة من الإعداد (7 أيام) لا من رقمٍ في الكود.
    expect(result.trialDays).toBe(7);
    expect(result.lead.status).toBe('won');
    expect(result.lead.convertedTenantId).toBe(result.tenantId);
    expect(result.subscriptionId).toBeTruthy();
    expect(result.tempPassword.length).toBeGreaterThanOrEqual(12);

    // المنشأة تعمل: فرعٌ ودليل حسابات (التجهيز الافتراضي) وترخيصٌ حيّ بحالة trialing.
    const counts = await withTenantTx(ctx.handle.db, result.tenantId, async (tx) => {
      const row = await tx.execute(sql`
        SELECT
          (SELECT count(*) FROM branches WHERE tenant_id = ${result.tenantId} AND is_active)::int AS branches,
          (SELECT count(*) FROM accounts WHERE tenant_id = ${result.tenantId})::int AS accounts,
          (SELECT count(*) FROM memberships WHERE tenant_id = ${result.tenantId} AND status = 'active')::int AS members
      `);
      return row.rows[0] as { branches: number; accounts: number; members: number };
    });
    expect(counts.branches).toBeGreaterThan(0);
    expect(counts.accounts).toBeGreaterThan(0);
    expect(counts.members).toBe(1);

    const licence = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`
        SELECT status, trial_ends_at FROM tenant_subscriptions WHERE id = ${result.subscriptionId}
      `),
    );
    const row = licence.rows[0] as { status: string; trial_ends_at: string };
    expect(row.status).toBe('trialing');
    const days = (new Date(row.trial_ends_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.5);
    expect(days).toBeLessThan(7.5);

    // والدخول حقيقي: المدير يدخل بكلمة المرور المؤقتة ويرى منشأته وحدها.
    const login = await post('/api/v1/auth/login', {
      tenantCode: result.tenantCode,
      email: result.ownerEmail,
      password: result.tempPassword,
    });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    const token = String((login.body as { data: { accessToken: string } }).data.accessToken);
    const accounts = await get('/api/v1/accounts', token);
    expect(accounts.status).toBe(200);
    expect((accounts.body as { data: unknown[] }).data).toHaveLength(counts.accounts);
  });

  it('التحويل مرّةً ثانية يُرفض 409 ولا يُنشئ منشأةً ثانية', async () => {
    const body = leadBody();
    await post(LEADS, body);
    const id = String((await leadRow(String(body.email)))?.id);

    const first = await post(`${QUEUE}/${id}/convert`, { planId }, operator.token);
    expect(first.status).toBe(201);

    const tenantsBefore = await countTenants();
    const again = await post(`${QUEUE}/${id}/convert`, { planId }, operator.token);
    expect(again.status).toBe(409);
    expect(String((again.body as { code?: string }).code)).toBe('LEAD_ALREADY_CONVERTED');
    expect(await countTenants()).toBe(tenantsBefore);
  });

  // ═══════════════════════════════════════════════════ ٤ · النشرة البريدية

  it('الاشتراك في النشرة: pending ثم تأكيدٌ من الرابط — والقائمة لا تكشف العنوان', async () => {
    const email = `news.${unique()}@leads.test`;
    const first = await post(SUBSCRIBE, { email });
    expect(first.status).toBe(202);
    expect((first.body as { data: SubscriberAccepted }).data.status).toBe('pending');

    const token = await confirmLink(email);
    const confirmed = await get(`/api/v1/public/subscribe/confirm/${token}`);
    expect(confirmed.status).toBe(200);
    expect((confirmed.body as { data: { status: string } }).data.status).toBe('confirmed');

    // الفتحة الثانية لا تغيّر شيئاً (idempotent)، والاشتراك الثاني لا يرسل رسالةً ثانية.
    const twice = await get(`/api/v1/public/subscribe/confirm/${token}`);
    expect(twice.status).toBe(200);
    const again = await post(SUBSCRIBE, { email });
    expect((again.body as { data: SubscriberAccepted }).data.status).toBe('confirmed');
    expect(await mailCount('subscriber.confirm', email)).toBe(1);
  });

  it('رابط تأكيدٍ مجهول = 404 بلا سرد', async () => {
    const wrong = await get(`/api/v1/public/subscribe/confirm/${'a'.repeat(48)}`);
    expect(wrong.status).toBe(404);
  });

  it('قائمة المشتركين تُقرأ بالرمز وتُدار بحالةٍ صريحة', async () => {
    const email = `managed.${unique()}@leads.test`;
    await post(SUBSCRIBE, { email });

    const list = await get('/api/v1/platform/leads/subscribers', operator.token);
    expect(list.status).toBe(200);
    const payload = list.body as { data: Array<{ id: string; email: string; status: string }>; counts: Record<string, number> };
    const found = payload.data.find((row) => row.email === email);
    expect(found).toBeTruthy();
    expect(payload.counts.pending).toBeGreaterThan(0);

    const updated = await patch(`/api/v1/platform/leads/subscribers/${found?.id}`, { status: 'unsubscribed' }, operator.token);
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect((updated.body as { data: { status: string } }).data.status).toBe('unsubscribed');
  });

  // ═══════════════════════════════════════════════════ أدوات

  const countTenants = async (): Promise<number> => {
    const result = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM tenants`),
    );
    return Number((result.rows[0] as { n: number }).n);
  };

  const idOf = async (reference: string): Promise<string> => {
    const result = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT id FROM leads WHERE reference = ${reference} LIMIT 1`),
    );
    return String((result.rows[0] as { id: string } | undefined)?.id);
  };

});
