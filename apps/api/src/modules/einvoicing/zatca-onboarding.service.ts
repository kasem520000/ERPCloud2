import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DomainError, newId } from '@erp/contracts';
import { companyProfiles, einvoiceCredentials, einvoiceSettings, withTenantTx, type DatabaseHandle, type DrizzleTx } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';

import { decryptSecret, encryptSecret } from './einvoicing.service.js';
import { buildComplianceDocuments, failureLine, rowOf, type ComplianceCheckRow } from './zatca/compliance-check.js';
import { defaultSerialNumber, generateCsr, type CsrProperties } from './zatca/csr.js';
import { resolveGateway, type ZatcaGateway } from './zatca/gateway.js';

/**
 * «⚙️ إعدادات الربط الضريبي - زاتكا ZATCA» — the window, the onboarding ladder behind it and
 * the link switch, ported from
 * `Desktop_ERP/SmartAuditERP/Form_WPF/frmZatcaSetting.xaml` (472 lines) and
 * `.xaml.cs` (1160 lines).
 *
 * The desktop keeps three singleton rows — `SettingZatca`, `CSRProperties` and
 * `ZatcaCredential` — and its 💾 حفظ الإعدادات button does four things in order
 * (L193-L196): `Generate()` → `SaveCSR()` → `ComplianceCSID()` → write the three rows. Here
 * those four steps are four endpoints so each one can fail on its own and be retried, and
 * the window shows a checklist instead of a message box:
 *
 * 1. ⚡ توليد — Generate            → `POST /einvoice/csr/generate`
 * 2. 🔵 Compliance CSID             → `POST /einvoice/onboarding/compliance-csid` (needs 🔑 OTP)
 * 3. 🔐 حفظ مفتاح التشفير — Get PCSID → `POST /einvoice/onboarding/production-csid`
 * 4. 🧪 اختبار الربط — Test Compliance → `POST /einvoice/onboarding/compliance-check`
 *
 * then ⏸ إيقاف الربط / ▶ تشغيل flips the link, and 🔄 Renews CSID renews the certificate.
 *
 * Two behaviours are carried over deliberately because getting them wrong is worse than
 * being inconvenient:
 *
 * • A new CSR **invalidates** any CSID issued for the old one, because the certificate is
 *   bound to the key that requested it. The desktop does this by deleting and re-inserting
 *   `ZatcaCredential` on every `SaveCSR()` (L511-L514); we clear the two CSID pairs and say
 *   so in the response.
 * • ⏸ إيقاف الربط is hidden by the desktop until a credential row exists
 *   (`GetzatcaOnproduction`, L1048-L1062) — you cannot switch off a link that was never
 *   configured.
 */

export type CsrPropertiesInput = Partial<CsrProperties>;

/**
 * What one filing is filed with — the answer to «which gateway, and as which taxpayer?».
 *
 * `csid`/`secret` are decrypted here and handed over in memory only; they are never written
 * to a submission row, a log line or a response.
 */
export type FilingContext = {
  settings: typeof einvoiceSettings.$inferSelect;
  credential: typeof einvoiceCredentials.$inferSelect | null;
  /** The credential row's environment: 🧪 `simulation` or 🔴 `production`. */
  environment: string;
  gateway: ZatcaGateway;
  /** The private key that pairs with the CSR — `null` when the tenant has not generated one. */
  privateKey: string | null;
  csid: string | null;
  secret: string | null;
  /** `production` when the production CSID was used, `compliance` while it does not exist yet. */
  credentialKind: 'production' | 'compliance';
};

export type SettingsInput = {
  /** 🔵 Compliance تجريبي · 🔴 Production ربط فعلي */
  environment?: 'compliance' | 'production';
  /** 🧪 Simulation تجريبي */
  simulation?: boolean;
  /** ✅ تمكين Activate */
  active?: boolean;
  /** Sync manual */
  syncManual?: boolean;
  /** 📅 التاريخ — `YYYY-MM-DD`. The end date is always one year later. */
  startDate?: string;
  /** 📋 خصائص شهادة CSR */
  csr?: CsrPropertiesInput;
};

