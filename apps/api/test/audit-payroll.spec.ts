import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withOwnerClient } from '@erp/testing';

import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * AUD-10 — أثر الرواتب منفصل عن حالة المسيّر.
 *
 * قبل الإصلاح كان `postRun` يقرأ المسيّر، ثم يرحّل القيد بـ`accounting.postJournal`
 * (معاملة مستقلّة)، ثم يحدّث الحالة (معاملة ثالثة)؛ وكان `payRun` ينشئ سند الخزينة
 * ويرحّله ثم يحدّث الحالة في استدعاءاتٍ منفصلة. فانقطاعٌ بين المراحل يترك **قيداً بلا
 * مسيّر مرحّل** أو **سنداً مرحّلاً بلا «مدفوع»**، وإعادة المحاولة تنشئ أثراً ثانياً.
 *
 * يُثبت هذا الملف — بفشلٍ مُحقَن على القاعدة لا بمحاكاة:
 *
 *   • فشل تحديث المسيّر يُلغي القيد والسند معه (لا أثر يتيم)، والمسيّر يبقى على حالته؛
 *   • طلبان متزامنان للترحيل أو للصرف: واحدٌ ينجح والآخر 409، وأثرٌ مالي **واحد** فقط؛
 *   • إعادة المحاولة بعد فشلٍ تُنتج أثراً واحداً لا اثنين.
 */

