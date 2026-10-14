import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, StreamableFile } from '@nestjs/common';
import type { Request } from 'express';
import { env } from '@erp/config';

import { Public, RateLimit, RequiresPermission, getTenantContext } from '../platform/index.js';

import { SupplierPortalService } from './supplier-portal.service.js';

function clientIp(request: Request): string | undefined {
  const forwarded = request.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
  return first?.trim() || request.ip;
}

/**
 * Supplier login is not a staff session. These routes are `@Public()` and the service
 * checks the supplier bearer token itself, so a portal user never needs an ERP permission.
 */
@Controller()
export class SupplierPortalController {
  constructor(private readonly portal: SupplierPortalService) {}

  @Post('supplier-portal/users')
  @RequiresPermission('supplier_portal.access')
  async invite(@Body() body: { partyId?: string; email?: string; password?: string }) {
    return {
      data: await this.portal.invite(getTenantContext().tenantId, {
        partyId: body.partyId ?? '',
        email: body.email ?? '',
        password: body.password,
      }),
    };
  }

  @Get('supplier-portal/users')
  @RequiresPermission('supplier_portal.access')
  async users() {
    return { data: await this.portal.listUsers(getTenantContext().tenantId) };
  }

  @Post('supplier-portal/rfqs')
  @RequiresPermission('supplier_portal.access')
  async createRfq(@Body() body: { partyId?: string; title?: string; note?: string }) {
    return {
      data: await this.portal.createRfq(getTenantContext().tenantId, {
        partyId: body.partyId ?? '',
        title: body.title ?? '',
        note: body.note,
      }),
    };
  }

  @Get('supplier-portal/rfqs')
  @RequiresPermission('supplier_portal.access')
  async rfqs() {
    return { data: await this.portal.listRfqs(getTenantContext().tenantId) };
  }

  @Get('supplier-portal/uploads')
  @RequiresPermission('supplier_portal.access')
  async uploads() {
    return { data: await this.portal.listUploads(getTenantContext().tenantId) };
  }

  @Public()
  @Post('supplier-portal/auth/login')
  @HttpCode(200)
  @RateLimit({ name: 'login', limit: env.RATE_LIMIT_LOGIN_PER_MINUTE, windowMs: 60_000 })
  async login(@Body() body: { tenantCode?: string; email?: string; password?: string }) {
    return {
      data: await this.portal.login({
        tenantCode: body.tenantCode ?? '',
        email: body.email ?? '',
        password: body.password ?? '',
      }),
    };
  }

  @Public()
  @Get('supplier-portal/invoices')
  async invoices(@Headers('authorization') authorization?: string) {
    return { data: await this.portal.invoices(authorization) };
  }

  @Public()
  @Get('supplier-portal/invoices/:id')
  async invoice(@Headers('authorization') authorization: string | undefined, @Param('id') id: string) {
    return { data: await this.portal.invoice(authorization, id) };
  }

  @Public()
  @Get('supplier-portal/payments')
  async payments(@Headers('authorization') authorization?: string) {
    return { data: await this.portal.payments(authorization) };
  }

  @Public()
  @Get('supplier-portal/quotations')
  async quotations(@Headers('authorization') authorization?: string) {
    return { data: await this.portal.quotations(authorization) };
  }

  @Public()
  @Post('supplier-portal/quotations/:id/respond')
  @HttpCode(200)
  async respond(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: { price?: string; note?: string },
  ) {
    return {
      data: await this.portal.respond(authorization, id, {
        offer: body.price == null ? '' : String(body.price),
        note: body.note ?? '',
      }),
    };
  }

  @Public()
  @Post('supplier-portal/invoices')
  async upload(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: { referenceNo?: string; declaredTotal?: string; note?: string },
  ) {
    return {
      data: await this.portal.uploadInvoice(authorization, {
        referenceNo: body.referenceNo ?? '',
        declaredTotal: body.declaredTotal == null ? '' : String(body.declaredTotal),
        note: body.note,
      }),
    };
  }
}

@Controller()
export class EsignController {
  constructor(private readonly portal: SupplierPortalService) {}

  @Post('esign/requests')
  @RequiresPermission('esign.manage')
  async create(
    @Body()
    body: {
      entityType?: string;
      entity_type?: string;
      entityId?: string;
      entity_id?: string;
      signerEmail?: string;
      signer_email?: string;
      signerName?: string;
      signer_name?: string;
      message?: string;
    },
  ) {
    return {
      data: await this.portal.createEsign(getTenantContext().tenantId, {
        entityType: body.entityType ?? body.entity_type ?? '',
        entityId: body.entityId ?? body.entity_id ?? '',
        signerEmail: body.signerEmail ?? body.signer_email ?? '',
        signerName: body.signerName ?? body.signer_name,
        message: body.message,
      }),
    };
  }

  @Get('esign/requests')
  @RequiresPermission('esign.manage')
  async list(@Query('entityId') entityId?: string) {
    return { data: await this.portal.listEsign(getTenantContext().tenantId, entityId) };
  }

  @Public()
  @Get('esign/:token')
  @RateLimit({ name: 'esign-view', limit: env.RATE_LIMIT_DEFAULT_PER_MINUTE, windowMs: 60_000 })
  async view(@Param('token') token: string, @Req() request: Request) {
    return { data: await this.portal.viewEsign(token, clientIp(request)) };
  }

  @Public()
  @Post('esign/:token/sign')
  @HttpCode(200)
  @RateLimit({ name: 'esign-sign', limit: env.RATE_LIMIT_LOGIN_PER_MINUTE, windowMs: 60_000 })
  async sign(
    @Param('token') token: string,
    @Body() body: { signatureData?: string; signature_data?: string; otp?: string },
    @Req() request: Request,
  ) {
    return {
      data: await this.portal.signEsign(
        token,
        { signatureData: body.signatureData ?? body.signature_data ?? '', otp: body.otp ?? '' },
        clientIp(request),
      ),
    };
  }

  @Public()
  @Get('esign/:token/pdf')
  @RateLimit({ name: 'esign-view', limit: env.RATE_LIMIT_DEFAULT_PER_MINUTE, windowMs: 60_000 })
  async pdf(@Param('token') token: string) {
    const bytes = await this.portal.signedPdfOf(token);
    return new StreamableFile(bytes, {
      type: 'application/pdf',
      disposition: 'inline; filename="signed.pdf"',
    });
  }
}
