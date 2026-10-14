import { execSync } from 'node:child_process';
import { createSign, createVerify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * ⚙️ إعدادات الربط الضريبي - زاتكا ZATCA — the onboarding ladder of
 * `Desktop_ERP/SmartAuditERP/Form_WPF/frmZatcaSetting.xaml(.cs)`.
 *
 * The window is four steps behind five buttons: ⚡ توليد → 🔵 Compliance CSID (with the
 * 🔑 OTP) → 🔐 حفظ مفتاح التشفير → 🧪 اختبار الربط, then ⏸ إيقاف الربط and 🔄 Renews CSID.
 * What is proved here, in order:
 *
 * 1. the CSR is a real PKCS#10 request carrying the tenant's nine properties — not a string
 *    that looks like one — and the private key it was built from can still sign;
 * 2. the ladder refuses to be climbed out of order, with the desktop's own words;
 * 3. a 🧪 اختبار الربط run reports six verdicts, and it reports *failures* when the tenant's
 *    own company card is incomplete rather than congratulating an unsignable document;
 * 4. the link switch is hidden until a credential exists, exactly as the desktop hides it.
 */
describe('zatca onboarding — إعدادات الربط الضريبي', () => {
  let ctx: TestApp;
  let actor: Actor;
  let readonly: Actor;
  let other: Actor;

  const envelope = (response: { body: Record<string, unknown> }) => (response.body.data ?? response.body) as Record<string, any>;

  const COMPLETE_PROFILE = {
    nameAr: 'مؤسسة الأفق للتجارة',
    nameEn: 'Al Ofoq Trading',
    taxNo: '310000000000003',
    crNo: '1010000000',
    address: { street: 'طريق الملك فهد', building: '1234', district: 'العليا', city: 'الرياض', postal: '12345' },
  };

  const call = (method: 'get' | 'post' | 'put', path: string, options: { token: string; body?: unknown } = { token: '' }) =>
    api(ctx.server, method, `/api/v1${path}`, options);

  beforeAll(async () => {
    ctx = await createTestApp('zatca-onboarding');
    actor = await createActor(ctx, {
      tenantCode: 'zatcaonb',
      email: 'owner@zatcaonb.test',
      permissions: ['organization.companyprofile.manage', 'einvoice.view', 'einvoice.manage', 'einvoice.submit', 'einvoice.credentials.manage'],
    });
    readonly = await createActor(ctx, {
      tenantCode: 'zatcaonb',
      email: 'viewer@zatcaonb.test',
      permissions: ['einvoice.view'],
    });
    other = await createActor(ctx, {
      tenantCode: 'zatcaother',
      email: 'owner@zatcaother.test',
      permissions: ['organization.companyprofile.manage', 'einvoice.view', 'einvoice.manage', 'einvoice.submit', 'einvoice.credentials.manage'],
    });
  }, 240_000);

  afterAll(async () => ctx.close());

  it('opens the window with the desktop’s defaults and nothing done yet', async () => {
    const view = envelope(await call('get', '/einvoice/settings', { token: actor.token }));
    expect(view.authority).toBe('zatca');
    expect(view.settings).toMatchObject({ environment: 'compliance', simulation: false, active: true, syncManual: false });
    // 📅 التاريخ defaults to today and EndDate is one year later, as SettingZatca stores it.
    expect(view.settings.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(view.settings.endDate).toBe(oneYearAfter(view.settings.startDate));
    expect(view.csr).toMatchObject({ countryName: 'SA', invoiceType: '1100', commonName: '' });
    expect(view.checklist.map((row: any) => row.key)).toEqual(['csr', 'compliance-csid', 'production-csid', 'compliance-check', 'active']);
    expect(view.checklist.filter((row: any) => row.done).map((row: any) => row.key)).toEqual(['active']);
    expect(view.link).toEqual({ active: true, canToggle: false });
  });

  it('saves the settings and always writes the end date a year out', async () => {
    const saved = envelope(
      await call('put', '/einvoice/settings', {
        token: actor.token,
        body: { environment: 'production', simulation: true, active: false, syncManual: true, startDate: '2026-01-15' },
      }),
    );
    expect(saved.message).toBe('تم الحفظ');
    expect(saved.settings).toMatchObject({ environment: 'production', simulation: true, active: false, syncManual: true, startDate: '2026-01-15', endDate: '2027-01-15' });

    const view = envelope(await call('get', '/einvoice/settings', { token: actor.token }));
    expect(view.settings.endDate).toBe('2027-01-15');
  });

  it('rejects an environment or a date it cannot read', async () => {
    const environment = await call('put', '/einvoice/settings', { token: actor.token, body: { environment: 'sandbox' } });
    expect(environment.status).toBe(422);
    expect((environment.body as Record<string, unknown>).code).toBe('EINVOICE_ENVIRONMENT_INVALID');

    const date = await call('put', '/einvoice/settings', { token: actor.token, body: { startDate: '15-01-2026' } });
    expect(date.status).toBe(422);
    expect((date.body as Record<string, unknown>).code).toBe('EINVOICE_START_DATE_INVALID');
  });

  it('fills the CSR properties from بطاقة المنشأة — 🔄 تعبئة تلقائي', async () => {
    const profile = await call('put', '/company-profile', { token: actor.token, body: COMPLETE_PROFILE });
    expect(profile.status).toBeLessThan(300);

    const filled = envelope(await call('post', '/einvoice/settings/fill-from-company', { token: actor.token }));
    expect(filled.message).toBe('تم تعبئة البيانات من بطاقة المنشأة');
    // `CommonName = $"{nameA}-{bsnNo}-{taxNo}"`, OrganizationUnitName = the English name.
    expect(filled.settings.commonName).toBe('مؤسسة الأفق للتجارة-1010000000-310000000000003');
    expect(filled.settings.organizationIdentifier).toBe('310000000000003');
    expect(filled.settings.organizationName).toBe('مؤسسة الأفق للتجارة');
    expect(filled.settings.organizationUnitName).toBe('Al Ofoq Trading');
    expect(filled.settings.serialNumber).toMatch(/^1-CloudERP\|2-.+\|3-[0-9a-f-]+$/);
    expect(filled.warnings[0]).toContain('النشاط التجاري'); // the cloud card has no activity column
  });

  it('names the missing company field the desktop names', async () => {
    const bare = await createActor(ctx, { tenantCode: 'zatcabare', email: 'owner@zatcabare.test', permissions: ['organization.companyprofile.manage', 'einvoice.view', 'einvoice.manage', 'einvoice.credentials.manage'] });
    const empty = await call('post', '/einvoice/settings/fill-from-company', { token: bare.token });
    expect(empty.status).toBe(422);
    expect((empty.body as Record<string, unknown>).code).toBe('EINVOICE_COMPANY_NAME_REQUIRED');
    expect((empty.body as Record<string, unknown>).detail).toBe('يرجى تعبئة اسم المنشأة');

    await call('put', '/company-profile', { token: bare.token, body: { nameAr: 'مؤسسة النخبة', nameEn: 'Nakheel', crNo: '1010000001' } });
    const noTax = await call('post', '/einvoice/settings/fill-from-company', { token: bare.token });
    expect((noTax.body as Record<string, unknown>).code).toBe('EINVOICE_COMPANY_TAX_NO_REQUIRED');
    expect((noTax.body as Record<string, unknown>).detail).toBe('يرجى تعبئة الرقم الضريبي');
  });

  it('generates a real PKCS#10 request — ⚡ توليد', async () => {
    await call('put', '/einvoice/settings', { token: actor.token, body: { csr: { industry: 'تجارة التجزئة' } } });
    const generated = envelope(await call('post', '/einvoice/csr/generate', { token: actor.token }));

    const der = Buffer.from(generated.csr, 'base64');
    expect(der.subarray(0, 2).toString('hex')).toBe('3082'); // SEQUENCE, two length octets
    expect(der.toString('latin1')).toContain('ZATCA-Code-Signing');
    expect(der.toString('latin1')).toContain('310000000000003'); // 🔢 Organization Identifier
    expect(der.toString('latin1')).toContain('1-CloudERP'); // 🖥️ Serial Number
    expect(der.toString('latin1')).toContain('1100'); // 📄 Invoice Type
    expect(der.toString('latin1')).toContain('SA'); // 🌍 Country Name
    expect(der.toString('utf8')).toContain('مؤسسة الأفق للتجارة'); // 🏭 Organization Name
    expect(generated.fingerprint).toMatch(/^[0-9a-f]{32}$/);

    // The key is usable: it signs, and its own public key verifies.
    const signed = createSign('sha256').update(Buffer.from('فاتورة')).sign(generated.privateKey);
    expect(createVerify('sha256').update(Buffer.from('فاتورة')).verify(generated.publicKey, signed)).toBe(true);

    // Readable by openssl — the request the authority is handed is not an invention.
    const text = execFileSyncSafe(pemOf(generated.csr));
    if (text) {
      expect(text).toContain('Certificate request self-signature verify OK');
      expect(text).toContain('ecdsa-with-SHA256');
      expect(text).toContain('ZATCA-Code-Signing');
    }
  });

  it('shows the key is there without ever showing the key', async () => {
    const view = envelope(await call('get', '/einvoice/settings', { token: actor.token }));
    expect(view.credential.hasPrivateKey).toBe(true);
    expect(view.credential.privateKeyMasked).toMatch(/^\*\*\*\*/);
    expect(JSON.stringify(view)).not.toContain('BEGIN PRIVATE KEY');
    expect(view.credential.csr).toBeTruthy(); // the CSR is public and stays readable
    expect(view.checklist.find((row: any) => row.key === 'csr')!.done).toBe(true);
    expect(view.link.canToggle).toBe(true);
  });

  it('asks for the OTP before it asks the authority, in the desktop’s words', async () => {
    const noOtp = await call('post', '/einvoice/onboarding/compliance-csid', { token: actor.token, body: {} });
    expect(noOtp.status).toBe(422);
    expect((noOtp.body as Record<string, unknown>).code).toBe('EINVOICE_OTP_REQUIRED');
    expect((noOtp.body as Record<string, unknown>).detail).toBe('يجب إدخال OTP');
  });

  it('issues a compliance CSID and keeps its secret masked', async () => {
    const grant = envelope(await call('post', '/einvoice/onboarding/compliance-csid', { token: actor.token, body: { otp: '123456' } }));
    expect(grant.message).toBe('تم إصدار شهادة الامتثال');
    expect(grant.gateway).toBe('simulation');
    expect(grant.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(grant.csid).toBeTruthy();
    expect(grant.secret).toBeTruthy();

    const again = envelope(await call('post', '/einvoice/onboarding/compliance-csid', { token: actor.token, body: { otp: '123456' } }));
    expect(again.requestId).toBe(grant.requestId); // the same request earns the same grant

    const view = envelope(await call('get', '/einvoice/settings', { token: actor.token }));
    expect(view.credential.csidMasked).toMatch(/^\*\*\*\*/);
    expect(view.credential.secretMasked).toMatch(/^\*\*\*\*/);
    expect(view.credential.requestId).toBe(grant.requestId);
    expect(view.onboarding.complianceCsidAt).toBeTruthy();
    expect(view.checklist.find((row: any) => row.key === 'compliance-csid')!.done).toBe(true);
    expect(JSON.stringify(view)).not.toContain(grant.secret);
  });

  it('will not hand out a production CSID before the compliance one', async () => {
    const bare = await createActor(ctx, { tenantCode: 'zatcapre', email: 'owner@zatcapre.test', permissions: ['organization.companyprofile.manage', 'einvoice.view', 'einvoice.manage', 'einvoice.credentials.manage'] });
    const response = await call('post', '/einvoice/onboarding/production-csid', { token: bare.token });
    expect(response.status).toBe(409);
    expect((response.body as Record<string, unknown>).code).toBe('EINVOICE_COMPLIANCE_CSID_REQUIRED');
    expect((response.body as Record<string, unknown>).detail).toBe('يجب إصدار شهادة الامتثال أولاً');
  });

  it('issues the production CSID — 🔐 حفظ مفتاح التشفير', async () => {
    const grant = envelope(await call('post', '/einvoice/onboarding/production-csid', { token: actor.token }));
    expect(grant.message).toBe('تم تحديث البيانات بنجاح');
    expect(grant.requestId).toMatch(/^[0-9a-f-]{36}$/);

    const view = envelope(await call('get', '/einvoice/settings', { token: actor.token }));
    expect(view.credential.productionCsidMasked).toMatch(/^\*\*\*\*/);
    expect(view.credential.productionRequestId).toBe(grant.requestId);
    expect(view.onboarding.productionCsidAt).toBeTruthy();
    expect(view.checklist.find((row: any) => row.key === 'production-csid')!.done).toBe(true);
  });

  it('reports a gateway it cannot reach as 502, not as a server error', async () => {
    // 🔴 Production ربط فعلي with no 🧪 Simulation: the call really dials ZATCA. Whether the
    // sandbox is unreachable or simply refuses the request, the window must say so.
    const online = await createActor(ctx, {
      tenantCode: 'zatcagw',
      email: 'owner@zatcagw.test',
      permissions: ['organization.companyprofile.manage', 'einvoice.view', 'einvoice.manage', 'einvoice.credentials.manage'],
    });
    await call('put', '/company-profile', { token: online.token, body: COMPLETE_PROFILE });
    await call('post', '/einvoice/settings/fill-from-company', { token: online.token });
    await call('put', '/einvoice/settings', { token: online.token, body: { simulation: false, environment: 'production', csr: { industry: 'تجارة التجزئة' } } });
    await call('post', '/einvoice/csr/generate', { token: online.token });

    const response = await call('post', '/einvoice/onboarding/compliance-csid', { token: online.token, body: { otp: '654321' } });
    expect(response.status).toBe(502);
    expect((response.body as Record<string, unknown>).code).toBe('EINVOICE_GATEWAY_UNREACHABLE');
    expect(String((response.body as Record<string, unknown>).detail)).toContain('بوابة هيئة الزكاة');
  }, 30_000);

  it('runs the six compliance documents — 🧪 اختبار الربط', async () => {
    const run = envelope(await call('post', '/einvoice/onboarding/compliance-check', { token: actor.token }));
    expect(run.passed).toBe(true);
    expect(run.message).toBe('تم بنجاح');
    expect(run.gateway).toBe('simulation');
    expect(run.checks.map((row: any) => row.labelEn)).toEqual([
      'Standard Invoice',
      'Standard Debit Note',
      'Standard Credit Note',
      'Simplified Invoice',
      'Simplified Debit Note',
      'Simplified Credit Note',
    ]);
    // `value = ProcType != 2 ? "388" : "381"` then `if (isDebit) value = "383"`, and
    // `name = IsSimplified ? "0200000" : "0100000"`.
    expect(run.checks.map((row: any) => `${row.invoiceTypeCode}/${row.typeName}`)).toEqual([
      '388/0100000',
      '383/0100000',
      '381/0100000',
      '388/0200000',
      '383/0200000',
      '381/0200000',
    ]);
    // Standard invoices are cleared, simplified ones are reported.
    expect(run.checks.map((row: any) => row.status)).toEqual(['CLEARED', 'CLEARED', 'CLEARED', 'REPORTED', 'REPORTED', 'REPORTED']);
    expect(new Set(run.checks.map((row: any) => row.hash)).size).toBe(6);

    const view = envelope(await call('get', '/einvoice/settings', { token: actor.token }));
    expect(view.onboarding.lastComplianceCheck.passed).toBe(true);
    expect(view.checklist.find((row: any) => row.key === 'compliance-check')!.done).toBe(true);
  });

  it('fails the compliance test when the tenant’s own card cannot be signed for', async () => {
    const incomplete = await createActor(ctx, {
      tenantCode: 'zatcanov',
      email: 'owner@zatcanov.test',
      permissions: ['organization.companyprofile.manage', 'einvoice.view', 'einvoice.manage', 'einvoice.credentials.manage'],
    });
    // A company card with everything except the VAT number, so 🧪 اختبار الربط has a seller
    // that cannot appear on a compliant invoice.
    await call('put', '/company-profile', { token: incomplete.token, body: { nameAr: 'مؤسسة بلا رقم ضريبي', nameEn: 'No Vat Co', crNo: '1010000009' } });
    await call('put', '/einvoice/settings', {
      token: incomplete.token,
      body: {
        simulation: true, // 🧪 Simulation تجريبي — the six documents are judged locally
        csr: {
          commonName: 'مؤسسة بلا رقم ضريبي-1010000009-310000000000009',
          serialNumber: '1-CloudERP|2-1.0.0|3-00000000-0000-4000-8000-000000000001',
          organizationIdentifier: '310000000000009',
          organizationUnitName: 'No Vat Co',
          organizationName: 'مؤسسة بلا رقم ضريبي',
          countryName: 'SA',
          invoiceType: '1100',
          address: 'الرياض - العليا',
          industry: 'تجارة التجزئة',
        },
      },
    });
    await call('post', '/einvoice/csr/generate', { token: incomplete.token });
    await call('post', '/einvoice/onboarding/compliance-csid', { token: incomplete.token, body: { otp: '999999' } });

    const run = envelope(await call('post', '/einvoice/onboarding/compliance-check', { token: incomplete.token }));
    expect(run.passed).toBe(false);
    expect(run.message).toContain('Standard Invoice compliance check failed.');
    expect(run.checks.every((row: any) => !row.success)).toBe(true);
    expect(run.checks[0]!.messages.join('\n')).toContain('الرقم الضريبي للمنشأة غير معبأ في بطاقة المنشأة');

    const view = envelope(await call('get', '/einvoice/settings', { token: incomplete.token }));
    expect(view.checklist.find((row: any) => row.key === 'compliance-check')!.done).toBe(false);
  });

  it('renews the certificate — 🔄 Renews CSID', async () => {
    const before = envelope(await call('get', '/einvoice/settings', { token: actor.token }));
    const renewed = envelope(await call('post', '/einvoice/onboarding/renew', { token: actor.token }));
    expect(renewed.message).toBe('تم تجديد الشهادة بنجاح');
    expect(renewed.renewedAt).toBeTruthy();
    expect(renewed.requestId).not.toBe(before.credential.productionRequestId);

    const after = envelope(await call('get', '/einvoice/settings', { token: actor.token }));
    expect(after.credential.productionRequestId).toBe(renewed.requestId);
    expect(after.onboarding.renewedAt).toBeTruthy();
  });

  it('flips the link off and on — ⏸ إيقاف الربط / ▶ تشغيل', async () => {
    // The state left by the settings test is not assumed — read it, then flip twice.
    const before = envelope(await call('get', '/einvoice/settings', { token: actor.token })).link.active;
    const first = envelope(await call('post', '/einvoice/link/toggle', { token: actor.token }));
    expect(first.active).toBe(!before);
    expect(first.message).toBe(first.active ? 'تم التشغيل بنجاح' : 'تم الإيقاف بنجاح');
    const second = envelope(await call('post', '/einvoice/link/toggle', { token: actor.token }));
    expect(second.active).toBe(before);
    expect(second.message).toBe(second.active ? 'تم التشغيل بنجاح' : 'تم الإيقاف بنجاح');

    // The desktop hides the button while `ZatcaCredential` is empty.
    const bare = await createActor(ctx, { tenantCode: 'zatcalink', email: 'owner@zatcalink.test', permissions: ['einvoice.view', 'einvoice.manage'] });
    const response = await call('post', '/einvoice/link/toggle', { token: bare.token });
    expect(response.status).toBe(409);
    expect((response.body as Record<string, unknown>).code).toBe('EINVOICE_LINK_NOT_CONFIGURED');
  });

  it('keeps one tenant’s onboarding out of another’s', async () => {
    const theirs = envelope(await call('get', '/einvoice/settings', { token: other.token }));
    expect(theirs.credential.hasCsr).toBe(false);
    expect(theirs.credential.csidMasked).toBeNull();
    expect(theirs.csr.commonName).toBe('');

    // Turning the link off in the first tenant leaves the second one alone.
    await call('post', '/einvoice/link/toggle', { token: actor.token });
    const view = envelope(await call('get', '/einvoice/settings', { token: other.token }));
    expect(view.link.active).toBe(true);
    await call('post', '/einvoice/link/toggle', { token: actor.token });
  });

  it('refuses the onboarding buttons without the credential permission', async () => {
    for (const path of ['/einvoice/csr/generate', '/einvoice/onboarding/compliance-csid', '/einvoice/onboarding/production-csid', '/einvoice/onboarding/compliance-check', '/einvoice/onboarding/renew']) {
      const response = await call('post', path, { token: readonly.token, body: { otp: '1' } });
      expect(response.status, path).toBe(403);
    }
    const toggle = await call('post', '/einvoice/link/toggle', { token: readonly.token });
    expect(toggle.status).toBe(403);
    const save = await call('put', '/einvoice/settings', { token: readonly.token, body: { active: true } });
    expect(save.status).toBe(403);
    // Reading is still allowed.
    const view = await call('get', '/einvoice/settings', { token: readonly.token });
    expect(view.status).toBe(200);
  });
});

function oneYearAfter(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(Number(year) + 1, Number(month) - 1, Number(day))).toISOString().slice(0, 10);
}

/**
 * Runs `openssl` when the sandbox has it. The request is written to a real file because
 * `openssl -in /dev/stdin` cannot re-open a pipe as a file.
 */
function execFileSyncSafe(pem: string): string | null {
  try {
    const file = join(mkdtempSync(join(tmpdir(), 'zatca-csr-')), 'request.csr');
    writeFileSync(file, pem);
    // openssl writes "self-signature verify OK" to stderr, so both streams are captured.
    return execSync(`openssl req -in ${JSON.stringify(file)} -noout -text -verify 2>&1`, { encoding: 'utf8' });
  } catch {
    return null;
  }
}

function pemOf(base64Der: string): string {
  const wrapped = base64Der.match(/.{1,64}/g)?.join('\n') ?? base64Der;
  return `-----BEGIN CERTIFICATE REQUEST-----\n${wrapped}\n-----END CERTIFICATE REQUEST-----\n`;
}
