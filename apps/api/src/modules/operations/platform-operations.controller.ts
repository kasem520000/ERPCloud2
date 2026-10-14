import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  platformFileActionSchema,
  platformFileQuerySchema,
  platformJobActionSchema,
  platformJobQuerySchema,
  type ListEnvelope,
  type PlatformFileAction,
  type PlatformFileQueryDto,
  type PlatformFileRow,
  type PlatformFileScanResult,
  type PlatformHealth,
  type PlatformJobAction,
  type PlatformJobQueryDto,
  type PlatformJobRow,
  type WorkerHeartbeat,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { getAuthContext } from '../../request-context/request-context.js';
import { RequiresPlatformRole } from '../platform/decorators/requires-platform-role.decorator.js';
import { PlatformAdminGuard } from '../platform/guards/platform-admin.guard.js';

import { PlatformOperationsService } from './platform-operations.service.js';

/**
 * P-C9 — سطح «العمليات» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
 *
 * أسماء المسارات هي أسماء الخطة: `POST /platform/jobs/:id/retry` ·
 * `POST /platform/jobs/:id/cancel` · `GET /platform/health/detailed` ·
 * `GET/DELETE /platform/files` — وأُضيف إليها ما لا يُستغنى عنه لأداء الغرض المعلَن:
 * `GET /platform/jobs` (شبكة الطابور نفسها: النوع والحالة والمحاولات والخطأ — ولا يمكن
 * «إعادة محاولة» صفٍّ لا يُرى)، و`GET /platform/jobs/heartbeat` (نبض العامل مفصولاً عن
 * شاشة الصحة لأنه أسرع منها وأرخص)، و`POST /platform/files/:id/scan` (الفحص فعلٌ يُطلب
 * لا معلومة تُقرأ).
 *
 * الرمزان كما نصّت الخطة: `console.jobs.view` للقراءة و**`console.jobs.manage` الجديد**
 * للفعلين، و`console.health.view` للمجسّات. ومدقّق المنصة يحمل الأول ولا يحمل الثاني.
 */
@ApiTags('platform-operations')
@ApiBearerAuth()
@UseGuards(PlatformAdminGuard)
@Controller('platform')
export class PlatformOperationsController {
  constructor(private readonly operations: PlatformOperationsService) {}

  // ─────────────────────────────────────────────────────────── الطابور

  @Get('jobs')
  @RequiresPlatformRole('console.jobs.view')
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiQuery({ name: 'filter[status]', required: false, description: 'pending | published | dead' })
  @ApiQuery({ name: 'filter[queue]', required: false })
  @ApiQuery({ name: 'filter[type]', required: false })
  @ApiQuery({ name: 'filter[tenantId]', required: false })
  @ApiOperation({ summary: 'The outbox across every customer, with each job’s payload keys' })
  @ApiOkResponse({ description: 'Job page' })
  async jobs(
    @Query(new ZodValidationPipe(platformJobQuerySchema)) query: PlatformJobQueryDto,
  ): Promise<ListEnvelope<PlatformJobRow>> {
    return this.operations.listJobs(query);
  }

  @Get('jobs/heartbeat')
  @RequiresPlatformRole('console.jobs.view')
  @ApiOperation({ summary: 'Worker heartbeat and the age of the oldest pending job' })
  @ApiOkResponse({ description: 'Heartbeat' })
  async heartbeat(): Promise<{ data: WorkerHeartbeat }> {
    return { data: await this.operations.workerHeartbeat() };
  }

  @Post('jobs/:id/retry')
  @RequiresPlatformRole('console.jobs.manage')
  @ApiBody({ schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } })
  @ApiOperation({ summary: 'Return a pending or dead job to the queue (attempts cleared, run-at now)' })
  @ApiOkResponse({ description: 'The job after the retry' })
  @ApiResponse({ status: 422, description: 'Already pending, or already published' })
  async retryJob(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(platformJobActionSchema)) body: PlatformJobAction,
  ): Promise<{ data: PlatformJobRow }> {
    return { data: await this.operations.retryJob(id, body.reason, getAuthContext().userId) };
  }

  @Post('jobs/:id/cancel')
  @RequiresPlatformRole('console.jobs.manage')
  @ApiBody({ schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } })
  @ApiOperation({ summary: 'Mark a job dead so the publisher stops consuming it' })
  @ApiOkResponse({ description: 'The job after the cancellation' })
  @ApiResponse({ status: 422, description: 'Already published' })
  async cancelJob(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(platformJobActionSchema)) body: PlatformJobAction,
  ): Promise<{ data: PlatformJobRow }> {
    return { data: await this.operations.cancelJob(id, body.reason, getAuthContext().userId) };
  }

  // ─────────────────────────────────────────────────────────── الصحة

  @Get('health/detailed')
  @RequiresPlatformRole('console.health.view')
  @ApiOperation({ summary: 'Probes, request rates, queue backlog and the incident banner' })
  @ApiResponse({ status: 200, description: 'Health with six probes' })
  async health(): Promise<{ data: PlatformHealth }> {
    return { data: await this.operations.health() };
  }

  // ─────────────────────────────────────────────────────────── الملفات

  @Get('files')
  @RequiresPlatformRole('console.jobs.view')
  @ApiQuery({ name: 'q', required: false, description: 'File-name fragment' })
  @ApiQuery({ name: 'filter[status]', required: false, description: 'pending | ready | deleted' })
  @ApiQuery({ name: 'filter[tenantId]', required: false })
  @ApiQuery({ name: 'filter[entity]', required: false })
  @ApiQuery({ name: 'filter[scan]', required: false, description: 'clean | infected | skipped | none' })
  @ApiOperation({ summary: 'Cross-tenant file manager with each file’s last scan verdict' })
  @ApiOkResponse({ description: 'File page' })
  async files(
    @Query(new ZodValidationPipe(platformFileQuerySchema)) query: PlatformFileQueryDto,
  ): Promise<ListEnvelope<PlatformFileRow>> {
    return this.operations.listFiles(query);
  }

  @Post('files/:id/scan')
  @RequiresPlatformRole('console.jobs.manage')
  @ApiOperation({ summary: 'Run the configured scanner now and record its verdict' })
  @ApiOkResponse({ description: 'The verdict as it came out of the scanner' })
  @ApiResponse({ status: 404, description: 'No such file' })
  async scan(@Param('id') id: string): Promise<{ data: PlatformFileScanResult }> {
    return { data: await this.operations.scanFile(id, getAuthContext().userId) };
  }

  @Delete('files/:id')
  @RequiresPlatformRole('console.jobs.manage')
  @ApiBody({ schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } })
  @ApiOperation({ summary: 'Quarantine a file (metadata is kept; rows are never deleted)' })
  @ApiOkResponse({ description: 'The file after quarantine' })
  @ApiResponse({ status: 422, description: 'Already quarantined' })
  async purge(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(platformFileActionSchema)) body: PlatformFileAction,
  ): Promise<{ data: PlatformFileRow }> {
    return { data: await this.operations.purgeFile(id, body.reason, getAuthContext().userId) };
  }
}
