import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { type CampaignReport, type CampaignView } from '@erp/contracts';
import { newId, withPlatformAdminTx } from '@erp/database';

import { RateLimiterService } from '../src/modules/platform/index.js';

import { api } from './http.js';
import { createActor, createTenantFixture, type Actor } from './fixtures.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * P-M7 — الحملات البريدية (`docs/roadmap/MARKETING_SITE_PLAN.md` §5، السطر P-M7).
 *
 * وكل اختبار هنا يقيس حدًّا لا شاشة:
 *
 * 1. **الشريحة قبل النصّ**: مَن يدخل الشريحة يُحسب من الجداول (موافقةٌ تسويقية، تأكيدُ
 *    اشتراك، حالةُ ترخيص) — لا قائمةً يكتبها المشغّل بيده.
 * 2. **الرمز سرّ ولا يُخزَّن**: الفتح والنقر والإلغاء تعمل بالرمز الذي خرج في الرسالة،
 *    ومخزَّنُه sha256 وحده؛ وطلبٌ برمزٍ باطل لا يُسجّل شيئاً.
 * 3. **لا تحويل مفتوح**: النقرة تُقبل لوجهةٍ من روابط الحملة نفسها، وما عداها 404.
 * 4. **الإلغاء حجرٌ عامّ**: يُكتب في `email_suppressions` فيمنع كل بريدٍ لاحقٍ لا هذه الحملة.
 * 5. **الحملة المرسلة لا تُعدَّل ولا تُلغى**، والمُلغاة لا يخرج منها شيء بعد الإلغاء.
 * 6. **رسالة الاختبار لا تُكتب في التقرير**، ولا تُحتسب على حصّة أحد.
 * 7. **الصفّ قبل البريد**: لكل مستلم صفٌّ في `campaign_messages` بحالة تسليمه، والتقرير
 *    يُقرأ منه لا من عدّاد.
 */
