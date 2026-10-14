import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { sql } from 'drizzle-orm';
import {
  SIGNUP_CODE_TTL_MINUTES,
  SIGNUP_MAX_ATTEMPTS,
  SIGNUP_MAX_SENDS,
  signupVerificationState,
  type SignupStarted,
  type SignupStatus,
} from '@erp/contracts';
import { withPlatformAdminTx } from '@erp/database';

import { RateLimiterService } from '../src/modules/platform/index.js';

import { api } from './http.js';
import { createActor, createTenantFixture, type Actor } from './fixtures.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * P-M4 — «الاشتراك والتفعيل» (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * مسارٌ عامٌّ من زائرٍ إلى منشأة تعمل: الباقة ← المنشأة ← المدير ← تحقّق بالبريد ← لوحة
 * ترحيب. وكل اختبار هنا يقيس حدًّا لا ميزة:
 *
 * 1. **الرخصة لا تُمنح ذاتياً**: التسجيل يُنشئ طلب تفعيلٍ `pending`، ولا يُنشئ اشتراكاً.
 * 2. **الرمز سرّ**: لا يُعاد في أي استجابة، ويُخزَّن مُجزَّأً (sha256) — والاختبار يقيس
 *    التجزئة بنفسه مقابل الرمز الذي وصل بالبريد فعلاً.
 * 3. **الرمز المميّز يحرس الحالة**: بلا `token` صحيح الجواب **404** — لا سردَ عناوين.
 * 4. **زمن التحقّق يُقاس**: انتهاء الصلاحية، والإغلاق بعد المحاولات، ومهلة إعادة الإرسال —
 *    كلها تُقاس بتعديل الطوابع في القاعدة لا بانتظار دقيقةٍ حقيقية.
 * 5. **المنشأة تعمل فعلاً**: الفرع ودليل الحسابات يُجهَّزان عند التسجيل، والمدير يدخل
 *    فوراً بلا انتظار موافقة — ومنشأته معزولة (RLS) عن كل منشأةٍ أخرى.
 *
 * **وكيف يُقرأ الرمز؟** من `email_messages.body` بمعاملة مشغّل المنصة: الرمز لا يُخزَّن خاماً
 * ولا يُطبع في السجلّ، والاختبار هو الطرف الوحيد الذي يجوز أن يرى ما وصل بالبريد ليقارن.
 */
