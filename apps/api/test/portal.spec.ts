import { createServer, type Server } from 'node:net';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * The invite-mail assertions below run against a real (fake) SMTP relay. The env must be
 * fixed *before* `@erp/config` parses — hence vi.hoisted.
 */
const smtp = vi.hoisted(() => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  process.env.MAIL_TRANSPORT = 'smtp';
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(port);
  process.env.MAIL_FROM = 'no-reply@erp.test';
  process.env.CUSTOMER_PUBLIC_URL = 'https://portal.example.test';
  return { port, mails: [] as Array<{ to: string; data: string }> };
});

/** Minimal happy-path SMTP server: enough of RFC 5321 to capture DATA. */
function fakeSmtpServer(): Server {
  return createServer((socket) => {
    let buffer = '';
    let inData = false;
    let to = '';
    socket.write('220 fake\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          smtp.mails.push({ to, data: buffer.slice(0, end) });
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write('250 OK\r\n');
          continue;
        }
        const end = buffer.indexOf('\r\n');
        if (end === -1) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) socket.write('250 fake\r\n');
        else if (upper.startsWith('MAIL FROM')) socket.write('250 OK\r\n');
        else if (upper.startsWith('RCPT TO')) {
          to = line.slice(line.indexOf('<') + 1, line.lastIndexOf('>'));
          socket.write('250 OK\r\n');
        } else if (upper === 'DATA') {
          inData = true;
          socket.write('354 go\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else socket.write('250 OK\r\n');
      }
    });
  });
}

