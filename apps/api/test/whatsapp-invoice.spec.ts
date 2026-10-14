import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';
import { normalizePhone } from '../src/modules/integrations/whatsapp/whatsapp.service.js';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * 📱 إرسال الفاتورة عبر واتساب — the port of `Form_WPF/frmInvSale.xaml` L1190 «💬 واتساب»
 * and its handler (`frmInvSale.xaml.cs` L3130-L3195), behind
 * `Class/WhatsAppSender.cs` (267) and `Class/Session.cs` (L12-L31).
 *
 * What is proved here, in the order the window works:
 *
 *   1. the connection starts empty, switched off and in 🧪 Simulation;
 *   2. 💾 حفظ keeps the number and the token — and never hands the token back;
 *   3. 🧪 اختبار answers «is this number ours?» and keeps the answer;
 *   4. 💬 builds the desktop's own greeting — «🧾 مرحباً …» — and dials the number the
 *      desktop's own rule produces (`WhatsAppSender.cs` L113-L116);
 *   5. 📎 the invoice sheet goes with it, unless the tenant says otherwise;
 *   6. a number that is not on WhatsApp is *recorded*, not swallowed;
 *   7. the guards: a draft, a customer with no number, an unusable number, a switched-off
 *      gateway and a tenant that never configured one;
 *   8. the log the desktop never kept — newest first, filtered, and isolated per tenant;
 *   9. reading an invoice is not configuring the connection.
 *
 * Nothing is dialled: every send goes through 🧪 Simulation.
 */
