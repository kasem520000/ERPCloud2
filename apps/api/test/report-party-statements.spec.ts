import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Phase 10 part eight — 📑 كشوف الحساب: the seven «كشف حساب» windows of the desktop and
 * the three of them the cloud did not have.
 *
 *   `frmCustAccount.xaml`     «أرصدة حساب العملاء»       → customer-balances
 *   `frmCustAccountGet.xaml`  «📋 كشف حساب عميل»         → party-statement
 *   `frmCustLastPay.xaml`     «📋 حركة آخر سداد للعملاء» → customer-last-payment
 *
 * The other four were already live from earlier phases and this part only completes them:
 * `frmAccountBalance` and `frmAccountsStatement` share `GET /statements/general-ledger/:id`
 * (`with_descendants`), `frmCostCenterBalance` is `GET /statements/cost-center/:id`, and
 * `frmEmpAccountGet` is `GET /hrm/employee-statement`.
 *
 * The rules these three have to keep:
 *
 *   - `frmCustAccount.xaml.cs` L221-L231 — a customer's movement is the movement of **his
 *     own account** (`Entry_sub.acc_no = Customers.AccountCode`), and L258-L288 rounds the
 *     balance to three decimals and names it «مدين» when the debit side is the larger one.
 *     The cloud counts the lines that carry the party as well, because a payment posted
 *     against the bank carries the customer on the bank line.
 *   - `frmCustAccountGet.xaml.cs` L336-L343 — one row per **entry** (`GROUP BY
 *     GlobalID, date, notes, acc_no`), and `UpdateSummary` L583-L609 puts the رصيد on one
 *     side only: الرصيد المدين or الرصيد الدائن, never both.
 *   - `frmCustLastPay.xaml.cs` L222-L231 — the last payment is `SELECT TOP 1 … ORDER BY id
 *     DESC` over the account's lines; L258 `lastPayAmount = dept == 0 ? credit : dept`; and
 *     L430-L435 sums the last payments into «💳 الإجمالي» and the balances into «⚖️ الرصيد».
 *     The window has **no** date box, so neither does the report.
 */
