import { Body, Controller, Delete, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  fileContentQuerySchema,
  fileFinalizeSchema,
  fileListQuerySchema,
  filePresignSchema,
  idParamSchema,
  type FileContentQuery,
  type FileDownloadResponse,
  type FileDto,
  type FileFinalizeRequest,
  type FileListQueryDto,
  type FilePresignRequest,
  type FilePresignResponse,
  type IdParam,
  type ListEnvelope,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { zodApiBody } from '../../../openapi/zod-api-body.js';
import { getAuthContext } from '../../../request-context/request-context.js';
import { getTenantContext, Public, RequiresPermission } from '../../platform/index.js';

import { FilesService } from './files.service.js';

/**
 * Files — API_CONTRACT §2 (`POST /files/presign` + CR-005 read/finalize/download).
 *
 * Every route needs `platform.file.upload`, except `GET /files/{id}/content`, which is
 * public *by design*: it is reached from a browser that cannot send an Authorization
 * header, and its authority is the HMAC signature minted by `/download`.
 */
@ApiTags('platform-services')
@ApiBearerAuth()
@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post('presign')
  @RequiresPermission('tenant.file.upload')
  @zodApiBody(filePresignSchema)
  @ApiOperation({ summary: 'Reserve a file row and return a pre-signed upload URL' })
  @ApiResponse({ status: 201, description: 'Upload URL issued' })
  @ApiResponse({ status: 400, description: 'Mime type or size rejected (VALIDATION_FAILED)' })
  @ApiResponse({ status: 422, description: 'Entity cannot receive attachments' })
  async presign(
    @Body(new ZodValidationPipe(filePresignSchema)) body: FilePresignRequest,
  ): Promise<{ data: FilePresignResponse }> {
    const tenant = getTenantContext();
    return { data: await this.files.presign(tenant.tenantId, getAuthContext().userId, body) };
  }

  @Post(':id/finalize')
  @RequiresPermission('tenant.file.upload')
  @zodApiBody(fileFinalizeSchema)
  @ApiOperation({ summary: 'Mark an upload complete and attach it to an entity' })
  @ApiResponse({ status: 201, description: 'File finalized' })
  @ApiResponse({ status: 404, description: 'Not found in this tenant' })
  @ApiResponse({ status: 422, description: 'Unknown entity or missing target row' })
  async finalize(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Body(new ZodValidationPipe(fileFinalizeSchema)) body: FileFinalizeRequest,
  ): Promise<{ data: FileDto }> {
    const tenant = getTenantContext();
    const auth = getAuthContext();
    return {
      data: await this.files.finalize(tenant.tenantId, auth.userId, auth.membershipId, params.id, body),
    };
  }

  @Get()
  @RequiresPermission('tenant.file.upload')
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'filter[status]', required: false })
  @ApiQuery({ name: 'filter[entity]', required: false })
  @ApiOperation({ summary: 'List the tenant files' })
  @ApiResponse({ status: 200, description: 'File page' })
  async list(
    @Query(new ZodValidationPipe(fileListQuerySchema)) query: FileListQueryDto,
  ): Promise<ListEnvelope<FileDto>> {
    return this.files.list(getTenantContext().tenantId, query);
  }

  /**
   * «🗑️ حذف» — R7 · مدير الملفات. صلاحيةٌ مستقلة (`tenant.file.manage`) لأن الإزالة
   * ليست رفعاً: مَن يرفع مرفقاً ليست له بالضرورة أن يحذف مرفق غيره.
   */
  @Delete(':id')
  @RequiresPermission('tenant.file.manage')
  @ApiOperation({ summary: 'Delete a file (soft) and ask storage to drop the object' })
  @ApiResponse({ status: 200, description: 'File deleted' })
  @ApiResponse({ status: 404, description: 'Not found in this tenant' })
  @ApiResponse({ status: 503, description: 'Object storage is not configured (STORAGE_NOT_CONFIGURED)' })
  async remove(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
  ): Promise<{ data: { id: string; name: string; deleted: true; objectRemoved: boolean } }> {
    const tenant = getTenantContext();
    const auth = getAuthContext();
    return {
      data: await this.files.remove(tenant.tenantId, auth.userId, auth.membershipId, params.id),
    };
  }

  @Get(':id')
  @RequiresPermission('tenant.file.upload')
  @ApiOperation({ summary: 'Read one file (404 across tenants)' })
  @ApiResponse({ status: 200, description: 'File' })
  @ApiResponse({ status: 404, description: 'Not found in this tenant' })
  async read(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam): Promise<{ data: FileDto }> {
    return { data: await this.files.read(getTenantContext().tenantId, params.id) };
  }

  @Get(':id/download')
  @RequiresPermission('tenant.file.upload')
  @ApiOperation({ summary: 'Mint a short-lived, app-signed download URL' })
  @ApiResponse({ status: 200, description: 'Signed URL' })
  @ApiResponse({ status: 404, description: 'Not found in this tenant' })
  @ApiResponse({ status: 422, description: 'Upload has not been finalized' })
  async download(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
  ): Promise<{ data: FileDownloadResponse }> {
    return { data: await this.files.downloadUrl(getTenantContext().tenantId, params.id) };
  }

  /**
   * Redirects to the storage pre-signed GET. Public because a browser download cannot
   * carry a bearer token — the signature and its expiry are the capability, and the
   * tenant comes from the signed payload, never from the caller.
   */
  @Get(':id/content')
  @Public()
  @ApiOperation({ summary: 'Follow an app-signed download URL (302 to object storage)' })
  @ApiResponse({ status: 302, description: 'Redirect to object storage' })
  @ApiResponse({ status: 401, description: 'Signature missing, invalid or expired' })
  async content(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Query(new ZodValidationPipe(fileContentQuerySchema)) query: FileContentQuery,
    @Res() response: Response,
  ): Promise<void> {
    const target = await this.files.resolveSignedContent(
      params.id,
      query.expires,
      query.signature,
      query.tenant,
    );
    response.redirect(302, target.url);
  }
}