describe('AUD-10 — ترحيل وصرف مسيّر الرواتب: معاملة واحدة وأثرٌ واحد', () => {
  let ctx: TestApp;
  let actor: Actor;

  let branchId = '';
  let cashLocationId = '';
  let employeeId = '';
  let payrollAccountId = '';
  let employeeAccountId = '';

  const data = (body: Record<string, unknown>) => (body.data ?? body) as Record<string, unknown>;
  const post = (path: string, body: Record<string, unknown> = {}) =>
    api(ctx.server, 'post', `/api/v1${path}`, { token: actor.token, body });
  const get = (path: string) => api(ctx.server, 'get', `/api/v1${path}`, { token: actor.token });

  /** كل مسيّرٍ في شهرٍ مختلف: الفهرس الفريد يمنع مسيّرين لنفس الشهر في نفس المنشأة. */
  let monthCursor = 0;
  const nextMonth = () => {
    monthCursor += 1;
    return `2026-${String(monthCursor).padStart(2, '0')}`;
  };

  const journalCount = (description: string) =>
    withOwnerClient(ctx.db.ownerUrl, async (client) => {
      const result = await client.query(
        `SELECT count(*)::int AS total FROM journal_entries WHERE tenant_id = $1 AND description = $2`,
        [actor.tenantId, description],
      );
      return (result.rows[0] as { total: number }).total;
    });

  const voucherCount = (idempotencyKey: string) =>
    withOwnerClient(ctx.db.ownerUrl, async (client) => {
      const result = await client.query(
        `SELECT count(*)::int AS total FROM vouchers WHERE tenant_id = $1 AND idempotency_key = $2`,
        [actor.tenantId, idempotencyKey],
      );
      return (result.rows[0] as { total: number }).total;
    });

  const voucherRow = (idempotencyKey: string) =>
    withOwnerClient(ctx.db.ownerUrl, async (client) => {
      const result = await client.query(
        `SELECT v.id, v.status, v.journal_entry_id, v.number FROM vouchers v WHERE v.tenant_id = $1 AND v.idempotency_key = $2`,
        [actor.tenantId, idempotencyKey],
      );
      return result.rows[0] as { id: string; status: string; journal_entry_id: string | null; number: string | null } | undefined;
    });

  /**
   * فشلٌ مُحقَن: مُشغِّلٌ يرفض تحديث صفّ مسيّرٍ بعينه. يُستعمل لإثبات أن تحديث الحالة
   * والقيد/السند صارا في معاملةٍ واحدة — لأن المُشغِّل يُنفَّذ داخل نفس المعاملة.
   */
  const failNextRunUpdate = (runId: string) =>
    withOwnerClient(ctx.db.ownerUrl, async (client) => {
      await client.query(`
        CREATE OR REPLACE FUNCTION audit_block_run_update() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'audit failpoint: payroll run update blocked'; END;
        $$ LANGUAGE plpgsql;
      `);
      await client.query(
        `CREATE TRIGGER audit_block_run_update_trigger BEFORE UPDATE ON payroll_runs
         FOR EACH ROW WHEN (NEW.id = '${runId}'::uuid) EXECUTE FUNCTION audit_block_run_update()`,
      );
    });

  const clearFailpoint = () =>
    withOwnerClient(ctx.db.ownerUrl, async (client) => {
      await client.query(`DROP TRIGGER IF EXISTS audit_block_run_update_trigger ON payroll_runs`);
      await client.query(`DROP FUNCTION IF EXISTS audit_block_run_update()`);
    });

  const createRun = async () => {
    const created = await post('/hrm/payroll/runs', { yearMonth: nextMonth() });
    expect(created.status).toBe(201);
    return String(data(created.body).id);
  };

  const openPeriodId = async () => {
    const periods = (await get('/fiscal-periods')).body.data as Array<Record<string, unknown>>;
    const month = new Date().toISOString().slice(0, 7);
    const period = periods.find((row) => row.status === 'open' && String(row.startDate ?? '').startsWith(month));
    expect(period?.id).toBeTruthy();
    return String(period!.id);
  };

  const postRunRequest = async (runId: string) =>
    post(`/hrm/payroll/runs/${runId}/post`, {
      branchId,
      fiscalPeriodId: await openPeriodId(),
      journalLines: [
        { accountId: payrollAccountId, debit: '5000', credit: '0' },
        { accountId: employeeAccountId, debit: '0', credit: '5000' },
      ],
    });

  beforeAll(async () => {
    ctx = await createTestApp('audit-payroll');
    actor = await createActor(ctx, {
      tenantCode: 'audit-payroll',
      email: 'owner@audit-payroll.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        'hrm.view',
        'hrm.manage',
        'hrm.payroll.post',
        'accounting.account.manage',
        'accounting.journal.post',
        'accounting.period.view',
        'accounting.period.close',
        'organization.branch.manage',
        'organization.cashlocation.manage',
        'organization.postingprofile.manage',
      ],
    });

    const year = new Date().getUTCFullYear();
    expect((await post('/fiscal-years', { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year + 1}-12-31` })).status).toBe(201);

    const branch = await post('/branches', { code: 'BR1', nameAr: 'الفرع الرئيسي' });
    expect(branch.status).toBe(201);
    branchId = data(branch.body).id as string;

    const cashAccountId = data((await post('/accounts', { code: '1211', nameAr: 'الصندوق', type: 'asset' })).body).id as string;
    cashLocationId = data((await post('/cash-locations', { branchId, kind: 'safe', name: 'الخزينة الرئيسية', accountId: cashAccountId })).body).id as string;

    payrollAccountId = data((await post('/accounts', { code: '3122001', nameAr: 'راتب أساسي', type: 'expense' })).body).id as string;
    employeeAccountId = data((await post('/accounts', { code: '2241', nameAr: 'موظفين الفرع الرئيسي', type: 'liability' })).body).id as string;

    // ملف الترحيل يحدّد «من أين خرج المال» لسند الصرف — بدونه يرفض مسار الصرف بـ422
    // (وذلك قبل أي كتابة، فيبقى الفشل المحقون هو ما يُختبر).
    const profile = await post('/branch-posting-profiles', {
      branchId,
      docType: 'payment_voucher',
      mapping: { version: 1, payableAccountId: employeeAccountId },
    });
    expect(profile.status).toBe(201);

    const employee = await post('/hrm/employees', {
      employeeNo: 'AP-1',
      name: 'سالم أحمد',
      branchId,
      salaryComponents: { basic: '5000', housing: '1000', transport: '500' },
    });
    expect(employee.status).toBe(201);
    employeeId = data(employee.body).id as string;
    expect(employeeId).toBeTruthy();
  }, 240_000);

  afterAll(async () => {
    await clearFailpoint().catch(() => undefined);
    await ctx.close();
  });

  it('فشل تحديث المسيّر أثناء الترحيل يُلغي القيد معه — لا قيد يتيم', async () => {
    const runId = await createRun();
    const yearMonth = String(data((await get(`/hrm/payroll/runs/${runId}`)).body).yearMonth);
    const description = `Payroll ${yearMonth}`;

    await failNextRunUpdate(runId);
    const failed = await postRunRequest(runId);
    expect(failed.status).toBeGreaterThanOrEqual(500);

    const after = await get(`/hrm/payroll/runs/${runId}`);
    expect(data(after.body).status, 'the run must not be half-posted').toBe('draft');
    expect(await journalCount(description), 'the journal must roll back with the run update').toBe(0);
    await clearFailpoint();
  });

  it('طلبُ ترحيلٍ ناجح واحد: القيد يُكتب مرة واحدة والحالة posted', async () => {
    const runId = await createRun();
    const yearMonth = String(data((await get(`/hrm/payroll/runs/${runId}`)).body).yearMonth);
    const description = `Payroll ${yearMonth}`;

    const posted = await postRunRequest(runId);
    expect([200, 201]).toContain(posted.status);
    expect(data(posted.body).status).toBe('posted');
    expect(await journalCount(description)).toBe(1);

    const replay = await postRunRequest(runId);
    expect(replay.status).toBe(409);
    expect(await journalCount(description), 'a second post must not write a second journal').toBe(1);
  });

  it('ترحيلان متزامنان: واحدٌ ينجح والآخر 409 — وقيدٌ واحد', async () => {
    const runId = await createRun();
    const yearMonth = String(data((await get(`/hrm/payroll/runs/${runId}`)).body).yearMonth);
    const description = `Payroll ${yearMonth}`;

    const [first, second] = await Promise.all([postRunRequest(runId), postRunRequest(runId)]);
    const statuses = [first.status, second.status].sort();
    expect(statuses.filter((status) => status === 409)).toHaveLength(1);
    expect(statuses.some((status) => status === 200 || status === 201)).toBe(true);
    expect(await journalCount(description)).toBe(1);
    expect(data((await get(`/hrm/payroll/runs/${runId}`)).body).status).toBe('posted');
  });

  it('فشل تحديث المسيّر أثناء الصرف يُلغي السند معه — لا سند مرحّل بلا مدفوع', async () => {
    const runId = await createRun();
    const posted = await postRunRequest(runId);
    expect([200, 201]).toContain(posted.status);

    await failNextRunUpdate(runId);
    const failed = await post(`/hrm/payroll/runs/${runId}/pay`, { branchId, cashLocationId, method: 'cash' });
    expect(failed.status).toBeGreaterThanOrEqual(500);

    expect(data((await get(`/hrm/payroll/runs/${runId}`)).body).status, 'the run stays posted').toBe('posted');
    expect(await voucherCount(`payroll:${runId}`), 'the voucher must roll back with the run update').toBe(0);
    await clearFailpoint();

    // إعادة المحاولة بعد زوال الفشل: أثر واحد فقط، والمسيّر يصير مدفوعاً.
    const retry = await post(`/hrm/payroll/runs/${runId}/pay`, { branchId, cashLocationId, method: 'cash' });
    expect([200, 201]).toContain(retry.status);
    expect(data(retry.body).status).toBe('paid');
    expect(await voucherCount(`payroll:${runId}`)).toBe(1);
  });

  it('صرفان متزامنان: سندٌ مرحّل واحد ومسيّر مدفوع مرة واحدة', async () => {
    const runId = await createRun();
    expect([200, 201]).toContain((await postRunRequest(runId)).status);
    const periodId = await openPeriodId();

    const [first, second] = await Promise.all([
      post(`/hrm/payroll/runs/${runId}/pay`, { branchId, cashLocationId, method: 'cash', fiscalPeriodId: periodId }),
      post(`/hrm/payroll/runs/${runId}/pay`, { branchId, cashLocationId, method: 'cash', fiscalPeriodId: periodId }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses.filter((status) => status === 409)).toHaveLength(1);
    expect(statuses.some((status) => status === 200 || status === 201)).toBe(true);

    const voucher = await voucherRow(`payroll:${runId}`);
    expect(voucher?.status).toBe('posted');
    expect(voucher?.journal_entry_id, 'the posted voucher has its journal').toBeTruthy();
    expect(data((await get(`/hrm/payroll/runs/${runId}`)).body)).toMatchObject({
      status: 'paid',
      voucherId: voucher?.id,
    });
    expect(await voucherCount(`payroll:${runId}`)).toBe(1);
  });
});