describe('whatsapp — 📱 إرسال الفاتورة عبر واتساب', () => {
  let ctx: TestApp;
  let actor: Actor;
  let viewer: Actor;
  let other: Actor;
  let branchId = '';
  let warehouseId = '';
  let itemId = '';
  let partyId = '';
  const COMPANY_NAME = 'مؤسسة الأفق للتجارة';

  const body = (response: { body: Record<string, unknown> }) => (response.body.data ?? response.body) as Record<string, any>;
  const call = (method: 'get' | 'post' | 'put', path: string, options: { token: string; body?: unknown } = { token: '' }) =>
    api(ctx.server, method, `/api/v1${path}`, options);

  const settings = (token = actor.token) => call('get', '/whatsapp/settings', { token });
  const save = (input: Record<string, unknown>, token = actor.token) => call('put', '/whatsapp/settings', { token, body: input });
  const test = (token = actor.token) => call('post', '/whatsapp/test', { token, body: {} });
  const send = (input: Record<string, unknown>, token = actor.token) => call('post', '/whatsapp/send', { token, body: input });
  const log = (query = '', token = actor.token) => call('get', `/whatsapp/messages${query ? `?${query}` : ''}`, { token });

  async function newInvoice(options: { partyId?: string; cashName?: string; mobile?: string } = {}) {
    const created = await call('post', '/sales/invoices', {
      token: actor.token,
      body: {
        branchId,
        warehouseId,
        partyId: options.partyId,
        cashCustomerName: options.cashName,
        cashCustomerMobile: options.mobile,
        lines: [{ itemId, quantity: '2', unitPrice: '27.5', taxRate: '15' }],
      },
    });
    if (created.status >= 300) throw new Error(`invoice: ${created.status} ${JSON.stringify(created.body)}`);
    return String(body(created).id);
  }

  async function postedInvoice(options: { partyId?: string; cashName?: string; mobile?: string } = {}) {
    const id = await newInvoice(options);
    const posted = await call('post', `/sales/invoices/${id}/post`, { token: actor.token, body: {} });
    if (posted.status >= 300) throw new Error(`post: ${posted.status} ${JSON.stringify(posted.body)}`);
    return id;
  }

  beforeAll(async () => {
    ctx = await createTestApp('whatsapp');
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
      'tenant.settings.manage',
      'accounting.period.close',
    ];
    actor = await createActor(ctx, { tenantCode: 'whatsapp', email: 'owner@whatsapp.test', permissions });
    // من يفتح الفاتورة يُرسلها — `sales.view`; ولا يضبط الاتصال.
    viewer = await createActor(ctx, { tenantCode: 'whatsapp', email: 'viewer@whatsapp.test', permissions: ['sales.view'] });
    other = await createActor(ctx, { tenantCode: 'whatsapp2', email: 'owner@whatsapp2.test', permissions });

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
      body: { lines: [{ itemId, warehouseId, qty: '500', unitCost: '20', direction: 'in', docType: 'opening', docId: '00000000-0000-4000-8000-000000000061' }] },
    });
    partyId = body(
      await call('post', '/parties', {
        token: actor.token,
        body: { kind: 'customer', name: 'مؤسسة النخبة', taxNo: '310000000000012', phone: '0551234567' },
      }),
    ).id;
    await call('put', '/company-profile', {
      token: actor.token,
      body: { nameAr: COMPANY_NAME, nameEn: 'Al Ofoq Trading', taxNo: '310000000000003', crNo: '1010000000', address: { street: 'طريق الملك فهد', city: 'الرياض' } },
    });
  }, 240_000);

  afterAll(async () => ctx.close());

  it('starts empty: switched off, simulating, and dialling Saudi Arabia', async () => {
    const view = body(await settings());
    expect(view.settings.active).toBe(false);
    expect(view.settings.simulation).toBe(true);
    expect(view.settings.hasToken).toBe(false);
    expect(view.settings.tokenMasked).toBeNull();
    // «966» — the country code the desktop hard-coded (`WhatsAppSender.cs` L113-L116).
    expect(view.settings.defaultCountryCode).toBe('966');
    // 📎 — the desktop always attached the invoice.
    expect(view.settings.attachDocument).toBe(true);
  });

  it('saves 💾 حفظ — the number and the token, and never shows the token back', async () => {
    const saved = body(await save({ active: true, phoneNumberId: '109357128475620', accessToken: 'wa-test-token', simulation: true }));
    expect(saved.settings.active).toBe(true);
    expect(saved.settings.phoneNumberId).toBe('109357128475620');
    expect(saved.settings.hasToken).toBe(true);
    expect(saved.settings.tokenMasked).toBe('****oken');
    expect(JSON.stringify(saved)).not.toContain('wa-test-token');

    const again = body(await settings()).settings;
    expect(again.tokenMasked).toBe('****oken');
    expect(JSON.stringify(again)).not.toContain('wa-test-token');
  });

  it('keeps 🧪 اختبار where the window can show it', async () => {
    const result = body(await test());
    expect(result.simulation).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.displayPhoneNumber).toBeTruthy();
    expect(result.lines ?? []).toEqual([]); // the verify endpoint returns no lines; the row keeps them
    const stored = body(await settings()).settings.lastTest;
    expect(stored).toBeTruthy();
    expect(stored.lines.length).toBeGreaterThan(0);
    expect(stored.ok).toBe(true);
  });

  it('builds the desktop’s greeting and dials the number its own rule produces', async () => {
    const invoiceId = await postedInvoice({ partyId });
    const invoice = body(await call('get', `/sales/invoices/${invoiceId}`, { token: actor.token }));
    const sent = body(await send({ invoiceId }));
    expect(sent.message.status).toBe('sent');
    // `WhatsAppSender.cs` L113-L116: "0551234567" → "966551234567".
    expect(sent.message.phone).toBe('966551234567');
    // `frmInvSale.xaml.cs` L3177-L3178, word for word.
    expect(sent.message.message).toBe(`🧾 مرحباً مؤسسة النخبة، هذه فاتورتك رقم INV${invoice.number} من ${COMPANY_NAME}`);
    expect(sent.message.providerMessageId).toContain('wamid.');
    expect(sent.message.simulation).toBe(true);
  });

  it('attaches 📎 the invoice sheet — unless the sender says otherwise', async () => {
    const withSheet = body(await send({ invoiceId: await postedInvoice({ partyId }) }));
    expect(withSheet.attachment).toBe('sent');
    expect(withSheet.message.attachmentStatus).toBe('sent');
    expect(withSheet.message.attachmentName).toMatch(/^فاتورة-INV.+\.txt$/);
    expect(withSheet.message.attachmentMessageId).toContain('wamid.');

    const wordsOnly = body(await send({ invoiceId: await postedInvoice({ partyId }), attach: false }));
    expect(wordsOnly.attachment).toBe('none');
    expect(wordsOnly.message.attachmentStatus).toBe('none');
    expect(wordsOnly.message.attachmentName).toBeNull();
  });

  it('records a number that is not on WhatsApp instead of swallowing it', async () => {
    // 🧪 Simulation decides «not on WhatsApp» from the number itself — the only way a test
    // can ask for it. The message is the desktop's own (`WhatsAppSender.cs` L142).
    const invoiceId = await postedInvoice({ cashName: 'عميل نقدي', mobile: '0550000000' });
    const sent = body(await send({ invoiceId }));
    expect(sent.message.status).toBe('failed');
    expect(sent.message.phone).toBe('966550000000');
    expect(sent.message.error).toContain('الرقم غير مرتبط بحساب WhatsApp');
    // The row exists anyway — «هل وصلت؟» is answered from the log, not from a message box.
    const rows = body(await log('status=failed')).messages;
    expect(rows.some((row: any) => row.id === sent.message.id)).toBe(true);
  });

  it('refuses a مسوَّدة — there is no invoice number to name yet', async () => {
    const draft = await newInvoice({ partyId });
    const refused = await send({ invoiceId: draft });
    expect(refused.status).toBe(409);
    expect(body(refused).code).toBe('SALES_INVOICE_NOT_POSTED');
  });

  it('refuses a customer with no number, and a number that makes no sense', async () => {
    const noPhoneId = body(await call('post', '/parties', { token: actor.token, body: { kind: 'customer', name: 'عميل بلا جوال' } })).id;
    const missing = await send({ invoiceId: await postedInvoice({ partyId: noPhoneId }) });
    expect(missing.status).toBe(422);
    expect(body(missing).code).toBe('WHATSAPP_PHONE_MISSING');
    expect(body(missing).detail ?? body(missing).message).toContain('لا يوجد رقم جوال للعميل');

    const bad = await send({ invoiceId: await postedInvoice({ partyId }), to: '12' });
    expect(bad.status).toBe(422);
    expect(body(bad).code).toBe('WHATSAPP_PHONE_INVALID');
  });

  it('refuses to send while the connection is switched off', async () => {
    await save({ active: false });
    const refused = await send({ invoiceId: await postedInvoice({ partyId }) });
    expect(refused.status).toBe(409);
    expect(body(refused).code).toBe('WHATSAPP_DISABLED');
    expect(body(refused).detail ?? body(refused).message).toContain('الرجاء تفعيل الإرسال عبر واتساب.');
    await save({ active: true });
  });

  it('refuses a tenant that never configured the connection', async () => {
    const refused = await send({ invoiceId: await postedInvoice({ partyId }) }, other.token);
    expect(refused.status).toBe(404);
    expect(body(refused).code).toBe('WHATSAPP_NOT_CONFIGURED');
  });

  it('sends the words the caller asked for when they ask', async () => {
    const invoiceId = await postedInvoice({ partyId });
    const sent = body(await send({ invoiceId, message: 'فاتورتك جاهزة — نشكرك على تعاملك معنا.' }));
    expect(sent.message.message).toBe('فاتورتك جاهزة — نشكرك على تعاملك معنا.');
  });

  it('keeps the log: newest first, filtered, and capped', async () => {
    const rows = body(await log('limit=50')).messages;
    expect(rows.length).toBeGreaterThan(3);
    const times = rows.map((row: any) => Date.parse(row.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    const sentRows = body(await log('status=sent')).messages;
    expect(sentRows.length).toBeGreaterThan(0);
    expect(sentRows.every((row: any) => row.status === 'sent')).toBe(true);
    expect(body(await log('limit=2')).messages).toHaveLength(2);
  });

  it('answers «هل وصلت؟» from one invoice’s own lines', async () => {
    const invoiceId = await postedInvoice({ partyId });
    await send({ invoiceId });
    await send({ invoiceId });
    const rows = body(await log(`invoiceId=${invoiceId}`)).messages;
    expect(rows).toHaveLength(2);
    expect(rows.every((row: any) => row.invoiceId === invoiceId)).toBe(true);
  });

  it('refuses an invoice that is not there', async () => {
    const refused = await send({ invoiceId: '00000000-0000-4000-8000-000000000062' });
    expect(refused.status).toBe(404);
  });

  it('reads an invoice, sends it — and configures nothing', async () => {
    const invoiceId = await postedInvoice({ partyId });
    // من يرى الفاتورة يُرسلها: «💬 واتساب» lives on the invoice window itself.
    expect([200, 201]).toContain((await send({ invoiceId }, viewer.token)).status);
    expect((await log('limit=1', viewer.token)).status).toBe(200);
    // ومن يُرسل لا يغيّر من أين تخرج الرسائل.
    expect((await settings(viewer.token)).status).toBe(403);
    expect((await save({ active: true }, viewer.token)).status).toBe(403);
    expect((await test(viewer.token)).status).toBe(403);
    expect((await settings(actor.token)).status).toBe(200);
  });

  it('keeps one tenant’s messages out of another’s log', async () => {
    const mine = body(await log('limit=50')).messages;
    expect(mine.length).toBeGreaterThan(0);
    expect(body(await log('limit=50', other.token)).messages).toEqual([]);
  });

  it('normalises the number the way `WhatsAppSender.SendInvoiceAsync` does', () => {
    // L113-L116: `if (!text.StartsWith("966")) text = "966" + text.TrimStart('0');`
    expect(normalizePhone('0551234567')).toBe('966551234567');
    expect(normalizePhone('966551234567')).toBe('966551234567');
    expect(normalizePhone('+966 55 123 4567')).toBe('966551234567');
    // The country code is a setting, not a constant, for a tenant outside Saudi Arabia.
    expect(normalizePhone('0771234567', '967')).toBe('967771234567');
    expect(normalizePhone('')).toBe('');
  });
});
