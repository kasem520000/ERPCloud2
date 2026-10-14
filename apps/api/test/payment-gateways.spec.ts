import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * 💳 بوابات الدفع — the port of «إعدادات جيديا» and GroupBox «NeoLeap»
 * (`Form_WPF/frmSettings.xaml` L1726-L1831, `frmSettings.xaml.cs` `BtnSaveGedia_Click`
 * L2456 · `testGedia` L2498 · `Btnsavneoleap_Click` L2535 · `Btntestneoleap_Click` L4047)
 * and of the two POS save paths that charge a card
 * (`frmPOSBill.xaml.cs` L460-L492, `frmPOSPay.xaml.cs` L428-L441).
 *
 * What is proved here, in the order the window works:
 *
 *   1. the two cards exist and start stopped and in 🧪 Simulation;
 *   2. 💾 حفظ keeps the switch, the port and the secret — and never hands the secret back;
 *   3. 💳 on a stopped gateway is refused in the desktop's own words;
 *   4. 🧪 TEST leaves its answer in «Logging» where the window can show it;
 *   5. جيديا opens a session and stays pending until 🔄 asks again — NeoLeap answers at
 *      once and has nothing to ask about;
 *   6. the receipt a card leaves behind — approval code, RRN, STAN, scheme, masked PAN;
 *   7. ❌ مرفوضة · 🚫 ملغاة · ⚠️ تعذّر الوصول are all *recorded*, not swallowed;
 *   8. money guards: a non-positive amount, an unpaid draft, more than the balance;
 *   9. the same `ecrRef` twice is one sale, not two charges;
 *  10. an approved sale is written on the invoice — once;
 *  11. reading is not writing, and one tenant cannot see another's card log.
 *
 * Every gateway call goes through 🧪 Simulation, so no acquirer is ever dialled.
 */