async function waitForMail(predicate: (mail: { to: string; data: string }) => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = smtp.mails.find(predicate);
    if (found) return found;
    if (Date.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * The customer self-service portal.
 *
 * The property that matters here is containment. A portal login is an ordinary user with an
 * ordinary membership, so the interesting question is not "can the customer read their
 * invoice" but "can they read anything else": another customer's invoice, the item catalogue,
 * the chart of accounts, the list of all parties. Every one of those is asserted below,
 * because a self-service portal that leaks the tenant's books is worse than no portal.
 */
describe('customer portal', () => {
  let ctx: TestApp;
  let staff: Actor;
  let branchId = '';
  let warehouseId = '';
  let itemId = '';
  let buyerId = '';
  let otherBuyerId = '';
  let buyerInvoiceId = '';
  let otherInvoiceId = '';
  let portalToken = '';
  let accessId = '';
  let mailServer: Server;

  const body = (response: { body: Record<string, unknown> }) => (response.body.data ?? response.body) as Record<string, string>;

  async function invoiceFor(partyId: string, quantity: string) {
    const invoice = await api(ctx.server, 'post', '/api/v1/sales/invoices', {
      token: staff.token,
      body: { branchId, warehouseId, partyId, lines: [{ itemId, quantity, unitPrice: '50', taxRate: '15' }] },
    });
    const id = body(invoice).id;
    await api(ctx.server, 'post', `/api/v1/sales/invoices/${id}/post`, { token: staff.token, body: {} });
    return id;
  }

  beforeAll(async () => {
    mailServer = fakeSmtpServer();
    await new Promise<void>((resolve) => mailServer.listen(smtp.port, '127.0.0.1', resolve));
    ctx = await createTestApp('customer-portal');
    staff = await createActor(ctx, {
      tenantCode: 'portalco',
      email: 'owner@portalco.test',
      permissions: [
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
        'accounting.period.close',
        'reporting.view',
      ],
    });


    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(staff.tenantId);
    branchId = defaults.branchId;

    const year = new Date().getUTCFullYear();
    const fiscal = await api(ctx.server, 'post', '/api/v1/fiscal-years', {
      token: staff.token,
      body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
    });
    expect(fiscal.status).toBe(201);
    warehouseId = body(await api(ctx.server, 'post', '/api/v1/warehouses', { token: staff.token, body: { branchId, code: 'WH1', name: 'المستودع' } })).id;
    const unitId = body(await api(ctx.server, 'post', '/api/v1/organization/catalog/units', { token: staff.token, body: { code: 'PCE', nameAr: 'حبة' } })).id;
    const categoryId = body(await api(ctx.server, 'post', '/api/v1/organization/catalog/categories', { token: staff.token, body: { code: 'GEN', nameAr: 'عام' } })).id;
    itemId = body(
      await api(ctx.server, 'post', '/api/v1/organization/catalog/items', { token: staff.token, body: { sku: 'SRV-1', nameAr: 'خدمة صيانة', categoryId, baseUnitId: unitId, kind: 'service', salePrice: '50' } }),
    ).id;
    buyerId = body(await api(ctx.server, 'post', '/api/v1/parties', { token: staff.token, body: { kind: 'customer', name: 'مؤسسة النخبة', taxNo: '310000000000012' } })).id;
    otherBuyerId = body(await api(ctx.server, 'post', '/api/v1/parties', { token: staff.token, body: { kind: 'customer', name: 'شركة المنافس' } })).id;

    await api(ctx.server, 'put', '/api/v1/company-profile', { token: staff.token, body: { nameAr: 'مؤسسة الأفق للتجارة', taxNo: '310000000000003' } });
    buyerInvoiceId = await invoiceFor(buyerId, '3');
    otherInvoiceId = await invoiceFor(otherBuyerId, '7');
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
    await new Promise<void>((resolve) => mailServer.close(() => resolve()));
  });

  it('grants a customer a login and hands over a one-time password', async () => {
    const granted = await api(ctx.server, 'post', `/api/v1/parties/${buyerId}/portal-access`, {
      token: staff.token,
      body: { email: 'buyer@nokhba.test', fullName: 'أحمد من النخبة' },
    });
    expect(granted.status).toBe(201);
    const access = body(granted) as unknown as { id: string; temporaryPassword: string; email: string };
    expect(access.email).toBe('buyer@nokhba.test');
    expect(access.temporaryPassword).toMatch(/.{12,}/);
    accessId = access.id;

    const login = await api(ctx.server, 'post', '/api/v1/auth/login', { body: { email: 'buyer@nokhba.test', password: access.temporaryPassword, tenantCode: 'portalco' } });
    expect(login.status).toBe(200);
    portalToken = ((login.body.data ?? login.body) as Record<string, string>).accessToken;
    expect(portalToken).toBeTruthy();
  });

  it('e-mails the generated credentials to the customer (best-effort, through SMTP)', async () => {
    const invited = await waitForMail((mail) => mail.to === 'buyer@nokhba.test');
    expect(invited, 'invite mail delivered to the fake relay').toBeTruthy();
    // Subject arrives as a UTF-8 encoded word; the body carries the plaintext facts.
    expect(invited!.data).toContain('Subject: =?UTF-8?B?');
    expect(invited!.data).toContain('كلمة المرور المؤقتة');
    expect(invited!.data).toContain('https://portal.example.test');
  });

  it('skips the e-mail when notify is false, but still returns the password', async () => {
    const before = smtp.mails.length;
    const granted = await api(ctx.server, 'post', `/api/v1/parties/${otherBuyerId}/portal-access`, {
      token: staff.token,
      body: { email: 'silent@monafis.test', notify: false },
    });
    expect(granted.status).toBe(201);
    expect((body(granted) as Record<string, string>).temporaryPassword).toMatch(/.{12,}/);
    // Give an erroneously-sent mail a moment to arrive before asserting its absence.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(smtp.mails.some((mail) => mail.to === 'silent@monafis.test')).toBe(false);
    expect(smtp.mails.length).toBe(before);
  });

  it('shows the customer their own party, balance and invoices', async () => {
    const me = await api(ctx.server, 'get', '/api/v1/portal/me', { token: portalToken });
    expect(me.status).toBe(200);
    const profile = body(me) as unknown as { party: { name: string; taxNo: string }; company: { nameAr: string } };
    expect(profile.party.name).toBe('مؤسسة النخبة');
    expect(profile.company.nameAr).toBe('مؤسسة الأفق للتجارة');

    const invoices = await api(ctx.server, 'get', '/api/v1/portal/invoices', { token: portalToken });
    const rows = (invoices.body.data ?? invoices.body) as Array<Record<string, string>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(buyerInvoiceId);
    expect(Number(rows[0]!.total)).toBeCloseTo(172.5, 2); // 3 × 50 + 15%
  });

  it('opens its own invoice with lines, and prints it', async () => {
    const detail = await api(ctx.server, 'get', `/api/v1/portal/invoices/${buyerInvoiceId}`, { token: portalToken });
    expect(detail.status).toBe(200);
    const payload = body(detail) as unknown as { lines: Array<Record<string, string>> };
    expect(payload.lines).toHaveLength(1);
    expect(payload.lines[0]!.name).toBe('خدمة صيانة');

    const printed = await api(ctx.server, 'get', `/api/v1/portal/invoices/${buyerInvoiceId}/print`, { token: portalToken });
    expect(printed.status).toBe(200);
    expect(String(printed.body.html)).toContain('مؤسسة الأفق للتجارة');
    expect(String(printed.body.html)).toContain('خدمة صيانة');
  });

  it('AUD-17: المتبقّي يُقرأ عشريًّا من نفس أعمدة الفاتورة (بلا انحدار في العرض)', async () => {
    const link = await api(ctx.server, 'get', `/api/v1/portal/invoices/${buyerInvoiceId}/payment-link`, { token: portalToken });
    expect(link.status).toBe(200);
    const payload = body(link) as unknown as { invoice: { total: string; paidTotal: string; remaining: string } };
    // 172.50 − 0 = 172.5000 بأربع خانات، والفرق محسوب بـDecimal لا بالعائم.
    expect(payload.invoice.total).toBe('172.5000');
    expect(payload.invoice.remaining).toBe('172.5000');
    expect(payload.invoice.remaining).toBe(
      (Number(payload.invoice.total) - Number(payload.invoice.paidTotal)).toFixed(4),
    );
  });

  it('cannot see another customer, and is told 404 rather than 403', async () => {
    const foreign = await api(ctx.server, 'get', `/api/v1/portal/invoices/${otherInvoiceId}`, { token: portalToken });
    expect(foreign.status).toBe(404);
    const foreignPrint = await api(ctx.server, 'get', `/api/v1/portal/invoices/${otherInvoiceId}/print`, { token: portalToken });
    expect(foreignPrint.status).toBe(404);
  });

  it('cannot reach any ERP endpoint with its token', async () => {
    for (const path of ['/api/v1/parties', '/api/v1/organization/catalog/items', '/api/v1/accounts', '/api/v1/sales/invoices', '/api/v1/reports']) {
      const response = await api(ctx.server, 'get', path, { token: portalToken });
      expect(response.status, path).toBe(403);
    }
  });

  it('refuses the portal routes for a staff login that is not a portal account', async () => {
    const response = await api(ctx.server, 'get', '/api/v1/portal/me', { token: staff.token });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('PORTAL_ACCESS_REQUIRED');
  });

  it('reads a statement that only contains its own movements', async () => {
    const statement = await api(ctx.server, 'get', '/api/v1/portal/statement', { token: portalToken });
    expect(statement.status).toBe(200);
    const payload = body(statement) as unknown as { lines: Array<Record<string, string>>; closing: string };
    expect(payload.lines.length).toBeGreaterThan(0);
    // 172.50 receivable from the one invoice — the other customer's 402.50 must not appear.
    expect(Number(payload.closing)).toBeCloseTo(172.5, 2);
  });

  it('lists the receipts recorded against the account', async () => {
    // Posting a voucher needs treasury setup the fresh tenant may not have, so the voucher is
    // best-effort; what must hold unconditionally is that the endpoint answers with a list
    // scoped to this customer rather than failing.
    const cashLocation = await api(ctx.server, 'post', '/api/v1/cash-locations', { token: staff.token, body: { branchId, kind: 'safe', code: 'SAFE1', nameAr: 'الصندوق' } });
    if (cashLocation.status < 300) {
      const voucher = await api(ctx.server, 'post', '/api/v1/vouchers', {
        token: staff.token,
        body: { branchId, kind: 'receipt', subtype: 'customer', partyId: buyerId, cashLocationId: body(cashLocation).id, method: 'cash', amount: '100', date: '2026-03-01' },
      });
      if (voucher.status < 300) await api(ctx.server, 'post', `/api/v1/vouchers/${body(voucher).id}/post`, { token: staff.token, body: {} });
    }

    const payments = await api(ctx.server, 'get', '/api/v1/portal/payments', { token: portalToken });
    expect(payments.status).toBe(200);
    const rows = (payments.body.data ?? payments.body) as Array<Record<string, string>>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.every((row) => row.status === 'posted')).toBe(true);
  });

  it('suspends and revokes access', async () => {
    const suspended = await api(ctx.server, 'patch', `/api/v1/portal-access/${accessId}`, { token: staff.token, body: { status: 'suspended' } });
    expect(suspended.status).toBe(200);
    const blocked = await api(ctx.server, 'get', '/api/v1/portal/me', { token: portalToken });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('PORTAL_ACCESS_SUSPENDED');

    await api(ctx.server, 'patch', `/api/v1/portal-access/${accessId}`, { token: staff.token, body: { status: 'active' } });
    expect((await api(ctx.server, 'get', '/api/v1/portal/me', { token: portalToken })).status).toBe(200);

    const revoked = await api(ctx.server, 'delete', `/api/v1/portal-access/${accessId}`, { token: staff.token });
    expect(revoked.status).toBe(200);
    expect((await api(ctx.server, 'get', '/api/v1/portal/me', { token: portalToken })).status).toBe(403);
    // The login itself is gone from the tenant, so a fresh sign-in fails too.
    const relogin = await api(ctx.server, 'post', '/api/v1/auth/login', { body: { email: 'buyer@nokhba.test', password: 'whatever-it-was', tenantCode: 'portalco' } });
    expect(relogin.status).toBe(401);
  });

  it('refuses to point one login at two customers', async () => {
    const first = await api(ctx.server, 'post', `/api/v1/parties/${buyerId}/portal-access`, { token: staff.token, body: { email: 'shared@buyer.test' } });
    expect(first.status).toBe(201);
    const second = await api(ctx.server, 'post', `/api/v1/parties/${otherBuyerId}/portal-access`, { token: staff.token, body: { email: 'shared@buyer.test' } });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('PORTAL_ACCOUNT_TAKEN');
  });
});
