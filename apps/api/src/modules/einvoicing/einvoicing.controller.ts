import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import { EinvoicingService, type CredentialInput } from './einvoicing.service.js';
import { ZatcaOnboardingService, type SettingsInput } from './zatca-onboarding.service.js';

@Controller()
export class EinvoicingController {
  constructor(
    private readonly einvoicing: EinvoicingService,
    private readonly onboarding: ZatcaOnboardingService,
  ) {}

  // ── ⚙️ إعدادات الربط الضريبي - زاتكا ZATCA (`frmZatcaSetting.xaml`) ──────────────────

  @Get('einvoice/settings') @RequiresPermission('einvoice.view')
  settings() { return this.onboarding.view(getTenantContext().tenantId); }

  /** 💾 حفظ الإعدادات — Save Settings. */
  @Put('einvoice/settings') @RequiresPermission('einvoice.manage')
  saveSettings(@Body() body: SettingsInput) { return this.onboarding.saveSettings(getTenantContext().tenantId, body ?? {}); }

  /** 🔄 تعبئة تلقائي — fills the CSR properties from بطاقة المنشأة. */
  @Post('einvoice/settings/fill-from-company') @RequiresPermission('einvoice.manage')
  fillFromCompany() { return this.onboarding.fillFromCompany(getTenantContext().tenantId); }

  /** ⚡ توليد — Generate. The private key is returned once and stored encrypted. */
  @Post('einvoice/csr/generate') @RequiresPermission('einvoice.credentials.manage')
  generateCsr() { return this.onboarding.generateCsr(getTenantContext().tenantId); }

  /** 🔵 Compliance CSID — needs the 🔑 OTP. */
  @Post('einvoice/onboarding/compliance-csid') @RequiresPermission('einvoice.credentials.manage')
  complianceCsid(@Body() body: { otp?: string }) { return this.onboarding.requestComplianceCsid(getTenantContext().tenantId, body ?? {}); }

  /** 🔐 حفظ مفتاح التشفير — Get PCSID. */
  @Post('einvoice/onboarding/production-csid') @RequiresPermission('einvoice.credentials.manage')
  productionCsid() { return this.onboarding.requestProductionCsid(getTenantContext().tenantId); }

  /** 🔄 Renews CSID — تجديد الشهادة بعد 5 سنوات. */
  @Post('einvoice/onboarding/renew') @RequiresPermission('einvoice.credentials.manage')
  renewCsid() { return this.onboarding.renewCsid(getTenantContext().tenantId); }

  /** 🧪 اختبار الربط — Test Compliance: the six documents. */
  @Post('einvoice/onboarding/compliance-check') @RequiresPermission('einvoice.credentials.manage')
  complianceCheck() { return this.onboarding.complianceCheck(getTenantContext().tenantId); }

  /** ⏸ إيقاف الربط / ▶ تشغيل. */
  @Post('einvoice/link/toggle') @RequiresPermission('einvoice.manage')
  toggleLink() { return this.onboarding.toggleLink(getTenantContext().tenantId); }

  // ── 🧾 الإرسال والتوقيع والسلسلة (`ZatcaService.IntegrateInvoice`) ────────────────────

  /**
   * 🧾 الفواتير المرفوعة على موقع الضرائب — the grid of `frmSentEinvoice.xaml`, with its
   * own two paging fields (حجم الصفحة · رقم الصفحة) and 🔍 عرض.
   */
  @Get('einvoice/filings') @RequiresPermission('einvoice.view')
  filings(
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('pageNo') pageNo?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.einvoicing.filings(getTenantContext().tenantId, {
      status,
      from,
      to,
      pageNo: pageNo ? Number(pageNo) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  /** 📄 بيانات الفاتورة — one filing with its document, its QR decoded and its chain slot. */
  @Get('einvoice/filings/:id') @RequiresPermission('einvoice.view')
  filing(@Param('id') id: string) { return this.einvoicing.filing(getTenantContext().tenantId, id); }

  /** The tenant's place in the chain: the last hash filed and the counter that follows it. */
  @Get('einvoice/chain') @RequiresPermission('einvoice.view')
  chain() { return this.einvoicing.chain(getTenantContext().tenantId); }

  // ── 📊 حالة المزامنة (`frmInvsSyncStatusZatca.xaml`) ──────────────────────────────────

  /**
   * 🔄 مزامنة ZATCA — files the invoices the clerk ticked in «مزامنة الفواتير - ZATCA».
   * Every row comes back with what happened to it, so a partial failure is visible next
   * to the invoice that earned it rather than hidden behind one message.
   */
  @Post('einvoice/sync') @RequiresPermission('einvoice.submit')
  sync(@Body() body: { ids?: string[] } = {}) { return this.einvoicing.sync(getTenantContext().tenantId, body ?? {}); }

  @Put('einvoice/credentials') @RequiresPermission('einvoice.credentials.manage') putCredentials(@Body() body: CredentialInput) { return this.einvoicing.upsertCredentials(getTenantContext().tenantId, body); }
  @Get('einvoice/credentials') @RequiresPermission('einvoice.view') credentials() { return this.einvoicing.listCredentials(getTenantContext().tenantId); }
  @Get('einvoice/submissions') @RequiresPermission('einvoice.view') submissions(@Query('status') status?: string) { return this.einvoicing.submissions(getTenantContext().tenantId, status); }
  /** 🔁 إعادة الإرسال — re-files a document that failed, without rebuilding it. */
  @Post('einvoice/submissions/:id/retry') @RequiresPermission('einvoice.submit') retry(@Param('id') id: string) { return this.einvoicing.retry(getTenantContext().tenantId, id); }
  @Post('sales-invoices/:id/einvoice/submit') @RequiresPermission('einvoice.submit') submitInvoice(@Param('id') id: string, @Body() body: { authority?: 'zatca' | 'eta'; environment?: 'simulation' | 'production' }) { return this.einvoicing.submitSalesInvoice(getTenantContext().tenantId, id, body.authority, body.environment); }
  @Get('einvoice/health') @RequiresPermission('einvoice.view') health() { return this.einvoicing.health(getTenantContext().tenantId); }
}