describe('signup flow (P-M4)', () => {
  let ctx: TestApp;
  let operator: Actor;

  const SIGNUP = '/api/v1/signup';
  const PLANS = '/api/v1/signup/plans';
  const PASSWORD = 'Strong-Pass-2026!';

  const post = (path: string, body: Record<string, unknown>) => api(ctx.server, 'post', path, { body });
  const get = (path: string) => api(ctx.server, 'get', path);

  const unique = () => Math.random().toString(36).slice(2, 8);

  const signupBody = (overrides: Record<string, unknown> = {}) => ({
    companyName: `منشأة ${unique()}`,
    ownerFullName: 'مدير التجربة',
    ownerEmail: `owner.${unique()}@signup.test`,
    ownerPassword: PASSWORD,
    countryCode: 'SA',
    baseCurrency: 'SAR',
    locale: 'ar',
    ...overrides,
  });

  const start = async (overrides: Record<string, unknown> = {}): Promise<SignupStarted> => {
    const response = await post(SIGNUP, signupBody(overrides));
    expect(response.status).toBe(201);
    return (response.body as { data: SignupStarted }).data;
  };

  /** الرمز كما وصل بالبريد — من سجلّ الرسائل لا من استجابة. */
  const mailedCode = async (email: string): Promise<string> => {
    const result = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`
        SELECT body FROM email_messages
         WHERE event = 'signup.verify' AND lower(to_email) = ${email.toLowerCase()}
         ORDER BY created_at DESC LIMIT 1
      `),
    );
    const body = String((result.rows[0] as { body?: string } | undefined)?.body ?? '');
    const match = body.match(/\b(\d{6})\b/);
    expect(match, `لا رمز في نصّ الرسالة: ${body.slice(0, 120)}`).not.toBeNull();
    return String(match?.[1]);
  };

  const verificationRow = async (email: string): Promise<Record<string, unknown> | null> => {
    const result = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`
        SELECT * FROM signup_verifications WHERE lower(email) = ${email.toLowerCase()} LIMIT 1
      `),
    );
    return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
  };

  /** يُحرّك الزمن في القاعدة: نافذة الصلاحية، أو مهلة إعادة الإرسال. */
  const advance = async (email: string, statement: 'expired' | 'cooldown') => {
    await withPlatformAdminTx(ctx.handle.db, (tx) =>
      statement === 'expired'
        ? tx.execute(sql`
            UPDATE signup_verifications SET expires_at = now() - interval '1 minute'
             WHERE lower(email) = ${email.toLowerCase()} AND verified_at IS NULL
          `)
        : tx.execute(sql`
            UPDATE signup_verifications SET last_sent_at = now() - interval '5 minutes'
             WHERE lower(email) = ${email.toLowerCase()} AND verified_at IS NULL
          `),
    );
  };

  const ticket = (started: SignupStarted) => ({ email: started.ownerEmail, token: started.token });

  const problemDetail = (body: Record<string, unknown>) => ({
    code: body.code as string | undefined,
    detail: body.detail as string | undefined,
    errors: (body.errors ?? []) as Array<Record<string, unknown>>,
  });

  beforeAll(async () => {
    ctx = await createTestApp('signup');

    // منشأة المشغّلين أولاً: الباقات تسكنها، والبريد المنصّي (بلا مستأجر) يُسجَّل باسمها —
    // وبلا وجودها يفشل إرسال رمز التحقّق صامتاً (`sendCode` لا يُسقط التسجيل).
    await createTenantFixture(ctx.db.ownerUrl, {
      code: process.env.PLATFORM_TENANT_CODE ?? 'platform',
      name: 'منشأة المشغّلين',
      status: 'active',
    });

    operator = await createActor(ctx, {
      tenantCode: 'm4-ops',
      tenantName: 'مشغّلو M4',
      email: 'owner@m4-ops.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_owner'],
    });

    for (const plan of [
      { code: 'm4-monthly', name: 'باقة شهرية', interval: 'month', amount: '199.00' },
      { code: 'm4-yearly', name: 'باقة سنوية', interval: 'year', amount: '1990.00' },
    ]) {
      const created = await api(ctx.server, 'post', '/api/v1/platform/plans', {
        token: operator.token,
        body: plan,
      });
      expect(created.status, `خطة ${plan.code}`).toBe(201);
    }
  });

  /**
   * دلو `signup` على العنوان نفسه (١٠/دقيقة في الاختبار) — وهذا مقصود في الإنتاج وضارٌّ
   * هنا: كل اختبارٍ في هذا الملف يبدأ تسجيلاً. فيُصفَّر الدلو بين الاختبارات، ويبقى اختبارٌ
   * واحد يستعمل الحدّ فعلاً («إعادة الإرسال قبل انقضاء المهلة»).
   */
  beforeEach(() => {
    ctx.app.get(RateLimiterService).reset();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('الباقات المعروضة تُقرأ من نفس مصدر صفحة الأسعار (/public/plans)', async () => {
    const signupPlans = await get(PLANS);
    const publicPlans = await get('/api/v1/public/plans');
    expect(signupPlans.status).toBe(200);
    expect(publicPlans.status).toBe(200);

    const fromSignup = (signupPlans.body as { data: unknown[] }).data;
    const fromPublic = (publicPlans.body as { data: unknown[] }).data;
    expect(fromSignup.length).toBeGreaterThan(0);
    expect(fromSignup).toEqual(fromPublic);
    expect((signupPlans.body as { meta: { count: number } }).meta.count).toBe(fromSignup.length);
  });

  it('التسجيل يُنشئ المنشأة وطلب تفعيلٍ معلَّقاً ولا يمنح رخصة', async () => {
    const started = await start();
    expect(started.tenantCode).toMatch(/^[a-z0-9][a-z0-9-]{1,62}$/);
    expect(started.subscriptionStatus).toBe('pending');
    expect(started.activationRequestId).toBeTruthy();
    expect(started.trialDays).toBeGreaterThan(0);

    const row = await verificationRow(started.ownerEmail);
    const tenantId = String(row?.tenant_id);
    const counts = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`
        SELECT
          (SELECT count(*) FROM tenant_subscriptions
            WHERE tenant_id = ${tenantId} AND status IN ('active', 'trialing'))::int AS live,
          (SELECT count(*) FROM activation_requests
            WHERE tenant_id = ${tenantId} AND status = 'pending')::int AS pending,
          (SELECT count(*) FROM memberships WHERE tenant_id = ${tenantId} AND status = 'active')::int AS members
      `),
    );
    const first = counts.rows[0] as { live: number; pending: number; members: number };
    expect(first.live).toBe(0);
    expect(first.pending).toBe(1);
    expect(first.members).toBe(1);
  });

  it('مهامّ الإعداد تُقاس من القاعدة: الفرع والدليل جاهزان، وأول فاتورة لا', async () => {
    const started = await start();
    const verified = await post(`${SIGNUP}/verify`, {
      ...ticket(started),
      code: await mailedCode(started.ownerEmail),
    });
    expect(verified.status).toBe(200);
    const data = (verified.body as { data: SignupStatus }).data;

    const byKey = new Map(data.setup.map((task) => [task.key, task]));
    expect([...byKey.keys()]).toEqual(['company', 'branch', 'chart', 'invoice']);
    expect(byKey.get('company')?.done).toBe(true);
    expect(byKey.get('branch')?.done).toBe(true);
    expect(byKey.get('branch')?.count).toBeGreaterThan(0);
    expect(byKey.get('chart')?.done).toBe(true);
    expect(byKey.get('chart')?.count).toBeGreaterThan(0);
    // «أول فاتورة» مهمّةٌ لم تُنجَز بعد — واللوحة تقول ذلك بدل أن تدّعي اكتمالاً.
    expect(byKey.get('invoice')?.done).toBe(false);
    expect(byKey.get('invoice')?.href).toBe('/sales/invoices/new');
    expect(data.progress.total).toBe(4);
    expect(data.progress.done).toBe(3);
    expect(data.verification.state).toBe('verified');
  });

  it('الرمز لا يُعاد في أي استجابة، ويُخزَّن مُجزَّأً (لا خاماً)', async () => {
    const started = await start();
    const code = await mailedCode(started.ownerEmail);
    const row = await verificationRow(started.ownerEmail);

    expect(row).toBeTruthy();
    expect(JSON.stringify(started)).not.toContain(code);
    expect(String(row?.code_hash)).not.toBe(code);
    expect(String(row?.code_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(row?.token_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(row?.token_hash)).not.toBe(started.token);
    // والحالة لا تُسرّب الرمز أيضاً — تُخفي البريد وتُخبر بالعدّاد.
    expect(started.verification.emailMasked).toContain('…');
    expect(started.verification.emailMasked).not.toBe(started.ownerEmail);
    expect(started.verification.attemptsRemaining).toBe(SIGNUP_MAX_ATTEMPTS);
    expect(started.verification.sendsRemaining).toBe(SIGNUP_MAX_SENDS - 1);
  });

  it('رمزٌ خاطئ يُرفض 422 ويُنقص المحاولات', async () => {
    const started = await start();
    const before = await verificationRow(started.ownerEmail);
    const response = await post(`${SIGNUP}/verify`, { ...ticket(started), code: '000000' });
    expect(response.status).toBe(422);

    const problem = problemDetail(response.body);
    expect(problem.code).toBe('SIGNUP_CODE_INVALID');
    expect(problem.detail).toContain(String(SIGNUP_MAX_ATTEMPTS - 1));

    const after = await verificationRow(started.ownerEmail);
    expect(Number(after?.attempts)).toBe(1);
    expect(after?.verified_at).toBeNull();
    expect(String(after?.code_hash)).toBe(String(before?.code_hash));
  });

  it('بعد استهلاك المحاولات يُغلق الطلب، وإعادة الإرسال تفتحه برمزٍ جديد', async () => {
    const started = await start();
    for (let attempt = 0; attempt < SIGNUP_MAX_ATTEMPTS; attempt += 1) {
      const response = await post(`${SIGNUP}/verify`, { ...ticket(started), code: '111111' });
      expect(response.status).toBe(422);
    }
    const locked = await verificationRow(started.ownerEmail);
    expect(
      signupVerificationState({
        verifiedAt: null,
        expiresAt: locked?.expires_at as Date,
        attempts: Number(locked?.attempts),
      }),
    ).toBe('locked');

    // والطلب المغلق يرفض الرمز الصحيح نفسه — القفل على الطلب لا على الرمز.
    const stillClosed = await post(`${SIGNUP}/verify`, {
      ...ticket(started),
      code: await mailedCode(started.ownerEmail),
    });
    expect(stillClosed.status).toBe(422);
    expect(problemDetail(stillClosed.body).detail).toContain(String(SIGNUP_MAX_ATTEMPTS));

    // إعادة الإرسال مسموحة، وتُصفّر المحاولات وتُبدّل الرمز.
    await advance(started.ownerEmail, 'cooldown');
    const resent = await post(`${SIGNUP}/resend`, ticket(started));
    expect(resent.status).toBe(200);
    const afterResend = await verificationRow(started.ownerEmail);
    expect(Number(afterResend?.attempts)).toBe(0);
    expect(String(afterResend?.code_hash)).not.toBe(String(locked?.code_hash));

    const fresh = await mailedCode(started.ownerEmail);
    const verified = await post(`${SIGNUP}/verify`, { ...ticket(started), code: fresh });
    expect(verified.status).toBe(200);
    expect((verified.body as { data: SignupStatus }).data.verification.state).toBe('verified');
  });

  it('رمزٌ منتهٍ يُرفض، والرسالة تذكر مدّة الصلاحية', async () => {
    const started = await start();
    const code = await mailedCode(started.ownerEmail);
    await advance(started.ownerEmail, 'expired');

    const response = await post(`${SIGNUP}/verify`, { ...ticket(started), code });
    expect(response.status).toBe(422);
    const problem = problemDetail(response.body);
    expect(problem.code).toBe('SIGNUP_CODE_INVALID');
    expect(problem.detail).toContain(String(SIGNUP_CODE_TTL_MINUTES));
    // والرمز المنتهي لا يُخصم من محاولاته: العطل في الزمن لا في القارئ.
    const row = await verificationRow(started.ownerEmail);
    expect(Number(row?.attempts)).toBe(0);
  });

  it('إعادة الإرسال قبل انقضاء المهلة تُرفض 429 مع المدّة المتبقية', async () => {
    const started = await start();
    const response = await post(`${SIGNUP}/resend`, ticket(started));
    expect(response.status).toBe(429);
    const problem = problemDetail(response.body);
    expect(problem.code).toBe('RATE_LIMITED');
    expect(Number(problem.errors[0]?.retryAfterSeconds ?? 0)).toBeGreaterThan(0);
    expect(Number(problem.errors[0]?.retryAfterSeconds ?? 0)).toBeLessThanOrEqual(60);
  });

  it('سقف الإرسالات يُحترم (خمس رسائل ثم توقّف)', async () => {
    const started = await start();
    for (let send = 1; send < SIGNUP_MAX_SENDS; send += 1) {
      await advance(started.ownerEmail, 'cooldown');
      const ok = await post(`${SIGNUP}/resend`, ticket(started));
      expect(ok.status).toBe(200);
      expect((ok.body as { data: { sendsRemaining: number } }).data.sendsRemaining).toBe(
        SIGNUP_MAX_SENDS - send - 1,
      );
    }
    const row = await verificationRow(started.ownerEmail);
    expect(Number(row?.sends)).toBe(SIGNUP_MAX_SENDS);

    await advance(started.ownerEmail, 'cooldown');
    const blocked = await post(`${SIGNUP}/resend`, ticket(started));
    expect(blocked.status).toBe(429);
    expect(problemDetail(blocked.body).code).toBe('RATE_LIMITED');
  });

  it('الحالة بلا رمزٍ صحيح تُرجع 404 — فلا سردَ للعناوين', async () => {
    const started = await start();
    const missing = await get(`${SIGNUP}/status/${encodeURIComponent(started.ownerEmail)}`);
    const unknown = await get(`${SIGNUP}/status/nobody-${unique()}%40signup.test?token=${started.token}`);
    const wrongToken = await get(
      `${SIGNUP}/status/${encodeURIComponent(started.ownerEmail)}?token=${'0'.repeat(48)}`,
    );
    for (const response of [missing, unknown, wrongToken]) {
      expect(response.status).toBe(404);
      expect(problemDetail(response.body).code).toBe('SIGNUP_TOKEN_INVALID');
      // والنصّ واحد في الحالات الثلاث — وإلّا صار الفرق نفسه إخباراً.
      expect(problemDetail(response.body).detail).toBe('لا يوجد تسجيلٌ بهذا البريد والرمز.');
    }

    // والتحقّق كذلك: رمزٌ مميّز خاطئ ← 404 لا 422، فلا يعرف المُخمِّن أن العنوان مسجَّل.
    const verifyWrongToken = await post(`${SIGNUP}/verify`, {
      email: started.ownerEmail,
      token: '0'.repeat(48),
      code: '123456',
    });
    expect(verifyWrongToken.status).toBe(404);
    expect(problemDetail(verifyWrongToken.body).detail).toBe('لا يوجد تسجيلٌ بهذا البريد والرمز.');

    const ok = await get(`${SIGNUP}/status/${encodeURIComponent(started.ownerEmail)}?token=${started.token}`);
    expect(ok.status).toBe(200);
    const data = (ok.body as { data: SignupStatus }).data;
    expect(data.tenantCode).toBe(started.tenantCode);
    expect(data.ownerEmail).toBe(started.ownerEmail);
    expect(data.verification.state).toBe('pending');
  });

  it('التحقّق يعمل مرّتين: إعادة الرمز الصحيح تُعيد الحالة نفسها بلا فشل', async () => {
    const started = await start();
    const code = await mailedCode(started.ownerEmail);
    const first = await post(`${SIGNUP}/verify`, { ...ticket(started), code });
    const second = await post(`${SIGNUP}/verify`, { ...ticket(started), code });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((second.body as { data: SignupStatus }).data.verification.state).toBe('verified');
    // وإعادة الإرسال بعد التحقّق لا تُرسل رسالةً ثانية.
    const resent = await post(`${SIGNUP}/resend`, ticket(started));
    expect(resent.status).toBe(200);
    expect((resent.body as { data: { state: string } }).data.state).toBe('verified');
  });

  it('بريدٌ يملك منشأةً بالفعل يُرفض 409 بنصٍّ صريح', async () => {
    const started = await start();
    const again = await post(SIGNUP, signupBody({ ownerEmail: started.ownerEmail }));
    expect(again.status).toBe(409);
    const problem = problemDetail(again.body);
    expect(problem.code).toBe('SIGNUP_EMAIL_TAKEN');
    expect(problem.detail).toContain('سجّل الدخول');

    // ولا يُنشأ صفُّ تحقّقٍ ثانٍ للعنوان نفسه (القيد الفريد الجزئي يحرس ذلك أيضاً).
    const rows = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`
        SELECT count(*)::int AS n FROM signup_verifications
         WHERE lower(email) = ${started.ownerEmail} AND verified_at IS NULL
      `),
    );
    expect(Number((rows.rows[0] as { n: number }).n)).toBe(1);
  });

  it('بياناتٌ ضعيفة أو باقةٌ غير معروضة تُرفض ولا تترك أثراً', async () => {
    const footprint = async () => {
      const result = await withPlatformAdminTx(ctx.handle.db, (tx) =>
        tx.execute(sql`
          SELECT (SELECT count(*) FROM tenants)::int AS tenants,
                 (SELECT count(*) FROM activation_requests)::int AS requests,
                 (SELECT count(*) FROM signup_verifications)::int AS verifications
        `),
      );
      return result.rows[0] as { tenants: number; requests: number; verifications: number };
    };
    const before = await footprint();

    const shortPassword = await post(SIGNUP, signupBody({ ownerPassword: 'short' }));
    expect(shortPassword.status).toBe(400);

    const shortName = await post(SIGNUP, signupBody({ companyName: 'أ' }));
    expect(shortName.status).toBe(400);

    const badEmail = await post(SIGNUP, signupBody({ ownerEmail: 'not-an-email' }));
    expect(badEmail.status).toBe(400);

    // باقةٌ غير معروضة: 422 **قبل** إنشاء أي صفّ — وإلّا بقي ملفٌّ يتيمٌ وطلبُ تفعيلٍ معلَّق
    // من مجرّد معرّفٍ أُرسل خطأً.
    const unknownPlan = await post(SIGNUP, signupBody({ planId: '00000000-0000-4000-8000-000000000000' }));
    expect(unknownPlan.status).toBe(422);
    expect(problemDetail(unknownPlan.body).code).toBe('VALIDATION_FAILED');

    expect(await footprint()).toEqual(before);
  });

  it('رمزٌ خاطئ ثم صحيح: الخطأ لا يُفسد الرمز السليم', async () => {
    const started = await start();
    const code = await mailedCode(started.ownerEmail);
    const wrongCode = code === '123456' ? '654321' : '123456';
    const failed = await post(`${SIGNUP}/verify`, { ...ticket(started), code: wrongCode });
    expect(failed.status).toBe(422);
    const ok = await post(`${SIGNUP}/verify`, { ...ticket(started), code });
    expect(ok.status).toBe(200);
    expect((ok.body as { data: SignupStatus }).data.verification.state).toBe('verified');
  });

  it('الباقة المختارة تعود بالتفصيل، وتُدوَّن في طلب التفعيل مع مدّة التجربة', async () => {
    const choices = (await get(PLANS)).body as { data: Array<{ id: string; amount: string }> };
    const chosen = choices.data[0];
    const started = await start({ planId: chosen?.id });
    expect(started.plan?.id).toBe(chosen?.id);
    expect(started.plan?.amount).toBe(chosen?.amount);
    expect(started.plan?.interval).toMatch(/^(month|year)$/);

    const row = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`
        SELECT notes FROM activation_requests WHERE id = ${started.activationRequestId} LIMIT 1
      `),
    );
    const notes = String((row.rows[0] as { notes?: string } | undefined)?.notes ?? '');
    expect(notes).toContain(started.ownerEmail);
    expect(notes).toContain(`${started.trialDays}d`);
  });

  it('مدير المنشأة الجديدة يدخل فوراً، ودليلُه معزولٌ عن منشأةٍ أخرى (RLS)', async () => {
    const first = await start();
    const second = await start();

    const login = await post('/api/v1/auth/login', {
      email: first.ownerEmail,
      password: PASSWORD,
      tenantCode: first.tenantCode,
    });
    expect(login.status).toBe(200);
    const token = (login.body as { data?: { accessToken?: string } }).data?.accessToken;
    expect(token).toBeTruthy();

    // دليل الحسابات الذي جهّزه التسجيل يظهر لصاحبه.
    const accounts = await api(ctx.server, 'get', '/api/v1/accounts', { token });
    expect(accounts.status).toBe(200);
    const visible = (accounts.body as { data: Array<{ id: string }> }).data;
    expect(visible.length).toBeGreaterThan(0);

    // والعدد الحقيقي يُقرأ بصلاحية المالك (فوق RLS) لا بصلاحية المنصة: جدول `accounts`
    // محروسٌ بسياسة المستأجر وحده، فقراءةُ مشغّل المنصة له تُعيد صفراً — وهذا نفسه درسٌ
    // يُثبته هذا الاختبار: ما لا تُظهره RLS لمشغّل المنصة لا يصل إلى أي مستأجر.
    const ids = new Map<string, string>();
    for (const [label, started] of [
      ['first', first],
      ['second', second],
    ] as const) {
      const row = await verificationRow(started.ownerEmail);
      ids.set(label, String(row?.tenant_id));
    }
    const client = new Client({ connectionString: ctx.db.ownerUrl });
    await client.connect();
    let mine = 0;
    let other = 0;
    try {
      mine = Number(
        (await client.query<{ n: number }>('SELECT count(*)::int AS n FROM accounts WHERE tenant_id = $1', [
          ids.get('first'),
        ])).rows[0]?.n ?? 0,
      );
      other = Number(
        (await client.query<{ n: number }>('SELECT count(*)::int AS n FROM accounts WHERE tenant_id = $1', [
          ids.get('second'),
        ])).rows[0]?.n ?? 0,
      );
    } finally {
      await client.end();
    }

    expect(mine).toBeGreaterThan(0);
    expect(other).toBeGreaterThan(0);

    // وهذا هو معنى «محروسٌ بسياسة المستأجر وحده»: قراءةٌ بصلاحية المنصة تُعيد صفراً —
    // فلو أنّ شاشةً ما قرأت الحسابات بصلاحية المنصة لعرضت جدولاً فارغاً بلا خطأ.
    const asPlatform = await withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM accounts`),
    );
    expect(Number((asPlatform.rows[0] as { n: number }).n)).toBe(0);
    // المدير يرى دليل منشأته بالضبط: لا سطرٌ ناقص ولا سطرٌ من جاره.
    expect(visible.length).toBe(mine);
  });
});
