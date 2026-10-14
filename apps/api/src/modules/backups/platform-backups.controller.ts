import { Body, Controller, Get, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import {
  platformBackupQuerySchema,
  platformBackupRunSchema,
  platformDataRequestCreateSchema,
  platformDataRequestDecideSchema,
  platformDataRequestExecuteSchema,
  platformDataRequestQuerySchema,
  platformRetentionApplySchema,
  platformRetentionUpdateSchema,
  type ListEnvelope,
  type PlatformBackupDownload,
  type PlatformBackupQueryDto,
  type PlatformBackupRow,
  type PlatformBackupRunInput,
  type PlatformBackupVerifyResult,
  type PlatformDataRequestCreateInput,
  type PlatformDataRequestDecideInput,
  type PlatformDataRequestExecuteInput,
  type PlatformDataRequestExport,
  type PlatformDataRequestQueryDto,
  type PlatformDataRequestRow,
  type PlatformDataRequestEraseResult,
  type PlatformRetention,
  type PlatformRetentionApplyInput,
  type PlatformRetentionApplyResult,
  type PlatformRetentionUpdate,
} from '@erp/contracts';
import { DomainError, errorCodes } from '@erp/contracts';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { getAuthContext } from '../../request-context/request-context.js';
import { Public } from '../platform/decorators/public.decorator.js';
import { RequiresPlatformRole } from '../platform/decorators/requires-platform-role.decorator.js';
import { PlatformAdminGuard } from '../platform/guards/platform-admin.guard.js';
import { isExpired, verifyDownloadToken } from '../platform-services/files/download-token.js';

import { PlatformBackupsService } from './platform-backups.service.js';

/**
 * P-C10 — سطح «البيانات والاسترجاع» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
 *
 * أسماء المسارات هي أسماء الخطة: `POST /platform/backups/run` · `GET /platform/backups` ·
 * `GET /platform/backups/:id/download` · `POST /platform/backups/:id/verify` ·
 * `GET/PUT /platform/retention`. وأُضيف إليها ما لا يُستغنى عنه لأداء الغرض المعلَن:
 *
 *   * `GET /platform/backups/:id/content` — وجهة الرابط الموقّع (الرمز هو التصريح، كما في
 *     `/files/:id/content`)؛ بدونه يكون `download` وعداً بلا تنزيل.
 *   * `POST /platform/retention/apply` — «سياسة احتفاظ» لا تُنفَّذ ليست نصّاً: هذا مسار
 *     التنفيذ، ووضعُه الافتراضي تجريبي.
 *   * أربعة مسارات لطلبات البيانات (`GET` · `POST` · `POST /:id/decide` ·
 *     `POST /:id/execute` + `GET /exports/:artifactId`) لأن الخطة تسرد «طلبات تصدير/حذف
 *     البيانات الشخصية» ضمن شاشات الجزء ولم تُسمِّ لها مسارات.
 *
 * ورمزٌ واحد للجزء كما نصّت الخطة: **`console.backups.manage`**. ومن يقرأ النسخة يقدر أن
 * يشغّلها ويمحو طلباً — وهو ما يعنيه الرمز الواحد: من يملك النسخة يملك ما فيها.
 */
@ApiTags('platform-backups')
@ApiBearerAuth()
@UseGuards(PlatformAdminGuard)
@Controller('platform')
export class PlatformBackupsController {
  constructor(private readonly backups: PlatformBackupsService) {}

  // ─────────────────────────────────────────────────────────── النسخ

  @Get('backups')
  @RequiresPlatformRole('console.backups.manage')
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiQuery({ name: 'filter[status]', required: false, description: 'running | succeeded | failed' })
  @ApiQuery({ name: 'filter[scope]', required: false, description: 'platform | tenant' })
  @ApiQuery({ name: 'filter[store]', required: false, description: 'object-storage | filesystem' })
  @ApiOperation({ summary: 'Backup runs with the artifact each one produced' })
  @ApiOkResponse({ description: 'Backup page' })
  async list(
    @Query(new ZodValidationPipe(platformBackupQuerySchema)) query: PlatformBackupQueryDto,
  ): Promise<ListEnvelope<PlatformBackupRow>> {
    return this.backups.listBackups(query);
  }

  @Post('backups/run')
  @RequiresPlatformRole('console.backups.manage')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { scope: { type: 'string' }, tenantId: { type: 'string' }, note: { type: 'string' } },
    },
  })
  @ApiOperation({ summary: 'Read every table through its own RLS context and write one encrypted artifact' })
  @ApiOkResponse({ description: 'The finished (or failed) run with its measured artifact' })
  @ApiResponse({ status: 422, description: 'Too large to be a backup, or a tenant scope without a tenant' })
  async run(
    @Body(new ZodValidationPipe(platformBackupRunSchema)) body: PlatformBackupRunInput,
  ): Promise<{ data: PlatformBackupRow }> {
    return { data: await this.backups.runBackup(body, getAuthContext().userId) };
  }

  @Post('backups/:id/verify')
  @RequiresPlatformRole('console.backups.manage')
  @ApiOperation({ summary: 'Re-read the artifact, recompute its checksum and plan a dry-run restore' })
  @ApiOkResponse({ description: 'Verification with a per-table reconcile' })
  @ApiResponse({ status: 404, description: 'No such run, or a run without an artifact' })
  async verify(@Param('id') id: string): Promise<{ data: PlatformBackupVerifyResult }> {
    return { data: await this.backups.verifyBackup(id, getAuthContext().userId) };
  }

  @Get('backups/:id/download')
  @RequiresPlatformRole('console.backups.manage')
  @ApiOperation({ summary: 'Mint a short-lived signed URL for the decrypted dump' })
  @ApiOkResponse({ description: 'Signed URL and the artifact’s measured size and checksum' })
  @ApiResponse({ status: 410, description: 'The retention policy already pruned this artifact' })
  async download(@Param('id') id: string): Promise<{ data: PlatformBackupDownload }> {
    const minted = await this.backups.downloadUrl(id, getAuthContext().userId);
    return {
      data: {
        jobId: id,
        name: minted.name,
        url: minted.url,
        expiresAt: minted.expiresAt,
        bytes: minted.bytes,
        checksum: minted.checksum,
      },
    };
  }

  /**
   * البايتات نفسها. **بلا `@RequiresPlatformRole`** لأن الرمز الموقّع هو التصريح — وهو نفس
   * قرار `/files/:id/content`: تطبيقٌ يفتح رابطاً في تبويبٍ جديدة لا يستطيع أن يحمل رمزاً
   * حاملاً، والقدرة هنا هي التوقيع ومهلته.
   */
  @Get('backups/:id/content')
  @Public()
  @ApiQuery({ name: 'expires', required: true })
  @ApiQuery({ name: 'signature', required: true })
  @ApiOperation({ summary: 'Stream a signed dump (the signature is the capability)' })
  async content(
    @Param('id') id: string,
    @Query('expires') expires: string,
    @Query('signature') signature: string,
    @Res() response: Response,
  ): Promise<void> {
    this.assertSignedCapability(id, 'platform-backup', expires, signature);
    const artifact = await this.backups.artifactContent(id);
    response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${artifact.name}"`);
    response.send(artifact.body);
  }

  // ─────────────────────────────────────────────────────────── الاحتفاظ

  @Get('retention')
  @RequiresPlatformRole('console.backups.manage')
  @ApiOperation({ summary: 'The retention policy, and what applying it right now would delete' })
  @ApiOkResponse({ description: 'Policy with live purge counters' })
  async retention(): Promise<{ data: PlatformRetention }> {
    return { data: await this.backups.retention() };
  }

  @Put('retention')
  @RequiresPlatformRole('console.backups.manage')
  @ApiBody({ schema: { type: 'object', properties: { outboxPurgeDays: { type: 'number' } } } })
  @ApiOperation({ summary: 'Write the retention windows (partial patch, bounds enforced)' })
  @ApiOkResponse({ description: 'The policy after the write, with fresh counters' })
  @ApiResponse({ status: 400, description: 'A window outside its documented bounds' })
  async updateRetention(
    @Body(new ZodValidationPipe(platformRetentionUpdateSchema)) body: PlatformRetentionUpdate,
  ): Promise<{ data: PlatformRetention }> {
    return { data: await this.backups.updateRetention(body, getAuthContext().userId) };
  }

  @Post('retention/apply')
  @RequiresPlatformRole('console.backups.manage')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        mode: { type: 'string' },
        reason: { type: 'string' },
        targets: { type: 'array', items: { type: 'string' } },
      },
      required: ['reason'],
    },
  })
  @ApiOperation({ summary: 'Apply the policy (dry-run by default) and audit the outcome' })
  @ApiOkResponse({ description: 'Per-target counts, and what was removed when applying' })
  async applyRetention(
    @Body(new ZodValidationPipe(platformRetentionApplySchema)) body: PlatformRetentionApplyInput,
  ): Promise<{ data: PlatformRetentionApplyResult }> {
    return { data: await this.backups.applyRetention(body, getAuthContext().userId) };
  }

  // ─────────────────────────────────────────────────────────── طلبات البيانات

  @Get('data-requests')
  @RequiresPlatformRole('console.backups.manage')
  @ApiQuery({ name: 'filter[kind]', required: false, description: 'export | erase' })
  @ApiQuery({ name: 'filter[status]', required: false })
  @ApiQuery({ name: 'filter[tenantId]', required: false })
  @ApiOperation({ summary: 'Data-subject export and erasure requests' })
  @ApiOkResponse({ description: 'Request page' })
  async listRequests(
    @Query(new ZodValidationPipe(platformDataRequestQuerySchema)) query: PlatformDataRequestQueryDto,
  ): Promise<ListEnvelope<PlatformDataRequestRow>> {
    return this.backups.listDataRequests(query);
  }

  @Post('data-requests')
  @RequiresPlatformRole('console.backups.manage')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        tenantId: { type: 'string' },
        subjectEmail: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['kind', 'tenantId', 'subjectEmail'],
    },
  })
  @ApiOperation({ summary: 'Open a request for one subject (pending until decided)' })
  @ApiOkResponse({ description: 'The request as opened' })
  @ApiResponse({ status: 404, description: 'No such tenant' })
  async createRequest(
    @Body(new ZodValidationPipe(platformDataRequestCreateSchema)) body: PlatformDataRequestCreateInput,
  ): Promise<{ data: PlatformDataRequestRow }> {
    return { data: await this.backups.createDataRequest(body, getAuthContext().userId) };
  }

  @Post('data-requests/:id/decide')
  @RequiresPlatformRole('console.backups.manage')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { decision: { type: 'string' }, reason: { type: 'string' } },
      required: ['decision', 'reason'],
    },
  })
  @ApiOperation({ summary: 'Approve or reject a request, with a written reason' })
  @ApiOkResponse({ description: 'The request after the decision' })
  @ApiResponse({ status: 422, description: 'Already decided' })
  async decide(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(platformDataRequestDecideSchema)) body: PlatformDataRequestDecideInput,
  ): Promise<{ data: PlatformDataRequestRow }> {
    return { data: await this.backups.decideDataRequest(id, body, getAuthContext().userId) };
  }

  @Post('data-requests/:id/execute')
  @RequiresPlatformRole('console.backups.manage')
  @ApiBody({
    schema: { type: 'object', properties: { confirm: { type: 'string' }, reason: { type: 'string' } } },
  })
  @ApiOperation({ summary: 'Produce the export artifact, or anonymise the subject (erase needs `confirm`)' })
  @ApiOkResponse({
    description: 'Either the export’s artifact and link, or what the erasure changed and kept',
  })
  @ApiResponse({
    status: 422,
    description: 'Not approved, or the confirmation did not match the subject e-mail',
  })
  async execute(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(platformDataRequestExecuteSchema)) body: PlatformDataRequestExecuteInput,
  ): Promise<{ data: PlatformDataRequestExecuteResponse }> {
    const result = await this.backups.executeDataRequest(id, body, getAuthContext().userId);
    return { data: result };
  }

  @Get('data-requests/exports/:artifactId')
  @Public()
  @ApiQuery({ name: 'expires', required: true })
  @ApiQuery({ name: 'signature', required: true })
  @ApiOperation({ summary: 'Download a data export with its signed capability' })
  async exportContent(
    @Param('artifactId') artifactId: string,
    @Query('expires') expires: string,
    @Query('signature') signature: string,
    @Res() response: Response,
  ): Promise<void> {
    this.assertSignedCapability(artifactId, 'data-export', expires, signature);
    const artifact = await this.backups.exportContent(artifactId);
    response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${artifact.name}"`);
    response.send(artifact.body);
  }

  /**
   * التحقّق من رمز التنزيل: التوقيع على `(id|scope|expires)` ومنعُ انتهاء المهلة.
   *
   * ولا يُقرأ المستأجر من الطلب أبداً — الرمز نفسه يحمل النطاق، تماماً كما في
   * `FilesService.resolveSignedContent`.
   */
  private assertSignedCapability(id: string, scope: string, expires: string, signature: string): void {
    const expiresAt = Number(expires);
    if (!Number.isFinite(expiresAt)) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'The download link is malformed', 400, {
        field: 'expires',
      });
    }
    if (isExpired(expiresAt)) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'The download link has expired', 410, {
        field: 'expires',
      });
    }
    if (!verifyDownloadToken({ fileId: id, tenantId: scope, expiresAtEpochSeconds: expiresAt }, signature)) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'The download signature is invalid', 403, {
        field: 'signature',
      });
    }
  }
}

/** نتيجة التنفيذ: إمّا تصديرٌ أو محو — لا الاثنان معاً. */
export type PlatformDataRequestExecuteResponse =
  { export: PlatformDataRequestExport } | { erased: PlatformDataRequestEraseResult };