const CSR_FIELDS: Array<{ key: keyof CsrProperties; labelAr: string }> = [
  { key: 'commonName', labelAr: '🏢 Common Name (اسم المنشأة)' },
  { key: 'serialNumber', labelAr: '🖥️ Serial Number (سريال الجهاز)' },
  { key: 'organizationIdentifier', labelAr: '🔢 Organization Identifier (الرقم الضريبي)' },
  { key: 'organizationUnitName', labelAr: '🏬 Organization Unit (اسم الفرع)' },
  { key: 'organizationName', labelAr: '🏭 Organization Name (اسم المنشأة)' },
  { key: 'countryName', labelAr: '🌍 Country Name (الدولة)' },
  { key: 'invoiceType', labelAr: '📄 Invoice Type (نوع الفواتير)' },
  { key: 'address', labelAr: '📍 Address (العنوان المختصر)' },
  { key: 'industry', labelAr: '🏗️ Industry (النشاط التجاري)' },
];

const CHECKLIST: Array<{ key: string; labelAr: string }> = [
  { key: 'csr', labelAr: '⚡ توليد شهادة CSR' },
  { key: 'compliance-csid', labelAr: '🔵 شهادة الامتثال (Compliance CSID)' },
  { key: 'production-csid', labelAr: '🔐 مفتاح التشفير (Production CSID)' },
  { key: 'compliance-check', labelAr: '🧪 اختبار الربط' },
  { key: 'active', labelAr: '✅ تمكين الربط' },
];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function clean(value: unknown, fallback = ''): string {
  return String(value ?? '').trim() || fallback;
}

/** 📅 التاريخ + 1 year — `SettingZatca.EndDate = StartDate.AddYears(1)` (L248-L249). */
function endDateOf(startDate: string): string {
  const [year, month, day] = startDate.split('-').map(Number);
  const end = new Date(Date.UTC(Number(year) + 1, Number(month) - 1, Number(day)));
  return end.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function mask(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const plain = decryptSecret(value);
    return `****${plain.slice(-4)}`;
  } catch {
    return '****';
  }
}

/** A secret that cannot be decrypted is treated as absent, not as a reason to fail. */
function safeDecrypt(value: string): string | null {
  try {
    return decryptSecret(value);
  } catch {
    return null;
  }
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return Array.isArray(result) ? (result as Array<Record<string, unknown>>) : ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []);
}