describe('platform campaigns (P-M7)', () => {
  let ctx: TestApp;
  let operator: Actor;
  /** طلبٌ موافقٌ على التسويق يُبذر قبل كل اختبار — شريحةٌ فيها أحدٌ دائماً. */
  let seededLead: string;
  let support: Actor;
  let planId: string;

  const CAMPAIGNS = '/api/v1/platform/campaigns';

  const post = (path: string, body: Record<string, unknown>, token?: string) =>
    api(ctx.server, 'post', path, { body, ...(token ? { token } : {}) });
  const get = (path: string, token?: string) => api(ctx.server, 'get', path, token ? { token } : {});
  const patch = (path: string, body: Record<string, unknown>, token: string) =>
    api(ctx.server, 'patch', path, { body, token });

  const unique = () => Math.random().toString(36).slice(2, 8);

  const draftBody = (overrides: Record<string, unknown> = {}) => ({
    name: `عرض ${unique()}`,
    subject: 'أهلاً {{name}} — عرضٌ لفروعك',
    body: 'مرحباً {{name}},\n\nاطلب عرضاً من https://erp.test/demo أو اقرأ [الأسعار](https://erp.test/pricing).',
    segment: 'leads',
    locale: 'ar',
    ...overrides,
  });

  /** إنشاء حملة عبر الـAPI — كما يفعل المشغّل، لا بإدراجٍ في القاعدة. */
  const createCampaign = async (overrides: Record<string, unknown> = {}): Promise<CampaignView> => {
    const response = await post(CAMPAIGNS, draftBody(overrides), operator.token);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return (response.body as { data: CampaignView }).data;
  };

  /** إرسالٌ فوري: `scheduledAt: null` — نفس ما يفعله زرّ «أرسل الآن». */
  const sendNow = async (id: string): Promise<CampaignView> => {
    const response = await post(`${CAMPAIGNS}/${id}/schedule`, { scheduledAt: null }, operator.token);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (response.body as { data: CampaignView }).data;
  };

  const addLead = async (overrides: { email?: string; marketing?: boolean; status?: string } = {}) => {
    const email = (overrides.email ?? `lead.${unique()}@pm7.test`).toLowerCase();
    // المرجع بالصيغة المفروضة في القاعدة (`leads_reference_check`): سِتّة عشرية كبيرة.
    const reference = `L-${Math.random().toString(16).slice(2, 10).toUpperCase().padEnd(8, '0')}`;
    await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`
        INSERT INTO leads (
          id, reference, full_name, company_name, email, dedupe_key, message, status,
          source, locale, accepts_marketing
        ) VALUES (
          ${newId()}, ${reference}, 'سالم العمري', 'مؤسسة النور', ${email},
          ${email}, 'نحتاج عرضاً لفروعنا الثلاثة قبل نهاية الشهر.', ${overrides.status ?? 'new'},
          'form', 'ar', ${overrides.marketing ?? true}
        )
      `),
    );
    return email;
  };

  const addSubscriber = async (status: 'confirmed' | 'pending'): Promise<string> => {
    const email = `news.${unique()}@pm7.test`;
    await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`
        INSERT INTO email_subscribers (id, email, dedupe_key, status, locale, source, confirmed_at)
        VALUES (${newId()}, ${email}, ${email}, ${status}, 'ar', 'newsletter',
                ${status === 'confirmed' ? sql`now()` : sql`null`})
      `),
    );
    return email;
  };

  const addTenant = async (status: 'trialing' | 'active' | 'past_due' | 'canceled'): Promise<string> => {
    const code = `pm7-${unique()}`;
    const owner = await createActor(ctx, {
      tenantCode: code,
      tenantName: `منشأة ${code}`,
      email: `${code}@tenants.test`,
      fullName: 'مالك المنشأة',
    });
    await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`
        INSERT INTO tenant_subscriptions (id, tenant_id, plan_id, status, provider, activated_at, canceled_at)
        VALUES (${newId()}, ${owner.tenantId}, ${planId}, ${status}, 'manual',
                ${status === 'canceled' ? sql`null` : sql`now()`},
                ${status === 'canceled' ? sql`now()` : sql`null`})
      `),
    );
    return owner.email.toLowerCase();
  };

  /**
   * الرمز الخام لا يوجد في القاعدة (المخزَّن sha256 وحده) — فيُقرأ من **نصّ الرسالة كما
   * خرجت**، كما قرأت P-M6 رابط التأكيد. وهذه هي القراءة الوحيدة التي يجوز أن يقوم بها اختبار.
   */
  const lastLinks = async (email: string) => {
    const rows = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`
        SELECT id, body, html, headers, status FROM email_messages
         WHERE event = 'campaign.message' AND lower(to_email) = ${email.toLowerCase()}
         ORDER BY created_at DESC LIMIT 1
      `),
    );
    const row = rows.rows[0] as { id: string; body: string; html: string; headers: unknown; status: string } | undefined;
    expect(row, `لا رسالة حملة إلى ${email}`).toBeDefined();
    const body = String(row?.body ?? '');
    // البكسل في نسخة HTML وحدها (نصٌّ مجرّد لا يُحمّل صورة)، ورابط الإلغاء في النصّ والـHTML.
    const html = String(row?.html ?? '');
    const token = html.match(/track\/open\/([A-Za-z0-9_-]{16,})/)?.[1];
    const unsubscribe = body.match(/unsubscribe\?token=([A-Za-z0-9_-]{16,})/)?.[1];
    expect(token, `لا رابط بكسل في نسخة HTML: ${html.slice(0, 200)}`).toBeDefined();
    expect(unsubscribe, `لا رابط إلغاء في نصّ الرسالة: ${body.slice(-260)}`).toBeDefined();
    return { messageId: String(row?.id), token: String(token), unsubscribe: String(unsubscribe), body, row: row! };
  };

  const campaignRow = async (id: string): Promise<Record<string, unknown>> => {
    const rows = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT * FROM email_campaigns WHERE id = ${id}`),
    );
    return rows.rows[0] as Record<string, unknown>;
  };

  const messageRows = async (campaignId: string): Promise<Array<Record<string, unknown>>> => {
    const rows = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`
        SELECT * FROM campaign_messages WHERE campaign_id = ${campaignId} ORDER BY created_at ASC
      `),
    );
    return rows.rows as Array<Record<string, unknown>>;
  };

  const eventCount = async (campaignId: string, kind: string): Promise<number> => {
    const rows = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`
        SELECT count(*)::int AS n FROM campaign_events
         WHERE campaign_id = ${campaignId} AND kind = ${kind}
      `),
    );
    return Number((rows.rows[0] as { n: number }).n);
  };

  beforeAll(async () => {
    ctx = await createTestApp('platform-campaigns');

    // منشأة المشغّلين: مهمّات الطابور تُسجَّل باسمها (`outbox_jobs.tenant_id` غير فارغ).
    await createTenantFixture(ctx.db.ownerUrl, {
      code: process.env.PLATFORM_TENANT_CODE ?? 'platform',
      name: 'منشأة المشغّلين',
      status: 'active',
    });

    operator = await createActor(ctx, {
      tenantCode: 'pm7-ops',
      tenantName: 'مشغّلو M7',
      email: 'owner@pm7-ops.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_owner'],
    });

    // دعم: يقرأ العملاء المتوقّعين (P-M6) لكنه **لا يملك رمز الحملات** — والفصل يُقاس هنا.
    support = await createActor(ctx, {
      tenantCode: 'pm7-support',
      tenantName: 'دعم M7',
      email: 'support@pm7-support.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_support'],
    });

    const created = await post(
      '/api/v1/platform/plans',
      { code: 'pm7-business', name: 'باقة الأعمال', interval: 'month', amount: '249.00' },
      operator.token,
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    planId = String((created.body as { data: { id: string } }).data.id);
  });

  /**
   * دلو `campaign-track` مقصودٌ في الإنتاج وضارٌّ هنا: كل اختبار يُحمّل بكسل ويُنقر.
   * و**طلبٌ موافقٌ على التسويق** يُبذر قبل كل اختبار، فكل اختبار يقيس ما جاء له لا ما تركه
   * غيره (والترتيب لا يكون شرطاً في نجاح اختبار).
   */
  beforeEach(async () => {
    ctx.app.get(RateLimiterService).reset();
    seededLead = await addLead({ marketing: true });
  });

  afterAll(async () => {
    await ctx.close();
  });

  // ═══════════════════════════════════════════════════ ١ · الشرائح والحكم

  it('رمز الحملات لا يُشارَك مع الدعم: من يقرأ العملاء المتوقّعين لا يُرسل حملة', async () => {
    expect((await get(CAMPAIGNS, support.token)).status).toBe(403);
    expect((await get(CAMPAIGNS, operator.token)).status).toBe(200);
  });

  it('الشرائح بأعدادٍ حقيقية تتحرّك مع البيانات — والتنبيه على ما لا أحد فيه', async () => {
    const read = async () => {
      const response = await get(`${CAMPAIGNS}/segments`, operator.token);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return (response.body as {
        data: Array<{ segment: string; count: number; warningAr: string | null; audience: string }>;
      }).data;
    };

    const before = await read();
    expect(before).toHaveLength(6);
    // التنبيه ليس زخرفة: كل شريحةٍ فارغة تحمل تنبيهاً، وكل شريحةٍ فيها الناس بلا تنبيه.
    for (const row of before) expect(Boolean(row.warningAr), row.segment).toBe(row.count === 0);
    // وشرائح الحسابات معلَنةٌ حساباً، وشرائح الأشخاص معلَنةٌ أشخاصاً (أساس الامتثال).
    expect(before.find((row) => row.segment === 'leads')?.audience).toBe('people');
    expect(before.find((row) => row.segment === 'active')?.audience).toBe('account');

    const leadsBefore = before.find((row) => row.segment === 'leads')!.count;
    await addLead({ marketing: true });
    await addLead({ marketing: false });
    // الموافقة جزءٌ من التعريف: طلبان أُضيفا، وواحدٌ فقط دخل الشريحة.
    const after = await read();
    expect(after.find((row) => row.segment === 'leads')?.count).toBe(leadsBefore + 1);
  });

  it('نصٌّ بمتغيّرٍ غير معروف لا يُحفظ — من الآن لا عند الإرسال', async () => {
    const response = await post(
      CAMPAIGNS,
      draftBody({ body: 'مرحباً {{name}} — خصم {{discount}} لك.' }),
      operator.token,
    );
    expect(response.status).toBe(422);
    expect((response.body as { code: string }).code).toBe('CAMPAIGN_BODY_INVALID');
  });

  it('المسوّدة تُحفظ بمتغيّراتها وروابطها — والشاشة تقرأها قبل الإرسال', async () => {
    const campaign = await createCampaign({ name: 'مسوّدة الشهر' });
    expect(campaign.status).toBe('draft');
    expect(campaign.statusLabelAr).toBe('مسوّدة');
    expect(campaign.segmentLabelAr).toBe('عملاء متوقّعون');
    expect(campaign.variables).toEqual(['name']);
    expect(campaign.hyperlinks).toEqual(['https://erp.test/demo', 'https://erp.test/pricing']);
    expect(campaign.totals.recipients).toBe(0);
  });

  it('حملةٌ إلى شريحةٍ فارغة تُرفض 422 ولا تُعلَن «أُرسلت»', async () => {
    // «المتسربون» لا أحد فيه في هذا الجناح (لا اشتراكَ ملغى أو منتهياً) — فالفحص حتميّ.
    expect(
      (await get(`${CAMPAIGNS}/segments`, operator.token)).body as {
        data: Array<{ segment: string; count: number }>;
      },
    ).toBeTruthy();
    const campaign = await createCampaign({ segment: 'churned' });
    const response = await post(`${CAMPAIGNS}/${campaign.id}/schedule`, { scheduledAt: null }, operator.token);
    expect(response.status).toBe(422);
    expect((response.body as { code: string }).code).toBe('CAMPAIGN_SEGMENT_EMPTY');
    expect((await campaignRow(campaign.id)).status).toBe('draft');
  });

  // ═══════════════════════════════════════════════════ ٢ · الإرسال

  it('الجدولة في المستقبل لا تُرسل شيئاً — ويُكتب موعدُها', async () => {
    const campaign = await createCampaign();
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const response = await post(`${CAMPAIGNS}/${campaign.id}/schedule`, { scheduledAt: at }, operator.token);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const view = (response.body as { data: CampaignView }).data;
    expect(view.status).toBe('scheduled');
    expect(view.scheduledAt).toBe(at);
    expect(await messageRows(campaign.id)).toHaveLength(0);

    // المهمّة في الطابور بوقت التنفيذ نفسه — الطابور يوقظ والمسح يكفل.
    const jobs = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`
        SELECT type, payload, run_at FROM outbox_jobs
         WHERE type = 'campaign.send' AND payload->>'campaignId' = ${campaign.id}
      `),
    );
    expect(jobs.rows).toHaveLength(1);
  });

  it('الإرسال الفوري: صفٌّ لكل من في الشريحة، ورسالةٌ لكل صفّ', async () => {
    const consented = await addLead({ marketing: true });
    const notConsented = await addLead({ marketing: false });
    // محجوبٌ من قبل (ارتداد) — تُنشأ له رسالةٌ «لم تُرسل» بسببٍ مكتوب، ولا يخرج بريد.
    const suppressed = await addLead({ marketing: true });
    await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`
        INSERT INTO email_suppressions (id, tenant_id, email, reason, note)
        VALUES (${newId()}, NULL, ${suppressed}, 'bounce', 'ارتدادٌ من مزوّد البريد')
      `),
    );

    const campaign = await createCampaign();
    const sent = await sendNow(campaign.id);
    expect(sent.status).toBe('sent');

    const rows = await messageRows(campaign.id);
    const emails = rows.map((row) => String(row.email));
    expect(emails).toContain(seededLead);
    expect(emails).toContain(consented);
    expect(emails).toContain(suppressed);
    // من لم يوافق لا يُدرَج في الشريحة أصلاً — ولا يُقال له «لم تُرسل».
    expect(emails).not.toContain(notConsented);

    const consentedRow = rows.find((row) => row.email === consented);
    expect(consentedRow?.status).toBe('sent');
    expect(consentedRow?.email_message_id).not.toBeNull();
    // الرمز مُجزَّأ (sha256) — والخام لا يظهر في أي عمود.
    expect(consentedRow?.track_token_hash).toMatch(/^[0-9a-f]{64}$/);

    const suppressedRow = rows.find((row) => row.email === suppressed);
    expect(suppressedRow?.status).toBe('skipped');
    expect(String(suppressedRow?.detail)).toContain('محجوب');

    const report = await get(`${CAMPAIGNS}/${campaign.id}/report`, operator.token);
    const data = (report.body as { data: CampaignReport }).data;
    expect(data.totals.recipients).toBe(rows.length);
    expect(data.totals.sent).toBe(rows.filter((row) => row.status === 'sent').length);
    expect(data.totals.skipped).toBe(1);
    expect(data.totals.failed).toBe(0);
    expect(data.campaign.status).toBe('sent');
    expect(data.messages.every((message) => message.statusLabelAr.length > 2)).toBe(true);
  });

  it('العنوان نفسه في شريحةٍ واحدة مرّةً واحدة: فهرسٌ فريد يحرس', async () => {
    const campaign = await createCampaign();
    await sendNow(campaign.id);
    const rows = await messageRows(campaign.id);
    const emails = rows.map((row) => String(row.email));
    expect(new Set(emails).size).toBe(emails.length);

    // والصفّ المكرَّر مرفوضٌ في القاعدة نفسها، لا في الكود وحده.
    await expect(
      withPlatformAdminTx(ctx.handle.db, (tx) =>
        tx.execute(sql`
          INSERT INTO campaign_messages (id, campaign_id, email, status, track_token_hash, links)
          VALUES (${newId()}, ${campaign.id}, ${emails[0]}, 'pending', 'x', '[]'::jsonb)
        `),
      ),
    ).rejects.toThrow();
  });

  it('شرائح الحسابات: مالك المنشأة هو الوجهة، والترخيص هو المُدخِل', async () => {
    const trialing = await addTenant('trialing');
    const active = await addTenant('active');
    expect(trialing).not.toBe(active);

    const campaign = await createCampaign({ segment: 'trialing' });
    await sendNow(campaign.id);
    const emails = (await messageRows(campaign.id)).map((row) => String(row.email));
    expect(emails).toContain(trialing);
    expect(emails).not.toContain(active);

    // ورسالةُ الخدمة تحمل منشأتها: فتظهر في سجلّ بريد العميل ويسري عليها حجرُه.
    const rows = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`
        SELECT tenant_id FROM email_messages
         WHERE event = 'campaign.message' AND lower(to_email) = ${trialing}
      `),
    );
    expect(rows.rows[0]?.tenant_id).not.toBeNull();
  });

  // ═══════════════════════════════════════════════════ ٣ · الزحف

  it('بكسل الفتح: صورةٌ في كل حال، وفتحٌ واحد يُسجَّل مرّة', async () => {
    const email = await addLead({ marketing: true });
    const campaign = await createCampaign();
    await sendNow(campaign.id);
    const { token } = await lastLinks(email);

    const first = await get(`/api/v1/public/track/open/${token}`);
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toContain('image/gif');
    const second = await get(`/api/v1/public/track/open/${token}`);
    expect(second.status).toBe(200);

    expect(await eventCount(campaign.id, 'opened')).toBe(1);
    const row = (await messageRows(campaign.id)).find((entry) => entry.email === email);
    expect(row?.opened_at).not.toBeNull();
  });

  it('النقرة تُوجّه إلى وجهة الحملة، ووجهةٌ غريبة أو رمزٌ مجهول ⇒ 404', async () => {
    const email = await addLead({ marketing: true });
    const campaign = await createCampaign();
    await sendNow(campaign.id);
    const { token } = await lastLinks(email);

    const click = await get(`/api/v1/public/track/click/${token}/0`);
    expect(click.status).toBe(302);
    expect(click.headers['location']).toBe('https://erp.test/demo');
    expect(await eventCount(campaign.id, 'clicked')).toBe(1);

    // لا تحويل مفتوح: ترتيبٌ ليس في روابط الحملة.
    expect((await get(`/api/v1/public/track/click/${token}/7`)).status).toBe(404);
    // ولا رمزَ مُخترع.
    expect((await get('/api/v1/public/track/click/aaaaaaaaaaaaaaaaaaaaaaaa/0')).status).toBe(404);
    expect((await get('/api/v1/public/track/open/short')).status).toBe(200);

    const report = await get(`${CAMPAIGNS}/${campaign.id}/report`, operator.token);
    const data = (report.body as { data: CampaignReport }).data;
    expect(data.totals.clicked).toBe(1);
    expect(data.links[0]).toEqual({ url: 'https://erp.test/demo', clicks: 1 });
  });

  it('الرسالة تحمل ترويسات النقرة الواحدة ورابطَ إلغاءٍ لا يُزحف', async () => {
    const email = await addLead({ marketing: true });
    const campaign = await createCampaign();
    await sendNow(campaign.id);
    const { body, row } = await lastLinks(email);

    const headers = row.headers as Record<string, string>;
    expect(headers['List-Unsubscribe']).toContain('/unsubscribe?token=');
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(row.html).toContain('/api/v1/public/track/open/');
    const unsubscribeLine = body.split('\n').find((line) => line.includes('لإلغاء الاشتراك'));
    expect(unsubscribeLine).toContain('/unsubscribe?token=');
    expect(unsubscribeLine).not.toContain('/track/click/');

    const report = await get(`${CAMPAIGNS}/${campaign.id}/report`, operator.token);
    expect((report.body as { data: CampaignReport }).data.campaign.name).toBe(campaign.name);
  });

  it('إلغاء الاشتراك من الحملة: حجرٌ عامّ، والمشترك يُعلَّم، والحملة التالية لا ترسل إليه', async () => {
    const subscriber = await addSubscriber('confirmed');
    const campaign = await createCampaign({ segment: 'subscribers' });
    await sendNow(campaign.id);
    const { unsubscribe } = await lastLinks(subscriber);

    const response = await get(`/api/v1/public/unsubscribe/${unsubscribe}`);
    expect(response.status).toBe(200);
    expect((response.body as { data: { unsubscribed: boolean } }).data.unsubscribed).toBe(true);

    // حجرٌ **عامّ** (`tenant_id IS NULL`): يسري على كل بريد المنصّة، لا على هذه الحملة.
    const suppressions = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT tenant_id, reason FROM email_suppressions WHERE email = ${subscriber}`),
    );
    expect(suppressions.rows[0]?.tenant_id).toBeNull();
    expect(suppressions.rows[0]?.reason).toBe('unsubscribe');

    const state = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT status, confirmed_at FROM email_subscribers WHERE dedupe_key = ${subscriber}`),
    );
    expect(state.rows[0]?.status).toBe('unsubscribed');
    expect(state.rows[0]?.confirmed_at).toBeNull();

    expect(await eventCount(campaign.id, 'unsubscribed')).toBe(1);
    // الفتحة الثانية لا تغيّر شيئاً (idempotent) — وتُقبَل بلا خطأ.
    expect((await get(`/api/v1/public/unsubscribe/${unsubscribe}`)).status).toBe(200);
    expect(await eventCount(campaign.id, 'unsubscribed')).toBe(1);

    // والحملة التالية: من خرج من تعريف الشريحة لا يُدرج، ومن بقي محجوباً يُوسم «لم تُرسل».
    await addSubscriber('confirmed');
    const lead = await addLead({ marketing: true });
    const next = await createCampaign();
    await sendNow(next.id);
    const leadRow = (await messageRows(next.id)).find((row) => row.email === lead);
    expect(leadRow?.status).toBe('sent');

    const leadLinks = await lastLinks(lead);
    await get(`/api/v1/public/unsubscribe/${leadLinks.unsubscribe}`);
    const after = await createCampaign();
    await sendNow(after.id);
    const skipped = (await messageRows(after.id)).find((row) => row.email === lead);
    expect(skipped?.status).toBe('skipped');
    expect(String(skipped?.detail)).toContain('محجوب');
  });

  it('نقرة الإلغاء الواحدة تُقبَل بـPOST بلا صفحةٍ وسيطة (RFC 8058)', async () => {
    const email = await addLead({ marketing: true });
    const campaign = await createCampaign();
    await sendNow(campaign.id);
    const { unsubscribe } = await lastLinks(email);

    const response = await post(`/api/v1/public/unsubscribe/${unsubscribe}`, {}, undefined);
    expect(response.status).toBe(200);
    expect((response.body as { data: { unsubscribed: boolean } }).data.unsubscribed).toBe(true);

    const suppressed = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM email_suppressions WHERE email = ${email}`),
    );
    expect(Number((suppressed.rows[0] as { n: number }).n)).toBe(1);

    // ورابطٌ مجهول 404 — لا كشفَ لأي عنوان.
    expect((await get('/api/v1/public/unsubscribe/aaaaaaaaaaaaaaaaaaaaaaaa')).status).toBe(404);
  });

  // ═══════════════════════════════════════════════════ ٤ · القيود

  it('حملةٌ بدأ إرسالها لا تُعدَّل ولا تُلغى', async () => {
    const campaign = await createCampaign();
    await sendNow(campaign.id);

    const edited = await patch(`${CAMPAIGNS}/${campaign.id}`, { subject: 'عنوانٌ جديد' }, operator.token);
    expect(edited.status).toBe(422);
    expect((edited.body as { code: string }).code).toBe('CAMPAIGN_LOCKED');

    const canceled = await post(
      `${CAMPAIGNS}/${campaign.id}/cancel`,
      { reason: 'تغيّر العرض' },
      operator.token,
    );
    expect(canceled.status).toBe(422);
    expect((canceled.body as { code: string }).code).toBe('CAMPAIGN_LOCKED');
  });

  it('الإلغاء قبل الإرسال يُوسم البقية «لم تُرسل» ولا يخرج بعدها شيء', async () => {
    await addLead({ marketing: true });
    const campaign = await createCampaign();
    const at = new Date(Date.now() + 3_600_000).toISOString();
    await post(`${CAMPAIGNS}/${campaign.id}/schedule`, { scheduledAt: at }, operator.token);

    const response = await post(
      `${CAMPAIGNS}/${campaign.id}/cancel`,
      { reason: 'أُجّل العرض للأسبوع القادم' },
      operator.token,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const view = (response.body as { data: CampaignView }).data;
    expect(view.status).toBe('canceled');
    expect(view.canceledReason).toBe('أُجّل العرض للأسبوع القادم');

    // الدفع بعد الإلغاء لا يكتب صفوفاً ولا يُرسل — وقد كان مجدولاً.
    const dispatched = await post(`${CAMPAIGNS}/${campaign.id}/dispatch`, {}, operator.token);
    expect((dispatched.body as { data: { dispatched: number } }).data.dispatched).toBe(0);
    expect(await messageRows(campaign.id)).toHaveLength(0);
    expect(await eventCount(campaign.id, 'canceled')).toBe(1);
    // وحتى لو حان وقتها: المسح يتخطّاها.
    await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`UPDATE email_campaigns SET scheduled_at = now() - interval '1 minute' WHERE id = ${campaign.id}`),
    );
    const sweep = await get(CAMPAIGNS, operator.token);
    expect(sweep.status).toBe(200);
    expect(await messageRows(campaign.id)).toHaveLength(0);
  });

  it('رسالة الاختبار: تخرج موسومةً تجربةً ولا تُكتب في تقرير الحملة', async () => {
    const email = await addLead({ marketing: true });
    const campaign = await createCampaign();
    const before = (await messageRows(campaign.id)).length;

    const response = await post(
      `${CAMPAIGNS}/${campaign.id}/send-test`,
      { to: 'qa@pm7.test' },
      operator.token,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const result = (response.body as { data: { status: string; trackingDisabled: boolean } }).data;
    expect(result.status).toBe('sent');
    expect(result.trackingDisabled).toBe(true);

    expect((await messageRows(campaign.id)).length).toBe(before);
    const message = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`
        SELECT is_test, status FROM email_messages
         WHERE event = 'campaign.message' AND to_email = 'qa@pm7.test'
         ORDER BY created_at DESC LIMIT 1
      `),
    );
    expect(message.rows[0]?.status).toBe('sent');

    // ولم تُحرّك أرقام أحد: رسالةُ اختبارٍ ليست استهلاكاً.
    const report = await get(`${CAMPAIGNS}/${campaign.id}/report`, operator.token);
    expect((report.body as { data: CampaignReport }).data.totals.recipients).toBe(before);
    expect(email).toBeTruthy();
  });

  it('التقرير يرتّب الروابط ويعدّ الفتح والنقر لكل مستلم', async () => {
    const email = await addLead({ marketing: true });
    const campaign = await createCampaign();
    await sendNow(campaign.id);
    const { token } = await lastLinks(email);

    await get(`/api/v1/public/track/open/${token}`);
    await get(`/api/v1/public/track/click/${token}/0`);
    await get(`/api/v1/public/track/click/${token}/1`);

    const report = await get(`${CAMPAIGNS}/${campaign.id}/report`, operator.token);
    const data = (report.body as { data: CampaignReport }).data;
    expect(data.links).toEqual([
      { url: 'https://erp.test/demo', clicks: 1 },
      { url: 'https://erp.test/pricing', clicks: 1 },
    ]);

    const mine = data.messages.find((entry) => entry.email === email);
    expect(mine?.statusLabelAr).toBe('أُرسلت');
    expect(mine?.openedAt).not.toBeNull();
    expect(mine?.clickedAt).not.toBeNull();
    expect(mine?.clickCount).toBe(2);
    expect(mine?.lastClickedUrl).toBe('https://erp.test/pricing');

    // والأحداث مرتّبة بالأحدث، وفيها الأنواع الأربعة التي وقعت.
    const kinds = data.events.map((event) => event.kind);
    expect(kinds).toContain('sent');
    expect(kinds).toContain('opened');
    expect(kinds).toContain('clicked');
    expect(data.segmentsNoteAr.length).toBeGreaterThan(5);
  });

  it('البحث ومرشّح الحالة يعملان، والعدّادات لكل حالة', async () => {
    const list = await get(`${CAMPAIGNS}?status=sent&limit=5`, operator.token);
    expect(list.status).toBe(200);
    const payload = list.body as {
      data: CampaignView[];
      meta: { total: number };
      counts: Record<string, number>;
    };
    expect(payload.data.every((entry) => entry.status === 'sent')).toBe(true);
    expect(payload.meta.total).toBeGreaterThan(0);
    expect(payload.counts.sent).toBeGreaterThan(0);

    const searched = await get(`${CAMPAIGNS}?q=مسوّدة الشهر`, operator.token);
    expect((searched.body as { data: CampaignView[] }).data.length).toBe(1);
  });
});
