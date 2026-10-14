import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import type { FilePresignRequest } from '@erp/contracts';

import { getAuthContext } from '../../request-context/request-context.js';
import { getTenantContext, RequiresPermission } from '../platform/index.js';

import {
  OcrService,
  type OcrCreateJobInput,
  type OcrInvoiceFromInput,
} from './ocr.service.js';

/** Purchase-invoice OCR API. Files are uploaded through the shared files service. */
@Controller('ocr')
export class OcrController {
  constructor(private readonly ocr: OcrService) {}

  @Post('presign')
  @RequiresPermission('purchase.ocr.use')
  async presign(@Body() body: Pick<FilePresignRequest, 'name' | 'mime' | 'sizeBytes'>) {
    const tenant = getTenantContext();
    return { data: await this.ocr.presign(tenant.tenantId, getAuthContext().userId, body) };
  }

  @Post('jobs')
  @RequiresPermission('purchase.ocr.use')
  async createJob(@Body() body: OcrCreateJobInput) {
    return { data: await this.ocr.createJob(getTenantContext().tenantId, body) };
  }

  @Get('jobs')
  @RequiresPermission('purchase.ocr.use')
  async listJobs() {
    return { data: await this.ocr.listJobs(getTenantContext().tenantId) };
  }

  @Get('jobs/:id')
  @RequiresPermission('purchase.ocr.use')
  async getJob(@Param('id') id: string) {
    return { data: await this.ocr.getJob(getTenantContext().tenantId, id) };
  }
}

/** Exact route from the future-enhancement contract: `/purchases/invoices/from-ocr`. */
@Controller('purchases/invoices')
export class OcrPurchaseInvoicesController {
  constructor(private readonly ocr: OcrService) {}

  @Post('from-ocr')
  @RequiresPermission('purchase.invoice.create', 'purchase.ocr.use')
  async fromOcr(@Body() body: OcrInvoiceFromInput) {
    const auth = getAuthContext();
    return {
      data: await this.ocr.createInvoiceFromOcr(getTenantContext().tenantId, body, {
        userId: auth.userId,
        membershipId: auth.membershipId,
      }),
    };
  }
}
