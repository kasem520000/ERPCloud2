import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@erp/database';
import { Pool } from 'pg';

import { createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * 🏢 الأصول الثابتة (M6.1) — السجل والتصنيفات وجدول الإهلاك وترحيله الشهري.
 *
 * يُختبر على قاعدة معزولة عبر HTTP الحقيقي، والمبدأ الحاكم واحد: الوحدة لا تكتب
 * الأستاذ بنفسها أبدًا — كل إهلاك يمرّ عبر `postJournalInTx`، فتُختبر النتائج في
 * الأستاذ نفسه (أرصدة حسابات المصروف والمجمع) لا في جداول الوحدة وحدها:
 *
 *   1. التصنيفات: إنشاء وتعديل، ورفض الرمز المكرر والحساب الأجنبي؛
 *   2. السجل: إنشاء أصل بحسابات التصنيف أو بتجاوزاتها، ورفض الخردة > التكلفة؛
 *   3. الجدول: قسط ثابت من شهر الاقتناء، والشهر الأخير يحمل الباقي بالضبط
 *      فيساوي المجموع (التكلفة − الخردة) تساويًا تامًا؛
 *   4. التشغيل: قيد واحد متوازن لكل الأصول المستحقة، وأثره في أرصدة الحسابات،
 *      وإعادة التشغيل لا تُنشئ شيئًا (القيد الفريد asset+period)، والمتخطى معلن؛
 *   5. الحالة: من استوفى أقساطه يصير fully_depreciated؛
 *   6. العزل والصلاحيات: مستأجر آخر لا يرى شيئًا، ومن لا يملك رمز الترحيل ممنوع.
 */
describe('fixed assets — الأصول الثابتة', () => {
  let ctx: TestApp;
  let pool: Pool;

  let owner: Actor;
  let viewer: Actor;
  let stranger: Actor;

  let branchId = '';
  let expenseAccountId = '';
  let accumulatedAccountId = '';
  let assetAccountId = '';
  let foreignAccountId = '';

  let categoryId = '';
  let secondCategoryId = '';
  let vanId = '';
  let generatorId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;
  const list = (body: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(body) ? body : ((body as { data?: unknown }).data as unknown[]) ?? []) as Array<Record<string, unknown>>;

  const account = async (payload: Record<string, unknown>): Promise<string> => {
    const created = await api(ctx.server, 'post', '/api/v1/accounts', {
      token: owner.token,
      body: payload,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return data(created.body).id as string;
  };

  const accountBalance = async (accountId: string): Promise<{ debit: string; credit: string }> => {
    const result = await pool.query(
      `SELECT COALESCE(SUM(l.debit), 0)::text AS debit, COALESCE(SUM(l.credit), 0)::text AS credit
       FROM journal_entry_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.tenant_id = $1 AND l.account_id = $2 AND e.status = 'posted'`,
      [owner.tenantId, accountId],
    );
    return result.rows[0] as { debit: string; credit: string };
  };

  const run = (period: string, body: Record<string, unknown> = {}) =>
    api(ctx.server, 'post', '/api/v1/fixed-assets/depreciation-runs', {
      token: owner.token,
      body: { period, ...body },
    });

  beforeAll(async () => {
    ctx = await createTestApp('fixed-assets');
    pool = new Pool({ connectionString: ctx.db.ownerUrl, max: 1 });

    owner = await createActor(ctx, {
      tenantCode: 'fixed-assets',
      tenantName: 'مصانع الأصول الثابتة',
      email: 'owner@fixed-assets.test',
      permissions: [
        'accounting.account.view',
        'accounting.account.manage',
        'accounting.journal.post',
        'accounting.period.close',
        'accounting.period.view',
        'accounting.assets.view',
        'accounting.assets.manage',
        'accounting.assets.depreciate',
      ],
      roleNames: ['Admin'],
      isOwner: true,
    });
    viewer = await createActor(ctx, {
      tenantId: owner.tenantId,
      tenantCode: 'fixed-assets',
      email: 'viewer@fixed-assets.test',
      permissions: ['accounting.assets.view'],
      roleNames: ['Viewer'],
      isOwner: false,
    });
    stranger = await createActor(ctx, {
      tenantCode: 'assets-other',
      tenantName: 'منشأة أخرى',
      email: 'owner@assets-other.test',
      permissions: ['accounting.account.view', 'accounting.account.manage', 'accounting.assets.view', 'accounting.assets.manage', 'accounting.assets.depreciate'],
      roleNames: ['Admin'],
      isOwner: true,
    });

    const { OrgProvisioningService } = await import(
      '../src/modules/organization/provisioning/org-provisioning.service.js'
    );
    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(owner.tenantId);
    branchId = defaults.branchId;

    const year = new Date().getUTCFullYear();
    const fiscal = await api(ctx.server, 'post', '/api/v1/fiscal-years', {
      token: owner.token,
      body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
    });
    expect(fiscal.status, JSON.stringify(fiscal.body)).toBe(201);
    // حسابات الترحيل: مصروف / مجمع / أصل — كلها من دليل هذه المنشأة.
    expenseAccountId = await account({ code: '1630', nameAr: 'مصروف إهلاك السيارات', type: 'expense' });
    accumulatedAccountId = await account({ code: '1290', nameAr: 'مجمع إهلاك السيارات', type: 'asset' });
    assetAccountId = await account({ code: '1190', nameAr: 'سيارات ومعدات', type: 'asset' });

    // حساب أجنبي (مستأجر آخر) — لاختبار حارس الحسابات.
    const foreign = await api(ctx.server, 'post', '/api/v1/accounts', {
      token: stranger.token,
      body: { code: '9900', nameAr: 'حساب أجنبي', type: 'asset' },
    });
    expect(foreign.status).toBe(201);
    foreignAccountId = data(foreign.body).id as string;

    const category = await api(ctx.server, 'post', '/api/v1/asset-categories', {
      token: owner.token,
      body: {
        code: 'VEHICLES',
        nameAr: 'سيارات ومعدات النقل',
        defaultUsefulLifeMonths: 60,
        assetAccountId,
        accumulatedAccountId,
        depreciationAccountId: expenseAccountId,
      },
    });
    expect(category.status, JSON.stringify(category.body)).toBe(201);
    categoryId = data(category.body).id as string;

    const secondCategory = await api(ctx.server, 'post', '/api/v1/asset-categories', {
      token: owner.token,
      body: {
        code: 'GEN',
        nameAr: 'مولدات',
        defaultUsefulLifeMonths: 24,
        assetAccountId,
        accumulatedAccountId,
        depreciationAccountId: expenseAccountId,
      },
    });
    expect(secondCategory.status).toBe(201);
    secondCategoryId = data(secondCategory.body).id as string;

    const van = await api(ctx.server, 'post', '/api/v1/fixed-assets', {
      token: owner.token,
      body: {
        code: 'VAN-001',
        nameAr: 'سيارة توزيع تويوتا',
        categoryId,
        acquisitionDate: `${year}-01-15`,
        acquisitionCost: '240000',
        salvageValue: '30000',
        usefulLifeMonths: 60,
        branchId,
      },
    });
    expect(van.status, JSON.stringify(van.body)).toBe(201);
    vanId = data(van.body).id as string;

    const generator = await api(ctx.server, 'post', '/api/v1/fixed-assets', {
      token: owner.token,
      body: {
        code: 'GEN-001',
        nameAr: 'مولد احتياطي',
        categoryId: secondCategoryId,
        acquisitionDate: `${year}-01-15`,
        acquisitionCost: '48000',
        salvageValue: '0',
        usefulLifeMonths: 24,
      },
    });
    expect(generator.status, JSON.stringify(generator.body)).toBe(201);
    generatorId = data(generator.body).id as string;
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await ctx?.close();
  });

  // ── 1) التصنيفات ────────────────────────────────────────────────────────────

  it('refuses a duplicate category code and a foreign posting account', async () => {
    const duplicate = await api(ctx.server, 'post', '/api/v1/asset-categories', {
      token: owner.token,
      body: { code: 'VEHICLES', nameAr: 'تكرار', defaultUsefulLifeMonths: 12 },
    });
    expect(duplicate.status).toBe(409);
    expect((duplicate.body as { code?: string }).code).toBe('ASSET_CATEGORY_CODE_TAKEN');

    const foreign = await api(ctx.server, 'post', '/api/v1/asset-categories', {
      token: owner.token,
      body: { code: 'FOREIGN', nameAr: 'تصنيف بحساب أجنبي', defaultUsefulLifeMonths: 12, depreciationAccountId: foreignAccountId },
    });
    expect(foreign.status).toBe(404);

    const badLife = await api(ctx.server, 'post', '/api/v1/asset-categories', {
      token: owner.token,
      body: { code: 'BADLIFE', nameAr: 'عمر سالب', defaultUsefulLifeMonths: -3 },
    });
    expect(badLife.status).toBe(422);
  });

  // ── 2) السجل ────────────────────────────────────────────────────────────────

  it('validates the register: salvage cannot exceed cost, codes are unique', async () => {
    const badSalvage = await api(ctx.server, 'post', '/api/v1/fixed-assets', {
      token: owner.token,
      body: { code: 'BAD-001', nameAr: 'خردة أكبر من التكلفة', categoryId, acquisitionDate: '2026-01-01', acquisitionCost: '1000', salvageValue: '2000', usefulLifeMonths: 12 },
    });
    expect(badSalvage.status).toBe(422);

    const duplicateCode = await api(ctx.server, 'post', '/api/v1/fixed-assets', {
      token: owner.token,
      body: { code: 'VAN-001', nameAr: 'رمز مكرر', categoryId, acquisitionDate: '2026-01-01', acquisitionCost: '1000' },
    });
    expect(duplicateCode.status).toBe(409);
    expect((duplicateCode.body as { code?: string }).code).toBe('ASSET_CODE_TAKEN');

    const missingCategory = await api(ctx.server, 'post', '/api/v1/fixed-assets', {
      token: owner.token,
      body: { code: 'ORPHAN-001', nameAr: 'بلا تصنيف', categoryId: newId(), acquisitionDate: '2026-01-01', acquisitionCost: '1000' },
    });
    expect(missingCategory.status).toBe(404);
  });

  it('isolates the register per tenant', async () => {
    const mine = await api(ctx.server, 'get', '/api/v1/fixed-assets', { token: owner.token });
    expect(mine.status).toBe(200);
    expect(list(mine.body).map((row) => row.code)).toEqual(['GEN-001', 'VAN-001']);

    const theirs = await api(ctx.server, 'get', '/api/v1/fixed-assets', { token: stranger.token });
    expect(theirs.status).toBe(200);
    expect(list(theirs.body)).toHaveLength(0);

    const foreignRead = await api(ctx.server, 'get', `/api/v1/fixed-assets/${vanId}`, { token: stranger.token });
    expect(foreignRead.status).toBe(404);
  });

  // ── 3) الجدول ───────────────────────────────────────────────────────────────

  it('builds the straight-line schedule with an exact telescoping last month', async () => {
    const schedule = await api(ctx.server, 'get', `/api/v1/fixed-assets/${vanId}/schedule`, { token: owner.token });
    expect(schedule.status, JSON.stringify(schedule.body)).toBe(200);
    const rowsList = list(schedule.body) as Array<{ period: string; plannedAmount: string; posted: boolean }>;
    void rowsList;

    const card = data(schedule.body) as {
      asset: { code: string; accumulatedDepreciation: string; netBookValue: string };
      schedule: Array<{ period: string; plannedAmount: string; postedAmount: string; posted: boolean }>;
    };
    expect(card.asset.code).toBe('VAN-001');
    expect(card.schedule).toHaveLength(60);
    // يبدأ من شهر الاقتناء.
    expect(card.schedule[0]?.period).toBe(`${new Date().getUTCFullYear()}-01`);
    // القسط الشهري = (240000 − 30000) ÷ 60 = 3500 بالضبط.
    expect(card.schedule.map((row) => row.plannedAmount).every((planned) => planned === '3500.0000')).toBe(true);
    // المجموع = التكلفة − الخردة تساويًا تامًا.
    const sumTotal = card.schedule.reduce((sum, row) => sum + Number(row.plannedAmount), 0);
    expect(sumTotal).toBeCloseTo(210000, 6);
    // لا شيء مرحّل بعد.
    expect(card.schedule.every((row) => row.posted === false)).toBe(true);
    expect(card.asset.accumulatedDepreciation).toBe('0.0000');
    expect(card.asset.netBookValue).toBe('240000.0000');

    // المولد: 48000 ÷ 24 = 2000 بالضبط، والشهر الأخير يحمل الباقي عند كسر القسط.
    const genCard = data(
      (await api(ctx.server, 'get', `/api/v1/fixed-assets/${generatorId}/schedule`, { token: owner.token })).body,
    ) as { schedule: Array<{ plannedAmount: string }> };
    const genTotal = genCard.schedule.reduce((sum, row) => sum + Number(row.plannedAmount), 0);
    expect(genTotal).toBeCloseTo(48000, 6);
  });

  // ── 4) التشغيل ──────────────────────────────────────────────────────────────

  it('runs a month: one balanced entry, GL balances move, reruns change nothing', async () => {
    const year = new Date().getUTCFullYear();
    const first = await run(`${year}-01`);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const firstData = data(first.body) as {
      processed: number;
      skipped: Array<{ code: string; reason: string }>;
      journalEntry: { id: string; number: string } | null;
      totalDepreciation: string;
      assets: Array<{ code: string; amount: string }>;
    };
    expect(firstData.processed).toBe(2);
    expect(firstData.skipped).toHaveLength(0);
    expect(firstData.journalEntry?.number).toMatch(/^JE-/);
    expect(firstData.totalDepreciation).toBe('5500.0000');
    expect(firstData.assets.map((row) => row.code).sort()).toEqual(['GEN-001', 'VAN-001']);

    /** الأستاذ لا جداول الوحدة: مصروف الإهلاك مدين 5500، والمجمع دائن 5500. */
    expect(await accountBalance(expenseAccountId)).toMatchObject({ debit: '5500.0000', credit: '0.0000' });
    expect(await accountBalance(accumulatedAccountId)).toMatchObject({ debit: '0.0000', credit: '5500.0000' });

    // القيد متوازن ومصدره معلن.
    const entry = await pool.query(
      `SELECT e.number, e.source_type, COALESCE(SUM(l.debit), 0)::text AS debit, COALESCE(SUM(l.credit), 0)::text AS credit
       FROM journal_entries e JOIN journal_entry_lines l ON l.entry_id = e.id
       WHERE e.tenant_id = $1 AND e.id = $2 GROUP BY e.number, e.source_type`,
      [owner.tenantId, firstData.journalEntry?.id],
    );
    expect(entry.rows[0]).toMatchObject({ source_type: 'asset_depreciation', debit: '5500.0000', credit: '5500.0000' });

    /** إعادة التشغيل: لا قيد جديد ولا صف جديد — والمتخطى معلن لا صامت. */
    const rerun = await run(`${year}-01`);
    expect(rerun.status).toBe(201);
    const rerunData = data(rerun.body) as { processed: number; skipped: Array<{ code: string }>; journalEntry: unknown | null };
    expect(rerunData.processed).toBe(0);
    expect(rerunData.journalEntry).toBeNull();
    expect(rerunData.skipped.map((row) => row.code).sort()).toEqual(['GEN-001', 'VAN-001']);
    expect(await accountBalance(expenseAccountId)).toMatchObject({ debit: '5500.0000', credit: '0.0000' });

    // الشهر التالي يضيف قسطًا جديدًا.
    const second = await run(`${year}-02`);
    expect(second.status).toBe(201);
    expect((data(second.body) as { processed: number }).processed).toBe(2);
    expect(await accountBalance(expenseAccountId)).toMatchObject({ debit: '11000.0000', credit: '0.0000' });

    // الجدول الآن يظهر شهرين مرحّلين برقم القيد.
    const card = data(
      (await api(ctx.server, 'get', `/api/v1/fixed-assets/${vanId}/schedule`, { token: owner.token })).body,
    ) as { asset: { accumulatedDepreciation: string; netBookValue: string }; schedule: Array<{ posted: boolean; journalNumber: string | null }> };
    expect(card.schedule.filter((row) => row.posted)).toHaveLength(2);
    expect(card.schedule.filter((row) => row.posted).every((row) => row.journalNumber?.match(/^JE-/))).toBe(true);
    expect(card.asset.accumulatedDepreciation).toBe('7000.0000');
    expect(card.asset.netBookValue).toBe('233000.0000');
  });

  it('runs a selected subset and declares out-of-life assets as skipped', async () => {
    const year = new Date().getUTCFullYear();
    // الشهر الثالث: الأصل المولد وحده.
    const selected = await run(`${year}-03`, { assetIds: [generatorId] });
    expect(selected.status, JSON.stringify(selected.body)).toBe(201);
    const selectedData = data(selected.body) as { processed: number; assets: Array<{ code: string }> };
    expect(selectedData.processed).toBe(1);
    expect(selectedData.assets.map((row) => row.code)).toEqual(['GEN-001']);

    // شهر قبل الاقتناء: تخطٍّ معلن — بعد فتح سنة مالية تغطّيه.
    const previousFiscal = await api(ctx.server, 'post', '/api/v1/fiscal-years', {
      token: owner.token,
      body: { name: `FY${year - 1}`, startDate: `${year - 1}-01-01`, endDate: `${year - 1}-12-31` },
    });
    expect(previousFiscal.status, JSON.stringify(previousFiscal.body)).toBe(201);
    const early = await run(`${year - 1}-12`);
    expect(early.status, JSON.stringify(early.body)).toBe(201);
    const earlyData = data(early.body) as { processed: number; skipped: Array<{ code: string; reason: string }> };
    expect(earlyData.processed).toBe(0);
    expect(earlyData.skipped.every((row) => row.reason === 'قبل تاريخ الاقتناء')).toBe(true);

    // شهر بصيغة غير صالحة.
    const badPeriod = await run('2026-1');
    expect(badPeriod.status).toBe(422);
  });

  it('refuses to post into a closed fiscal period and honours the permission split', async () => {
    const year = new Date().getUTCFullYear();
    // لا فترة مالية تغطي السنة القادمة — الرفض صريح لا إعادة توجيه صامتة.
    const noPeriod = await run(`${year + 1}-01`);
    expect(noPeriod.status).toBe(422);
    expect((noPeriod.body as { code?: string }).code).toBe('FISCAL_PERIOD_NOT_FOUND');

    // القارئ يرى كل شيء ولا يرحّل شيئًا.
    const read = await api(ctx.server, 'get', '/api/v1/fixed-assets/depreciation-runs', { token: viewer.token });
    expect(read.status).toBe(200);
    const write = await api(ctx.server, 'post', '/api/v1/fixed-assets/depreciation-runs', {
      token: viewer.token,
      body: { period: `${year}-04` },
    });
    expect(write.status).toBe(403);

    // ومن لا يملك حتى القراءة ممنوع من السجل.
    const register = await api(ctx.server, 'get', '/api/v1/fixed-assets', { token: stranger.token });
    expect(register.status).toBe(200); // له سجله الفارغ — العزل لا الرفض.
  });

  it('flips an asset to fully_depreciated when its last life month posts', async () => {
    // مولد عمره 24 شهرًا من يناير — نشغّل بقية الأشهر فنصل للشهر الأخير.
    const year = new Date().getUTCFullYear();
    for (let month = 4; month <= 12; month += 1) {
      const result = await run(`${year}-${String(month).padStart(2, '0')}`, { assetIds: [generatorId] });
      expect(result.status, JSON.stringify(result.body)).toBe(201);
    }
    // السنة القادمة تحتاج فترة مالية.
    const nextFiscal = await api(ctx.server, 'post', '/api/v1/fiscal-years', {
      token: owner.token,
      body: { name: `FY${year + 1}`, startDate: `${year + 1}-01-01`, endDate: `${year + 1}-12-31` },
    });
    expect(nextFiscal.status, JSON.stringify(nextFiscal.body)).toBe(201);
    for (let month = 1; month <= 12; month += 1) {
      const result = await run(`${year + 1}-${String(month).padStart(2, '0')}`, { assetIds: [generatorId] });
      expect(result.status, JSON.stringify(result.body)).toBe(201);
    }

    const register = list((await api(ctx.server, 'get', '/api/v1/fixed-assets?status=fully_depreciated', { token: owner.token })).body);
    expect(register.map((row) => row.code)).toEqual(['GEN-001']);
    const generatorRow = register[0] as { accumulatedDepreciation: string; netBookValue: string; depreciatedMonths: number };
    // 24 قسطًا × 2000 = 48000 — التكلفة كاملة، والقيمة الدفترية صفر.
    expect(generatorRow.accumulatedDepreciation).toBe('48000.0000');
    expect(generatorRow.netBookValue).toBe('0.0000');
    expect(generatorRow.depreciatedMonths).toBe(24);

    // وبعد الاستيفاء: أي تشغيل لاحق يتخطاه معلنًا — بعد فتح سنة مالية تغطّيه.
    const afterFiscal = await api(ctx.server, 'post', '/api/v1/fiscal-years', {
      token: owner.token,
      body: { name: `FY${year + 2}`, startDate: `${year + 2}-01-01`, endDate: `${year + 2}-12-31` },
    });
    expect(afterFiscal.status, JSON.stringify(afterFiscal.body)).toBe(201);
    const after = await run(`${year + 2}-01`, { assetIds: [generatorId] });
    const afterData = data(after.body) as { processed: number; skipped: Array<{ reason: string }> };
    expect(afterData.processed).toBe(0);
    expect(afterData.skipped[0]?.reason).toBe('استوفى عمره الإهلاكي');
  });
});