describe('كشوف الحساب — frmCustAccount · frmCustAccountGet · frmCustLastPay', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;
  let forbidden: Actor;

  let branchId = '';
  let receivableId = '';
  let payableId = '';
  let cashId = '';
  let revenueId = '';

  let customerId = '';
  let supplierId = '';

  let firstNumber = '';
  let paymentNumber = '';

  const today = new Date();
  const year = today.getUTCFullYear();
  const iso = (offsetDays: number) => new Date(today.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);

  const data = (body: Record<string, unknown>): Record<string, unknown> => (body.data ?? body) as Record<string, unknown>;
  const rowsIn = (body: unknown): Array<Record<string, string>> =>
    (data(body as Record<string, unknown>) as { rows: Array<Record<string, string>> }).rows ?? [];
  /** The catalogue is a bare array; the report envelope wraps its rows in `data`. */
  const anyRows = (body: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(body) ? body : ((body as { data?: unknown }).data as Array<Record<string, unknown>>)) ?? [];
  const money = (value: unknown) => Number(value ?? 0).toFixed(2);
  const cardOf = (body: unknown, key: string): string =>
    ((data(body as Record<string, unknown>) as { grandTotal: Array<{ key: string; amount: string }> }).grandTotal ?? []).find(
      (card) => card.key === key,
    )?.amount ?? '0';

  const post = (path: string, body: Record<string, unknown>) =>
    api(ctx.server, 'post', `/api/v1${path}`, { token: actor.token, body });
  const get = (path: string, token = actor.token) => api(ctx.server, 'get', `/api/v1${path}`, { token });
  const report = (key: string, query = '', token = actor.token) => get(`/reports/${key}?${query}`, token);

  const entry = async (
    lines: Array<{ accountId: string; debit?: string; credit?: string; partyId?: string }>,
    date: string,
    description: string,
  ) => {
    const posted = await post('/journal-entries', { date, description, lines });
    expect(posted.status).toBeLessThan(300);
    return data(posted.body) as { id: string; number: string | null };
  };

  beforeAll(async () => {
    ctx = await createTestApp('report-party-statements');
    actor = await createActor(ctx, {
      tenantCode: 'rpt-party',
      email: 'owner@rpt-party.test',
      fullName: 'مستخدم كشوف الحساب',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'accounting.account.view',
        'accounting.account.manage',
        'accounting.journal.post',
        'accounting.period.view',
        'accounting.period.close',
        'accounting.reports.view',
        'parties.view',
        'parties.manage',
        'sales.view',
        'sales.salesman.manage',
        'reporting.view',
      ],
    });
    stranger = await createActor(ctx, {
      tenantCode: 'rpt-party-2',
      email: 'owner@rpt-party-2.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, ...ALL_ORGANIZATION_PERMISSIONS, 'reporting.view'],
    });
    forbidden = await createActor(ctx, {
      tenantCode: 'rpt-party',
      email: 'nobody@rpt-party.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS], // without `reporting.view`
    });

    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(actor.tenantId);
    branchId = defaults.branchId;

    const fiscal = await post('/fiscal-years', { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` });
    expect(fiscal.status).toBe(201);

    const account = async (code: string, nameAr: string, type: string) => {
      const created = await post('/accounts', { code, nameAr, type });
      expect(created.status).toBe(201);
      return data(created.body).id as string;
    };
    receivableId = await account('1201', 'ذمم العملاء', 'asset');
    payableId = await account('2101', 'الموردون', 'liability');
    cashId = await account('9901', 'الصندوق', 'asset');
    revenueId = await account('9101', 'إيراد مبيعات', 'revenue');

    const party = async (name: string, kind: string, extra: Record<string, unknown>) => {
      const created = await post('/parties', { kind, name, branchId, ...extra });
      expect(created.status).toBe(201);
      return data(created.body).id as string;
    };
    customerId = await party('عميل كشف الحساب', 'customer', { phone: '0123456', receivableAccountId: receivableId });
    supplierId = await party('مورد كشف الحساب', 'supplier', { payableAccountId: payableId });
    // 👤 عميل بلا حساب ولا حركة — `frmCustAccount` prints nobody with an empty movement.
    await party('عميل بلا حركة', 'customer', {});

    // البيع على الحساب: 1000 مديناً على ذمم العملاء.
    const first = await entry(
      [
        { accountId: receivableId, debit: '1000', partyId: customerId },
        { accountId: revenueId, credit: '1000' },
      ],
      iso(-6),
      'فاتورة بيع آجلة',
    );
    firstNumber = first.number ?? '';
    // السداد: 400 دائناً على ذمم العملاء — وهو «آخر سداد».
    const payment = await entry(
      [
        { accountId: cashId, debit: '400', partyId: customerId },
        { accountId: receivableId, credit: '400', partyId: customerId },
      ],
      iso(-3),
      'سند قبض من العميل',
    );
    paymentNumber = payment.number ?? '';
    // والمورد: 250 مديناً على حسابه.
    await entry(
      [
        { accountId: payableId, debit: '250', partyId: supplierId },
        { accountId: cashId, credit: '250', partyId: supplierId },
      ],
      iso(-1),
      'سند صرف للمورد',
    );
  }, 240_000);

  afterAll(async () => {
    await ctx?.close();
  });

  describe('أرصدة حساب العملاء — `frmCustAccount`', () => {
    it('لكل عميلٍ تحرّك حسابه سطر: مدينه ودائنه ورصيده وحالته', async () => {
      const body = (await report('customer-balances')).body;
      const rows = rowsIn(body);

      // «عميل بلا حركة» لا يُطبع: النافذة لا تُظهر إلا من تحرك حسابه (L221-L231).
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.party))).toEqual(new Set(['عميل كشف الحساب', 'مورد كشف الحساب']));

      const customer = rows.find((row) => row.party === 'عميل كشف الحساب')!;
      expect(customer.account_code).toBe('1201'); // 🔢 رقم الحساب
      expect(money(customer.debit)).toBe('1000.00');
      expect(money(customer.credit)).toBe('400.00');
      expect(money(customer.balance)).toBe('600.00'); // ⚖️ الرصيد — الفرق مطلقاً
      expect(customer.status).toBe('مدين'); // 📌 الحالة
      expect(['1', '2']).toContain(customer.seq); // م

      const supplier = rows.find((row) => row.party === 'مورد كشف الحساب')!;
      expect(money(supplier.debit)).toBe('250.00');
      expect(money(supplier.credit)).toBe('0.00');
      expect(money(supplier.balance)).toBe('250.00');
      expect(supplier.status).toBe('مدين');
    });

    it('🏷️ نوع الحساب — «عملاء» و«موردين»، و«الكل» يجمعهما', async () => {
      expect(rowsIn((await report('customer-balances', 'partyKind=customer')).body).map((row) => row.party)).toEqual([
        'عميل كشف الحساب',
      ]);
      expect(rowsIn((await report('customer-balances', 'partyKind=supplier')).body).map((row) => row.party)).toEqual([
        'مورد كشف الحساب',
      ]);
      expect(rowsIn((await report('customer-balances', 'partyKind=all')).body)).toHaveLength(2);
    });

    it('👤 اسم العميل — تقرير عميلٍ واحد، والفترة تُقصّ ما قبلها', async () => {
      expect(rowsIn((await report('customer-balances', `partyId=${customerId}`)).body)).toHaveLength(1);
      // The 1000 was posted six days ago; a period that starts today sees none of it.
      expect(rowsIn((await report('customer-balances', `from=${iso(0)}&to=${iso(0)}`)).body)).toHaveLength(0);
      expect(rowsIn((await report('customer-balances', `from=${iso(-7)}&to=${iso(-4)}`)).body)).toHaveLength(1);
    });

    it('🤝 كل المندوبين — مندوبٌ لا علاقة له بالحركة لا يُظهر أحداً', async () => {
      const salesman = await post('/sales/salesmen', { code: 'SM-1', name: 'مندوب كشف الحساب', branchId });
      expect(salesman.status).toBeLessThan(300);
      const body = (await report('customer-balances', `salesmanId=${data(salesman.body).id}`)).body;
      expect(rowsIn(body)).toHaveLength(0);
    });

    it('مستأجر آخر لا يرى أرصدة عملائنا', async () => {
      expect(rowsIn((await report('customer-balances', '', stranger.token)).body)).toHaveLength(0);
    });
  });

  describe('كشف حساب عميل — `frmCustAccountGet`', () => {
    it('قيدٌ بسطر، والبيان والعميل ورقم القيد', async () => {
      const body = (await report('party-statement', `partyId=${customerId}`)).body;
      const rows = rowsIn(body);

      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        seq: '1',
        number: firstNumber,
        note: 'فاتورة بيع آجلة',
        party: 'عميل كشف الحساب',
      });
      expect(money(rows[0].debit)).toBe('1000.00');
      expect(money(rows[0].credit)).toBe('0.00');
      expect(rows[1]).toMatchObject({ seq: '2', number: paymentNumber, note: 'سند قبض من العميل' });
      // Only the line on the customer's own account is his movement: the entry's other
      // line debits the صندوق, and that is the shop's money, not his.
      expect(money(rows[1].debit)).toBe('0.00');
      expect(money(rows[1].credit)).toBe('400.00');
    });

    it('💳 · 💵 · ⚖️ — الرصيد يقف على جانبٍ واحد ولا يظهر على الجانبين معاً', async () => {
      const body = (await report('party-statement', `partyId=${customerId}`)).body;
      expect(money(cardOf(body, 's_debit'))).toBe('1000.00'); // إجمالي المدين
      expect(money(cardOf(body, 's_credit'))).toBe('400.00'); // إجمالي الدائن
      expect(money(cardOf(body, 's_bal_debit'))).toBe('600.00'); // الرصيد المدين
      expect(money(cardOf(body, 's_bal_credit'))).toBe('0.00'); // الرصيد الدائن
      expect(money(cardOf(body, 's_count'))).toBe('2.00'); // عدد القيود

      // `UpdateSummary` L583-L609: the two رصيد cards can never both carry money.
      expect(Number(cardOf(body, 's_bal_debit')) * Number(cardOf(body, 's_bal_credit'))).toBe(0);
    });

    it('المورد له الكشف نفسه بـ«🏷️ نوع الحساب»، ورصيده إلى جانبه', async () => {
      const body = (await report('party-statement', `partyKind=supplier`)).body;
      const rows = rowsIn(body);
      expect(rows).toHaveLength(1);
      expect(rows[0].party).toBe('مورد كشف الحساب');
      expect(money(cardOf(body, 's_bal_debit'))).toBe('250.00');
    });

    it('🌿 الفرع والفترة — قيدٌ خارج الفترة لا يُكتب في الكشف', async () => {
      expect(rowsIn((await report('party-statement', `partyId=${customerId}&from=${iso(-7)}&to=${iso(-5)}`)).body)).toHaveLength(1);
      expect(rowsIn((await report('party-statement', `partyId=${customerId}&from=${iso(1)}&to=${iso(2)}`)).body)).toHaveLength(0);
      expect(rowsIn((await report('party-statement', `partyId=${customerId}&branchId=${branchId}`)).body)).toHaveLength(2);
    });

    it('🚫 بلا صلاحية «التقارير» لا كشف', async () => {
      const denied = await report('party-statement', `partyId=${customerId}`, forbidden.token);
      expect(denied.status).toBe(403);
    });
  });

  describe('حركة آخر سداد للعملاء — `frmCustLastPay`', () => {
    it('آخر قيدٍ حرّك الحساب: قيمته وتاريخه ونوعه', async () => {
      const body = (await report('customer-last-payment')).body;
      const rows = rowsIn(body);

      expect(rows).toHaveLength(2);
      const customer = rows.find((row) => row.party === 'عميل كشف الحساب')!;
      // L222-L231: the last entry on the account, and L258 `dept == 0 ? credit : dept`.
      expect(customer.entry_no).toBe(paymentNumber);
      expect(money(customer.last_amount)).toBe('400.00');
      expect(customer.last_day).toBe(iso(-3));
      expect(customer.entry_type).toBe('قيد اليومية');
      // L258-L275: the balance is the whole account's, not the period's — there is none.
      expect(money(customer.balance)).toBe('600.00');
      expect(customer.status).toBe('مدين');
      expect(customer.account_code).toBe('1201');
      expect(customer.phone).toBe('0123456');
    });

    it('💳 الإجمالي · ⚖️ الرصيد · 📌 السجلات', async () => {
      const body = (await report('customer-last-payment')).body;
      expect(money(cardOf(body, 's_total'))).toBe('650.00'); // 400 + 250
      expect(money(cardOf(body, 's_balance'))).toBe('850.00'); // 600 + 250
      expect(money(cardOf(body, 's_count'))).toBe('2.00');
    });

    it('👤 اسم العميل — كشف عميلٍ واحد، ولا فترة في هذه النافذة', async () => {
      const body = (await report('customer-last-payment', `partyId=${supplierId}`)).body;
      expect(rowsIn(body).map((row) => row.party)).toEqual(['مورد كشف الحساب']);
      // `frmCustLastPay` has no date box at all, so the report declares no period either.
      const catalog = anyRows((await get('/reports')).body);
      const definition = catalog.find((entry) => entry.key === 'customer-last-payment')!;
      expect((definition.params as Array<{ name: string }>).map((param) => param.name)).toEqual(['partyId', 'partyKind']);
    });

    it('مستأجر آخر لا يرى سدادات عملائنا', async () => {
      expect(rowsIn((await report('customer-last-payment', '', stranger.token)).body)).toHaveLength(0);
    });
  });
});