describe('payment gateways — 💳 بوابات الدفع (جيديا · NeoLeap)', () => {
  let ctx: TestApp;
  let actor: Actor;
  let viewer: Actor;
  let other: Actor;
  let branchId = '';
  let warehouseId = '';
  let itemId = '';

  const body = (response: { body: Record<string, unknown> }) => (response.body.data ?? response.body) as Record<string, any>;
  const call = (method: 'get' | 'post' | 'put', path: string, options: { token: string; body?: unknown } = { token: '' }) =>
    api(ctx.server, method, `/api/v1${path}`, options);

  const view = (token = actor.token) => call('get', '/payment-gateways', { token });
  const save = (provider: string, input: Record<string, unknown>, token = actor.token) =>
    call('put', `/payment-gateways/${provider}`, { token, body: input });
  const test = (provider: string, input: Record<string, unknown> = {}, token = actor.token) =>
    call('post', `/payment-gateways/${provider}/test`, { token, body: input });
  const sale = (provider: string, input: Record<string, unknown>, token = actor.token) =>
    call('post', `/payment-gateways/${provider}/sale`, { token, body: input });
  const log = (query = '', token = actor.token) => call('get', `/payment-gateways/transactions${query ? `?${query}` : ''}`, { token });
  const refresh = (id: string, token = actor.token) => call('post', `/payment-gateways/transactions/${id}/refresh`, { token, body: {} });

  const provider = (rows: any[], key: string) => rows.find((row) => row.provider === key);

  async function newInvoice() {
    const created = await call('post', '/sales/invoices', {
      token: actor.token,
      body: { branchId, warehouseId, cashCustomerName: 'عميل نقدي', lines: [{ itemId, quantity: '2', unitPrice: '27.5', taxRate: '15' }] },
    });
    if (created.status >= 300) throw new Error(`invoice: ${created.status} ${JSON.stringify(created.body)}`);
    return String(body(created).id);
  }

  async function postedInvoice() {
    const id = await newInvoice();
    const posted = await call('post', `/sales/invoices/${id}/post`, { token: actor.token, body: {} });
    if (posted.status >= 300) throw new Error(`post: ${posted.status} ${JSON.stringify(posted.body)}`);
    return String(body(posted).id);
  }

  beforeAll(async () => {
    ctx = await createTestApp('paygw');
    const permissions = [
      ...ALL_PLATFORM_PERMISSIONS,
      ...ALL_ORGANIZATION_PERMISSIONS,
      'catalog.item.view',
      'catalog.item.manage',
      'catalog.unit.manage',
      'catalog.category.manage',
      'inventory.view',
      'inventory.adjust',
      'parties.view',
      'parties.manage',
      'sales.view',
      'sales.invoice.create',
      'sales.invoice.post',
      'sales.invoice.pay',
      'pos.view',
      'pos.config.manage',
      'pos.operate',
      'accounting.period.close',
    ];
    actor = await createActor(ctx, { tenantCode: 'paygw', email: 'owner@paygw.test', permissions });
    // القراءة غير الكتابة: `sales.view` reads the log, and nothing else here.
    viewer = await createActor(ctx, { tenantCode: 'paygw', email: 'viewer@paygw.test', permissions: ['sales.view'] });
    other = await createActor(ctx, { tenantCode: 'paygw2', email: 'owner@paygw2.test', permissions });

    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(actor.tenantId);
    branchId = defaults.branchId;
    const year = new Date().getUTCFullYear();
    await call('post', '/fiscal-years', { token: actor.token, body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` } });
    warehouseId = body(await call('post', '/warehouses', { token: actor.token, body: { branchId, code: 'WH1', name: 'المستودع' } })).id;
    const unitId = body(await call('post', '/organization/catalog/units', { token: actor.token, body: { code: 'PCE', nameAr: 'حبة' } })).id;
    const categoryId = body(await call('post', '/organization/catalog/categories', { token: actor.token, body: { code: 'GEN', nameAr: 'عام' } })).id;
    itemId = body(
      await call('post', '/organization/catalog/items', {
        token: actor.token,
        body: { sku: 'RICE-5', nameAr: 'أرز بسمتي ٥ كجم', categoryId, baseUnitId: unitId, kind: 'stock', salePrice: '27.5' },
      }),
    ).id;
    await call('post', '/inventory/ledger/record', {
      token: actor.token,
      body: { lines: [{ itemId, warehouseId, qty: '500', unitCost: '20', direction: 'in', docType: 'opening', docId: '00000000-0000-4000-8000-000000000041' }] },
    });
  }, 240_000);

  afterAll(async () => ctx.close());

  it('opens on the two cards of «إعدادات جيديا» — both stopped, both simulating', async () => {
    const providers = body(await view()).providers;
    expect(providers.map((row: any) => row.provider)).toEqual(['geidea', 'neoleap']);
    expect(providers.map((row: any) => row.labelAr)).toEqual(['جيديا', 'NeoLeap']);
    // The desktop's two rows start empty and switched off; 🧪 Simulation is ours, and it is
    // on by default because nothing here may charge a real card by accident.
    expect(providers.every((row: any) => row.active === false)).toBe(true);
    expect(providers.every((row: any) => row.simulation === true)).toBe(true);
    expect(providers.every((row: any) => row.hasSecret === false)).toBe(true);
    // جيديا's published KSA host; NeoLeap has none until «المنفذ» or an address is given.
    expect(provider(providers, 'geidea').baseUrl).toBe('https://api.ksamerchant.geidea.net');
    expect(provider(providers, 'neoleap').baseUrl).toBe('');
  });

  it('saves 💾 حفظ — the switch, the port and the secret, and never shows the secret back', async () => {
    const saved = body(
      await save('geidea', {
        active: true,
        printReceipt: true,
        port: 8080,
        currency: 'SAR',
        merchantKey: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        merchantSecret: 's3cr3t-pw',
        callbackUrl: 'https://example.test/hooks/geidea',
        simulation: true,
      }),
    );
    expect(saved.active).toBe(true);
    expect(saved.printReceipt).toBe(true);
    expect(saved.port).toBe(8080);
    expect(saved.merchantKey).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(saved.hasSecret).toBe(true);
    // `****` + the last four, as «إعدادات الربط الضريبي» shows a CSID.
    expect(saved.secretMasked).toBe('****t-pw');
    expect(saved.callbackUrl).toBe('https://example.test/hooks/geidea');

    const again = provider(body(await view()).providers, 'geidea');
    expect(again.secretMasked).toBe('****t-pw');
    expect(JSON.stringify(again)).not.toContain('s3cr3t-pw');
  });

  it('refuses 💳 on a gateway that is switched off, in the window’s own words', async () => {
    await save('neoleap', { active: false, port: 9090, merchantSecret: 'neo-token', simulation: true });
    const geideaOff = await sale('neoleap', { amount: '10.00' });
    expect(geideaOff.status).toBe(409);
    expect(body(geideaOff).code).toBe('PAYMENT_GATEWAY_DISABLED');
    // «الرجاء تفعيل NeoLeap!» — the label of the switch itself.
    expect(body(geideaOff).detail ?? body(geideaOff).message).toContain('الرجاء تفعيل NeoLeap!');

    await save('neoleap', { active: true });
    const off = body(await save('geidea', { active: false }));
    expect(off.active).toBe(false);
    const refused = await sale('geidea', { amount: '10.00' });
    expect(refused.status).toBe(409);
    expect(body(refused).detail ?? body(refused).message).toContain('الرجاء تفعيل الدفع عن طريق جيديا!');
    // 🧪 TEST asks the same question of the same switch (`BtnTestGedia_Click` L2519).
    const testRefused = await test('geidea');
    expect(testRefused.status).toBe(409);
    expect(body(testRefused).detail ?? body(testRefused).message).toContain('الرجاء تفعيل الدفع عن طريق جيديا!');
    await save('geidea', { active: true });
  });

  it('keeps 🧪 TEST in «Logging», where the window shows it', async () => {
    const geideaTest = body(await test('geidea'));
    expect(geideaTest.simulation).toBe(true);
    // A جيديا test opens a session for «المبلغ» — 0.01, the field's own default.
    expect(geideaTest.status).toBe('initiated');
    expect(geideaTest.responseCode).toBe('000');
    expect(geideaTest.message).toBe('Success');
    expect(geideaTest.lines.join('\n')).toContain('status: initiated');

    const neoleapTest = body(await test('neoleap'));
    expect(neoleapTest.status).toBe('approved');
    expect(neoleapTest.responseCode).toBe('00');
    expect(neoleapTest.message).toBe('Approved');

    // The desktop printed the connector's lines into a text box; the window re-reads them.
    const stored = provider(body(await view()).providers, 'geidea').lastTest;
    expect(stored).toBeTruthy();
    expect(stored.lines.length).toBeGreaterThan(0);
    expect(stored.status).toBe('initiated');
  });

  it('opens a جيديا session, then 🔄 accepts it — and answers at once for NeoLeap', async () => {
    const opened = body(await sale('geidea', { amount: '63.25' }));
    expect(opened.settled).toBe(false);
    expect(opened.transaction.status).toBe('initiated');
    expect(opened.transaction.responseCode).toBe('000');
    expect(opened.transaction.message).toBe('Success');
    // No card has paid yet, so no receipt fields exist to show.
    expect(opened.transaction.approvalCode).toBeNull();

    const done = body(await refresh(opened.transaction.id));
    expect(done.refreshed).toBe(true);
    expect(done.transaction.status).toBe('approved');
    expect(done.transaction.approvalCode).toHaveLength(6);
    expect(done.transaction.rrn).toHaveLength(12);
    expect(done.transaction.stan).toHaveLength(6);
    // `CardScheme.English` · `PAN` (masked as the receipt prints it) · `TransactionType`.
    expect(done.transaction.cardScheme).toBe('MADA');
    expect(done.transaction.panMasked).toBe('****4242');
    expect(done.transaction.transactionType).toBe('Pay');

    // A finished operation is not asked about twice.
    const again = body(await refresh(opened.transaction.id));
    expect(again.refreshed).toBe(false);

    // NeoLeap answers inside the sale — `TransactionResult.StatusCode` 00.
    const immediate = body(await sale('neoleap', { amount: '63.25' }));
    expect(immediate.transaction.status).toBe('approved');
    expect(immediate.transaction.responseCode).toBe('00');
    expect(immediate.transaction.message).toBe('Approved');
    // An operation the connector already answered has nothing left to ask about.
    const noQuestion = body(await refresh(immediate.transaction.id));
    expect(noQuestion.refreshed).toBe(false);
    expect(noQuestion.message).toContain('منتهية');
    // …but a row whose answer we could not read is exactly the case NeoLeap cannot help
    // with: there is no status call in the connector to port, and none is invented here.
    const unread = body(await sale('neoleap', { amount: '12.00', reference: 'UNKNOWN-1' }));
    expect(unread.transaction.status).toBe('unknown');
    const asked = body(await refresh(unread.transaction.id));
    expect(asked.refreshed).toBe(false);
    expect(asked.message).toContain('بوابة NeoLeap تُجيب فوراً');
    // جيديا is the opposite: a session the cardholder has not finished stays pending.
    const pending = body(await sale('geidea', { amount: '12.00', reference: 'PENDING-1' }));
    expect(pending.transaction.status).toBe('initiated');
    expect(body(await refresh(pending.transaction.id)).transaction.status).toBe('initiated');
  });

  it('records ❌ مرفوضة · 🚫 ملغاة · ⚠️ تعذّر الوصول instead of swallowing them', async () => {
    // 🧪 Simulation decides the cardholder's answer from the `ecrRef` prefix — the only
    // way a test can ask for a refusal without a real card.
    const declined = body(await sale('neoleap', { amount: '12.00', reference: 'DECLINE-1' }));
    expect(declined.transaction.status).toBe('declined');
    expect(declined.transaction.responseCode).toBe('01');
    expect(declined.transaction.message).toBe('Declined');
    expect(declined.settled).toBe(false);

    const cancelled = body(await sale('neoleap', { amount: '12.00', reference: 'CANCEL-1' }));
    expect(cancelled.transaction.status).toBe('cancelled');
    expect(cancelled.transaction.responseCode).toBe('02');
    expect(cancelled.transaction.message).toBe('Cancelled or Error');

    const unreachable = body(await sale('neoleap', { amount: '12.00', reference: 'ERROR-1' }));
    expect(unreachable.transaction.status).toBe('error');

    // جيديا is refused at the page, not at the till: the session opens, then fails.
    const pending = body(await sale('geidea', { amount: '12.00', reference: 'DECLINE-2' }));
    expect(pending.transaction.status).toBe('initiated');
    const failed = body(await refresh(pending.transaction.id));
    expect(failed.transaction.status).toBe('declined');
    expect(failed.transaction.responseCode).toBe('100');
  });

  it('guards the money — a non-positive amount, a draft, more than the balance', async () => {
    expect((await sale('geidea', { amount: '0' })).status).toBe(422);
    expect(body(await sale('geidea', { amount: '0' })).code).toBe('PAYMENT_AMOUNT_INVALID');
    expect((await sale('geidea', { amount: '-5' })).status).toBe(422);

    const draft = await newInvoice();
    const onDraft = await sale('neoleap', { amount: '10.00', invoiceId: draft });
    expect(onDraft.status).toBe(409);
    expect(body(onDraft).code).toBe('SALES_INVOICE_NOT_POSTED');

    const invoiceId = await postedInvoice();
    // «قيمة مدفوع الشبكة يجب أن تساوي صافي الفاتورة» (`frmPOSBill.xaml.cs` L505): the
    // desktop demanded equality; what is enforced here is the balance that is left.
    const over = await sale('neoleap', { amount: '999.00', invoiceId });
    expect(over.status).toBe(422);
    expect(body(over).code).toBe('PAYMENT_EXCEEDS_DUE');
  });

  it('charges once for one `ecrRef` — the desktop’s own idempotency key', async () => {
    const first = await sale('neoleap', { amount: '5.00', reference: 'ECR-FIXED-1' });
    expect(first.status).toBe(201);
    const second = await sale('neoleap', { amount: '5.00', reference: 'ECR-FIXED-1' });
    expect(second.status).toBe(409);
    expect(body(second).code).toBe('PAYMENT_REFERENCE_DUPLICATED');
  });

  it('writes an approved sale on the invoice — once', async () => {
    const invoiceId = await postedInvoice();
    const before = body(await call('get', `/sales/invoices/${invoiceId}`, { token: actor.token }));
    const due = before.total as string;

    const paid = body(await sale('neoleap', { amount: due, invoiceId, branchId, reference: `ECR-${invoiceId}` }));
    expect(paid.transaction.status).toBe('approved');
    expect(paid.settled).toBe(true);

    const after = body(await call('get', `/sales/invoices/${invoiceId}`, { token: actor.token }));
    expect(after.paidTotal).toBe(due);
    expect(after.paymentStatus).toBe('paid');

    // 🔄 asks the gateway again; the invoice must not be paid twice.
    const refreshed = body(await refresh(paid.transaction.id));
    expect(refreshed.refreshed).toBe(false);
    const still = body(await call('get', `/sales/invoices/${invoiceId}`, { token: actor.token }));
    expect(still.paidTotal).toBe(due);
  });

  it('lists the log newest first, and filters it by بوابة and حالة', async () => {
    const rows = body(await log('limit=50')).transactions;
    expect(rows.length).toBeGreaterThan(3);
    const times = rows.map((row: any) => Date.parse(row.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(body(await log('provider=geidea')).transactions.every((row: any) => row.provider === 'geidea')).toBe(true);
    expect(body(await log('provider=neoleap')).transactions.every((row: any) => row.provider === 'neoleap')).toBe(true);
    const declined = body(await log('status=declined')).transactions;
    expect(declined.length).toBeGreaterThan(0);
    expect(declined.every((row: any) => row.status === 'declined')).toBe(true);
    expect(body(await log('limit=1')).transactions).toHaveLength(1);
  });

  it('leaves 🧪 TEST out of the log — a probe is not a payment', async () => {
    const before = body(await log('limit=200')).transactions.length;
    await test('geidea');
    await test('neoleap');
    const after = body(await log('limit=200')).transactions.length;
    // The desktop showed the test answer in a message box (or in «Logging») and never
    // wrote a document for it; the probe is answered on the settings row instead.
    expect(after).toBe(before);
  });

  it('builds the address from «المنفذ», dials it for real, and never logs the secret', async () => {
    await save('neoleap', { active: true, port: 9, merchantSecret: 'neo-token-secret', simulation: false });
    const saved = provider(body(await view()).providers, 'neoleap');
    // المنفذ is the address the desktop dialled on the till: `http://127.0.0.1:<port>`.
    expect(saved.baseUrl).toBe('http://127.0.0.1:9');
    expect(saved.simulation).toBe(false);

    // Nothing is mocked: the call really goes out, and a closed port is an `error`, not
    // a success — the desktop's «العملية مرفوضة، يرجى إعادة الدفع» in its own words.
    const unreachable = body(await sale('neoleap', { amount: '7.00', reference: 'ECR-REAL-1' }));
    expect(unreachable.transaction.status).toBe('error');
    expect(unreachable.transaction.simulation).toBe(false);
    expect(String(unreachable.transaction.message)).toContain('تعذّر الوصول إلى بوابة NeoLeap');

    // The token travelled in the request; it must not come back in the log.
    expect(JSON.stringify(unreachable.transaction)).not.toContain('neo-token-secret');

    await save('neoleap', { active: true, port: 9090, merchantSecret: 'neo-token', simulation: true });
  });

  it('records what the desktop threw away — المبلغ، العملة، الفرع، و🧪', async () => {
    const row = body(await sale('neoleap', { amount: '18.50', currency: 'USD', branchId, reference: 'ECR-META-1' })).transaction;
    expect(row.amount).toBe('18.5000');
    expect(row.currency).toBe('USD');
    expect(row.branchId).toBe(branchId);
    expect(row.simulation).toBe(true);
    expect(row.reference).toBe('ECR-META-1');
    expect(row.settled).toBe(false);
    expect(row.invoiceId).toBeNull();
    // The gateway's own answer is kept as it was given, because a declined card is argued
    // about later — and the argument is settled with its words, not ours.
    expect(row.message).toBe('Approved');
  });

  it('refuses a port outside 0–65535 and a gateway that does not exist', async () => {
    const port = await save('geidea', { port: 70000 });
    expect(port.status).toBe(422);
    expect(body(port).code).toBe('PAYMENT_PORT_INVALID');
    const unknown = await save('visa', { active: true });
    expect(unknown.status).toBe(422);
    expect(body(unknown).code).toBe('PAYMENT_PROVIDER_UNKNOWN');
  });

  it('keeps reading apart from writing', async () => {
    // القراءة: `sales.view` sees the log the desktop never kept.
    expect((await log('', viewer.token)).status).toBe(200);
    expect((await log('provider=neoleap', viewer.token)).status).toBe(200);
    // الكتابة: configuring a gateway, testing it and charging a card are three different
    // doors, and `sales.view` opens none of them.
    expect((await view(viewer.token)).status).toBe(403);
    expect((await save('geidea', { active: true }, viewer.token)).status).toBe(403);
    expect((await test('geidea', {}, viewer.token)).status).toBe(403);
    expect((await sale('geidea', { amount: '1.00' }, viewer.token)).status).toBe(403);
    expect((await view(actor.token)).status).toBe(200);
  });

  it('isolates one tenant’s card log from another’s', async () => {
    const mine = body(await log('limit=50'));
    expect(mine.transactions.length).toBeGreaterThan(0);
    expect(mine.transactions.every((row: any) => row.provider === 'geidea' || row.provider === 'neoleap')).toBe(true);

    const theirs = body(await log('limit=50', other.token));
    expect(theirs.transactions).toEqual([]);

    const hidden = await refresh(String(mine.transactions[0].id), other.token);
    expect(hidden.status).toBe(404);
    expect(body(hidden).code).toBe('PAYMENT_TRANSACTION_NOT_FOUND');
  });
});