@Injectable()
export class ZatcaOnboardingService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  // ── Read ─────────────────────────────────────────────────────────────────────────────

  /** The whole window in one call: settings, CSR properties, masked credentials, checklist. */
  async view(tenantId: string, authority = 'zatca') {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const settings = await this.settingsFor(tx, tenantId, authority);
      const credential = await this.credentialFor(tx, tenantId, authority, this.environmentOf(settings));
      return this.composeView(settings, credential);
    });
  }

  // ── 💾 حفظ الإعدادات — Save Settings ──────────────────────────────────────────────────

  async saveSettings(tenantId: string, input: SettingsInput, authority = 'zatca') {
    if (input.environment && input.environment !== 'compliance' && input.environment !== 'production') {
      throw new DomainError('EINVOICE_ENVIRONMENT_INVALID', 'بيئة الربط يجب أن تكون compliance أو production', 422);
    }
    if (input.startDate !== undefined && !DATE_PATTERN.test(input.startDate)) {
      throw new DomainError('EINVOICE_START_DATE_INVALID', 'التاريخ يجب أن يكون بصيغة YYYY-MM-DD', 422);
    }

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const current = await this.settingsFor(tx, tenantId, authority);
      const startDate = input.startDate ?? current.startDate;
      const merged = {
        environment: input.environment ?? current.environment,
        simulation: input.simulation ?? current.simulation,
        active: input.active ?? current.active,
        syncManual: input.syncManual ?? current.syncManual,
        startDate,
        endDate: endDateOf(startDate),
        commonName: input.csr?.commonName !== undefined ? clean(input.csr.commonName) : current.commonName,
        serialNumber: input.csr?.serialNumber !== undefined ? clean(input.csr.serialNumber) : current.serialNumber,
        organizationIdentifier: input.csr?.organizationIdentifier !== undefined ? clean(input.csr.organizationIdentifier) : current.organizationIdentifier,
        organizationUnitName: input.csr?.organizationUnitName !== undefined ? clean(input.csr.organizationUnitName) : current.organizationUnitName,
        organizationName: input.csr?.organizationName !== undefined ? clean(input.csr.organizationName) : current.organizationName,
        countryName: input.csr?.countryName !== undefined ? clean(input.csr.countryName, 'SA') : current.countryName,
        invoiceType: input.csr?.invoiceType !== undefined ? clean(input.csr.invoiceType, '1100') : current.invoiceType,
        address: input.csr?.address !== undefined ? clean(input.csr.address) : current.address,
        industry: input.csr?.industry !== undefined ? clean(input.csr.industry) : current.industry,
      };

      const [row] = await tx
        .insert(einvoiceSettings)
        .values({ id: newId(), tenantId, authority, ...merged, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [einvoiceSettings.tenantId, einvoiceSettings.authority],
          set: { ...merged, updatedAt: new Date() },
        })
        .returning();
      if (!row) throw new DomainError('EINVOICE_SETTINGS_SAVE_FAILED', 'تعذّر حفظ إعدادات الربط', 500);
      return { settings: row, message: 'تم الحفظ' };
    });
  }

  // ── 🔄 تعبئة تلقائي ──────────────────────────────────────────────────────────────────

  /**
   * Fills the CSR properties from the company card — `GetFoundation()`
   * (`frmZatcaSetting.xaml.cs` L955-L1010), which reads one `Foundation` row and complains
   * field by field: «يرجى تعبئة اسم المنشأة», «يرجى تعبئة الرقم الضريبي»,
   * «يرجى تعبئة السجل التجاري», «يرجى تعبئة النشاط التجاري»,
   * «يرجى تعبئة اسم المنشأة انجليزي». The same five checks run here against
   * `company_profiles`, in the same order, with the same words.
   *
   * 🏗️ Industry is the one that cannot be filled: the desktop reads `Foundation.FieldA` and
   * the cloud company card has no activity column. Rather than invent one it is reported as
   * a warning and left as it was.
   */
  async fillFromCompany(tenantId: string, authority = 'zatca') {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [profile] = await tx.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenantId));
      const nameAr = profile?.nameAr ? String(profile.nameAr) : '';
      const taxNo = profile?.taxNo ? String(profile.taxNo) : '';
      const crNo = profile?.crNo ? String(profile.crNo) : '';
      const nameEn = profile?.nameEn ? String(profile.nameEn) : '';

      if (!nameAr) throw new DomainError('EINVOICE_COMPANY_NAME_REQUIRED', 'يرجى تعبئة اسم المنشأة', 422);
      if (!taxNo) throw new DomainError('EINVOICE_COMPANY_TAX_NO_REQUIRED', 'يرجى تعبئة الرقم الضريبي', 422);
      if (!crNo) throw new DomainError('EINVOICE_COMPANY_CR_NO_REQUIRED', 'يرجى تعبئة السجل التجاري', 422);
      if (!nameEn) throw new DomainError('EINVOICE_COMPANY_NAME_EN_REQUIRED', 'يرجى تعبئة اسم المنشأة انجليزي', 422);

      const address = (profile?.address ?? {}) as Record<string, string | undefined>;
      const shortAddress = [address.street, address.district, address.city].filter(Boolean).join(' - ');
      const current = await this.settingsFor(tx, tenantId, authority);
      const startDate = today();

      const [row] = await tx
        .insert(einvoiceSettings)
        .values({
          id: newId(),
          tenantId,
          authority,
          environment: current.environment,
          simulation: current.simulation,
          active: current.active,
          syncManual: current.syncManual,
          startDate,
          endDate: endDateOf(startDate),
          commonName: `${nameAr}-${crNo}-${taxNo}`,
          serialNumber: current.serialNumber || defaultSerialNumber(),
          organizationIdentifier: taxNo,
          organizationUnitName: nameEn,
          organizationName: nameAr,
          countryName: profile?.countryCode ? String(profile.countryCode) : current.countryName || 'SA',
          invoiceType: current.invoiceType || '1100',
          address: shortAddress,
          industry: current.industry,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [einvoiceSettings.tenantId, einvoiceSettings.authority],
          set: {
            startDate,
            endDate: endDateOf(startDate),
            commonName: `${nameAr}-${crNo}-${taxNo}`,
            serialNumber: current.serialNumber || defaultSerialNumber(),
            organizationIdentifier: taxNo,
            organizationUnitName: nameEn,
            organizationName: nameAr,
            countryName: profile?.countryCode ? String(profile.countryCode) : current.countryName || 'SA',
            address: shortAddress,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!row) throw new DomainError('EINVOICE_SETTINGS_SAVE_FAILED', 'تعذّر تعبئة خصائص الشهادة', 500);

      return {
        settings: row,
        warnings: row.industry ? [] : ['يرجى تعبئة النشاط التجاري — بطاقة المنشأة في السحابة لا تحوي حقلاً له'],
        message: 'تم تعبئة البيانات من بطاقة المنشأة',
      };
    });
  }

  // ── ⚡ توليد — Generate ───────────────────────────────────────────────────────────────

  /**
   * Generates the key pair and the PKCS#10 request. The private key is returned **once** —
   * it is stored encrypted and every later read shows `****` plus its last four characters,
   * which is what «🔐 حفظ مفتاح التشفير» implies and what the desktop's hidden
   * `txtPrivateKey` only pretended to hide.
   */
  async generateCsr(tenantId: string, authority = 'zatca') {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const settings = await this.settingsFor(tx, tenantId, authority);
      const properties = this.csrPropertiesOf(settings);
      for (const field of CSR_FIELDS) {
        if (!properties[field.key]) throw new DomainError('EINVOICE_CSR_PROPERTY_MISSING', `يرجى تعبئة ${field.labelAr}`, 422);
      }

      const generated = generateCsr(properties);
      const environment = this.environmentOf(settings);
      const now = new Date();

      // A CSID certifies *this* key. Keeping the old one would let the system sign with a
      // key the certificate was never issued for, so both pairs go — the desktop does the
      // same thing with `DELETE FROM ZatcaCredential` (L511).
      const [credential] = await tx
        .insert(einvoiceCredentials)
        .values({
          id: newId(),
          tenantId,
          authority,
          environment,
          csr: generated.csr,
          privateKeyEnc: encryptSecret(generated.privateKey),
          csidEnc: null,
          secretEnc: null,
          requestId: null,
          productionCsidEnc: null,
          productionSecretEnc: null,
          productionRequestId: null,
          org: {},
          validFrom: now,
          validTo: new Date(`${settings.endDate}T00:00:00.000Z`),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [einvoiceCredentials.tenantId, einvoiceCredentials.authority, einvoiceCredentials.environment],
          set: {
            csr: generated.csr,
            privateKeyEnc: encryptSecret(generated.privateKey),
            csidEnc: null,
            secretEnc: null,
            requestId: null,
            productionCsidEnc: null,
            productionSecretEnc: null,
            productionRequestId: null,
            validFrom: now,
            validTo: new Date(`${settings.endDate}T00:00:00.000Z`),
            updatedAt: now,
          },
        })
        .returning();

      await tx
        .update(einvoiceSettings)
        .set({ serialNumber: generated.serialNumber, csrGeneratedAt: now, complianceCsidAt: null, productionCsidAt: null, complianceCheckedAt: null, lastComplianceCheck: null, updatedAt: now })
        .where(and(eq(einvoiceSettings.tenantId, tenantId), eq(einvoiceSettings.authority, authority)));

      return {
        csr: generated.csr,
        privateKey: generated.privateKey,
        publicKey: generated.publicKey,
        serialNumber: generated.serialNumber,
        fingerprint: generated.fingerprint,
        revokedCredentials: Boolean(credential),
        message: 'تم توليد الشهادة — يجب إصدار شهادة امتثال جديدة',
      };
    });
  }

  // ── 🔵 Compliance CSID ────────────────────────────────────────────────────────────────

  /** «يجب إدخال OTP» then «يجب عليك إنشاء CSR أولاً!» — the desktop's two gates, in order. */
  async requestComplianceCsid(tenantId: string, input: { otp?: string }, authority = 'zatca') {
    const otp = clean(input.otp);
    if (!otp) throw new DomainError('EINVOICE_OTP_REQUIRED', 'يجب إدخال OTP', 422);

    const context = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const settings = await this.settingsFor(tx, tenantId, authority);
      const credential = await this.credentialFor(tx, tenantId, authority, this.environmentOf(settings));
      if (!credential?.csr) throw new DomainError('EINVOICE_CSR_REQUIRED', 'يجب عليك إنشاء CSR أولاً!', 409);
      return { settings, credential };
    });

    const gateway = this.gatewayFor(context.settings);
    const grant = await this.callGateway(() => gateway.complianceCsr({ otp, csr: context.credential.csr! }));

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const now = new Date();
      const [row] = await tx
        .update(einvoiceCredentials)
        .set({ csidEnc: encryptSecret(grant.csid), secretEnc: encryptSecret(grant.secret), requestId: grant.requestId, updatedAt: now })
        .where(and(eq(einvoiceCredentials.tenantId, tenantId), eq(einvoiceCredentials.authority, authority), eq(einvoiceCredentials.environment, context.credential!.environment)))
        .returning();
      await tx
        .update(einvoiceSettings)
        .set({ complianceCsidAt: now, updatedAt: now })
        .where(and(eq(einvoiceSettings.tenantId, tenantId), eq(einvoiceSettings.authority, authority)));
      return {
        requestId: grant.requestId,
        csid: grant.csid,
        secret: grant.secret,
        gateway: gateway.kind,
        environment: context.credential!.environment,
        updatedAt: row?.updatedAt ?? now,
        message: 'تم إصدار شهادة الامتثال',
      };
    });
  }

  // ── 🔐 حفظ مفتاح التشفير — Get PCSID ──────────────────────────────────────────────────

  /**
   * The desktop passes `ToBase64Encode(cred.CSID)`, `cred.RequestID` and `cred.Secret`
   * (`frmZatcaSetting.xaml.cs` L325-L329) — the compliance grant is the credential for the
   * production one, so a tenant that skipped step 2 has nothing to send.
   */
  async requestProductionCsid(tenantId: string, authority = 'zatca', options: { renew?: boolean } = {}) {
    const context = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const settings = await this.settingsFor(tx, tenantId, authority);
      const credential = await this.credentialFor(tx, tenantId, authority, this.environmentOf(settings));
      if (!credential?.requestId || !credential.csidEnc || !credential.secretEnc) {
        throw new DomainError('EINVOICE_COMPLIANCE_CSID_REQUIRED', 'يجب إصدار شهادة الامتثال أولاً', 409);
      }
      return { settings, requestId: credential.requestId, csidEnc: credential.csidEnc, secretEnc: credential.secretEnc, environment: credential.environment };
    });

    const gateway = this.gatewayFor(context.settings);
    const grant = await this.callGateway(() => gateway.productionCsr({
      complianceRequestId: context.requestId,
      csid: decryptSecret(context.csidEnc),
      secret: decryptSecret(context.secretEnc),
      renew: options.renew,
    }));

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const now = new Date();
      const [row] = await tx
        .update(einvoiceCredentials)
        .set({
          productionCsidEnc: encryptSecret(grant.csid),
          productionSecretEnc: encryptSecret(grant.secret),
          productionRequestId: grant.requestId,
          updatedAt: now,
        })
        .where(and(eq(einvoiceCredentials.tenantId, tenantId), eq(einvoiceCredentials.authority, authority), eq(einvoiceCredentials.environment, context.environment)))
        .returning();
      await tx
        .update(einvoiceSettings)
        .set({ productionCsidAt: now, ...(options.renew ? { renewedAt: now } : {}), updatedAt: now })
        .where(and(eq(einvoiceSettings.tenantId, tenantId), eq(einvoiceSettings.authority, authority)));
      return {
        requestId: grant.requestId,
        csid: grant.csid,
        secret: grant.secret,
        gateway: gateway.kind,
        environment: context.environment,
        renewedAt: options.renew ? now : undefined,
        updatedAt: row?.updatedAt ?? now,
        message: options.renew ? 'تم تجديد الشهادة بنجاح' : 'تم تحديث البيانات بنجاح',
      };
    });
  }

  /** 🔄 Renews CSID — تجديد الشهادة بعد 5 سنوات. The desktop left a message box here; this renews. */
  async renewCsid(tenantId: string, authority = 'zatca') {
    return this.requestProductionCsid(tenantId, authority, { renew: true });
  }

  // ── 🧪 اختبار الربط — Test Compliance ─────────────────────────────────────────────────

  /**
   * Builds the six sample documents, validates each one, and asks the gateway about each.
   *
   * The desktop stops at the first failure and shows
   * `"{name} compliance check failed.\n{validationResults}"`; this runs all six — a taxpayer
   * fixing their seller card wants to see all six verdicts at once — and returns the same
   * per-check words in `message` when one fails.
   */
  async complianceCheck(tenantId: string, authority = 'zatca') {
    const context = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const settings = await this.settingsFor(tx, tenantId, authority);
      const credential = await this.credentialFor(tx, tenantId, authority, this.environmentOf(settings));
      if (!credential?.csidEnc || !credential.secretEnc || !credential.csr) {
        throw new DomainError('EINVOICE_CSR_REQUIRED', 'يجب عليك إنشاء CSR أولاً!', 409);
      }
      const seller = await this.sellerParty(tx, tenantId);
      return { settings, credential, seller };
    });

    const gateway = this.gatewayFor(context.settings);
    // The compliance pair is what the desktop sends (L900-L903); the production pair is
    // accepted too, so a tenant that finished onboarding can re-test against production.
    const csid = decryptSecret(context.credential.productionCsidEnc ?? context.credential.csidEnc!);
    const secret = decryptSecret(context.credential.productionSecretEnc ?? context.credential.secretEnc!);

    const documents = buildComplianceDocuments(context.seller, 1);
    const checks: ComplianceCheckRow[] = [];
    for (const document of documents) {
      const verdict = await this.callGateway(() =>
        gateway.complianceInvoice({
          csid,
          secret,
          invoiceHash: document.hash,
          uuid: document.uuid,
          invoice: Buffer.from(document.xml, 'utf8').toString('base64'),
          clearance: document.expectation.clearance,
          findings: document.findings,
        }),
      );
      checks.push(rowOf(document, verdict));
    }

    const passed = checks.every((check) => check.success);
    const failed = checks.find((check) => !check.success);
    const now = new Date();

    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await tx
        .update(einvoiceSettings)
        .set({ complianceCheckedAt: now, lastComplianceCheck: { passed, checkedAt: now.toISOString(), checks }, updatedAt: now })
        .where(and(eq(einvoiceSettings.tenantId, tenantId), eq(einvoiceSettings.authority, authority)));
    });

    return {
      passed,
      checkedAt: now,
      gateway: gateway.kind,
      checks,
      message: passed ? 'تم بنجاح' : `${failureLine(failed!)}\n${failed!.messages.join('\n')}`,
    };
  }

  // ── ⏸ إيقاف الربط / ▶ تشغيل ───────────────────────────────────────────────────────────

  /** The desktop hides the button until a credential row exists; here that is a 409. */
  async toggleLink(tenantId: string, authority = 'zatca') {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const settings = await this.settingsFor(tx, tenantId, authority);
      const credential = await this.credentialFor(tx, tenantId, authority, this.environmentOf(settings));
      if (!credential) throw new DomainError('EINVOICE_LINK_NOT_CONFIGURED', 'يجب إكمال إعدادات الربط أولاً', 409);

      const active = !settings.active;
      await tx
        .update(einvoiceSettings)
        .set({ active, updatedAt: new Date() })
        .where(and(eq(einvoiceSettings.tenantId, tenantId), eq(einvoiceSettings.authority, authority)));
      return { active, message: active ? 'تم التشغيل بنجاح' : 'تم الإيقاف بنجاح' };
    });
  }

  // ── 🧾 what a filing needs ───────────────────────────────────────────────────────────

  /**
   * Everything `EinvoicingService` needs in order to file one document, resolved from the
   * link the tenant saved in this window.
   *
   * The desktop asks the same question on every sale, from three static switches
   * (`MainSetting.IsProductionZatca` / `IsSimulationZatca` · `ZatcaIntegerationActive`,
   * `InvoiceOper.cs` L1478, L1855) and one row read with no `WHERE` clause
   * (`ZatcaService.LoadZatcaCredential`: `select * from ZatcaCredential`). Here the link is
   * per tenant, so it is read from `einvoice_settings` — and the caller may still override
   * the environment for a single filing, which is how a tenant tests the 🧪 simulator
   * without changing the link it files with.
   *
   * Which of the two CSID pairs is used follows the desktop: it authenticates with the
   * **production** pair (`P_CSID` / `P_Secret`, L476-L479) and only falls back to the
   * compliance pair while a production certificate does not exist yet — which is exactly
   * the state a tenant is in during onboarding.
   */
  async filingContext(tenantId: string, authority = 'zatca', override: { environment?: 'simulation' | 'production' } = {}): Promise<FilingContext> {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const settings = await this.settingsFor(tx, tenantId, authority);
      const simulation = override.environment ? override.environment === 'simulation' : settings.simulation;
      const production = override.environment ? override.environment === 'production' : settings.environment === 'production';
      const environment = simulation ? 'simulation' : 'production';
      const credential =
        (await this.credentialFor(tx, tenantId, authority, environment)) ??
        // `select * from ZatcaCredential` — the desktop's row has no environment column, and
        // a tenant whose only row pre-dates the link must still be able to file with it.
        (await this.credentialFor(tx, tenantId, authority, environment === 'simulation' ? 'production' : 'simulation'));

      const productionCsid = credential?.productionCsidEnc ? safeDecrypt(credential.productionCsidEnc) : null;
      const productionSecret = credential?.productionSecretEnc ? safeDecrypt(credential.productionSecretEnc) : null;
      const complianceCsid = credential?.csidEnc ? safeDecrypt(credential.csidEnc) : null;
      const complianceSecret = credential?.secretEnc ? safeDecrypt(credential.secretEnc) : null;

      return {
        settings,
        credential,
        environment,
        gateway: resolveGateway({ simulation, production, baseUrl: process.env.ZATCA_API_BASE_URL }),
        privateKey: credential?.privateKeyEnc ? safeDecrypt(credential.privateKeyEnc) : null,
        csid: productionCsid ?? complianceCsid,
        secret: productionSecret ?? complianceSecret,
        credentialKind: productionCsid && productionSecret ? 'production' : 'compliance',
      };
    });
  }

  // ── internals ────────────────────────────────────────────────────────────────────────

  /** 🧪 Simulation → `simulation`; otherwise the row the real chain files with. */
  private environmentOf(settings: { simulation: boolean; environment: string }): string {
    return settings.simulation ? 'simulation' : 'production';
  }

  private gatewayFor(settings: { simulation: boolean; environment: string }): ZatcaGateway {
    return resolveGateway({ simulation: settings.simulation, production: settings.environment === 'production' });
  }

  /**
   * A gateway that cannot be reached is not a 500: it is a 502 that says which gateway and
   * why. Without this the window would show «حدث خطأ» while the real reason — no internet,
   * a wrong host, a rejected OTP — stayed in the log.
   */
  private async callGateway<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const detail = (error as { detail?: string }).detail ?? (error instanceof Error ? error.message : String(error));
      throw new DomainError('EINVOICE_GATEWAY_UNREACHABLE', `تعذّر الاتصال ببوابة هيئة الزكاة والضريبة: ${detail}`, 502);
    }
  }

  private composeView(settings: typeof einvoiceSettings.$inferSelect, credential: typeof einvoiceCredentials.$inferSelect | null) {
    const done: Record<string, boolean> = {
      csr: Boolean(credential?.csr),
      'compliance-csid': Boolean(credential?.csidEnc),
      'production-csid': Boolean(credential?.productionCsidEnc),
      'compliance-check': Boolean(settings.complianceCheckedAt) && Boolean((settings.lastComplianceCheck as { passed?: boolean } | null)?.passed),
      active: settings.active,
    };
    const at: Record<string, Date | null> = {
      csr: settings.csrGeneratedAt,
      'compliance-csid': settings.complianceCsidAt,
      'production-csid': settings.productionCsidAt,
      'compliance-check': settings.complianceCheckedAt,
      active: null,
    };
    return {
      authority: settings.authority,
      settings: {
        environment: settings.environment,
        simulation: settings.simulation,
        active: settings.active,
        syncManual: settings.syncManual,
        startDate: settings.startDate,
        endDate: settings.endDate,
      },
      csr: this.csrPropertiesOf(settings),
      credential: {
        environment: credential?.environment ?? this.environmentOf(settings),
        hasCsr: Boolean(credential?.csr),
        csr: credential?.csr ?? null,
        hasPrivateKey: Boolean(credential?.privateKeyEnc),
        privateKeyMasked: mask(credential?.privateKeyEnc),
        csidMasked: mask(credential?.csidEnc),
        secretMasked: mask(credential?.secretEnc),
        requestId: credential?.requestId ?? null,
        productionCsidMasked: mask(credential?.productionCsidEnc),
        productionSecretMasked: mask(credential?.productionSecretEnc),
        productionRequestId: credential?.productionRequestId ?? null,
        validFrom: credential?.validFrom ?? null,
        validTo: credential?.validTo ?? null,
        updatedAt: credential?.updatedAt ?? null,
      },
      onboarding: {
        csrGeneratedAt: settings.csrGeneratedAt,
        complianceCsidAt: settings.complianceCsidAt,
        productionCsidAt: settings.productionCsidAt,
        complianceCheckedAt: settings.complianceCheckedAt,
        renewedAt: settings.renewedAt,
        lastComplianceCheck: settings.lastComplianceCheck ?? null,
      },
      checklist: CHECKLIST.map((item) => ({ key: item.key, labelAr: item.labelAr, done: done[item.key] ?? false, at: at[item.key] ?? null })),
      link: { active: settings.active, canToggle: Boolean(credential) },
    };
  }

  private csrPropertiesOf(settings: typeof einvoiceSettings.$inferSelect): CsrProperties {
    return {
      commonName: settings.commonName,
      serialNumber: settings.serialNumber,
      organizationIdentifier: settings.organizationIdentifier,
      organizationUnitName: settings.organizationUnitName,
      organizationName: settings.organizationName,
      countryName: settings.countryName,
      invoiceType: settings.invoiceType,
      address: settings.address,
      industry: settings.industry,
    };
  }

  /** Reads the row, inserting the desktop's defaults when the tenant has never saved one. */
  private async settingsFor(tx: DrizzleTx, tenantId: string, authority: string) {
    const [existing] = await tx
      .select()
      .from(einvoiceSettings)
      .where(and(eq(einvoiceSettings.tenantId, tenantId), eq(einvoiceSettings.authority, authority)));
    if (existing) return existing;
    const startDate = today();
    const [row] = await tx
      .insert(einvoiceSettings)
      .values({ id: newId(), tenantId, authority, environment: 'compliance', simulation: false, active: true, syncManual: false, startDate, endDate: endDateOf(startDate), countryName: 'SA', invoiceType: '1100' })
      .onConflictDoNothing()
      .returning();
    return row ?? (await tx.select().from(einvoiceSettings).where(and(eq(einvoiceSettings.tenantId, tenantId), eq(einvoiceSettings.authority, authority))))[0]!;
  }

  private async credentialFor(tx: DrizzleTx, tenantId: string, authority: string, environment: string) {
    const [row] = await tx
      .select()
      .from(einvoiceCredentials)
      .where(and(eq(einvoiceCredentials.tenantId, tenantId), eq(einvoiceCredentials.authority, authority), eq(einvoiceCredentials.environment, environment)));
    return row ?? null;
  }

  /** The seller on the sample documents is the tenant's own company card. */
  private async sellerParty(tx: DrizzleTx, tenantId: string) {
    const [profile] = await tx.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenantId));
    const tenant = rowsOf(await tx.execute(sql`SELECT name FROM tenants WHERE id = ${tenantId}`))[0];
    const address = (profile?.address ?? {}) as Record<string, string | undefined>;
    return {
      nameAr: String(profile?.nameAr ?? tenant?.name ?? 'المنشأة'),
      nameEn: profile?.nameEn ? String(profile.nameEn) : undefined,
      vatNo: profile?.taxNo ? String(profile.taxNo) : undefined,
      crNo: profile?.crNo ? String(profile.crNo) : undefined,
      street: address.street,
      buildingNumber: address.building ?? address.plot,
      district: address.district,
      city: address.city,
      postalZone: address.postal,
      countryCode: address.countryCode ?? (profile?.countryCode ? String(profile.countryCode) : 'SA'),
    };
  }
}
