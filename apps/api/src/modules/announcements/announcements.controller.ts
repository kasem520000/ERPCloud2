import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  announcementCreateSchema,
  announcementListQuerySchema,
  announcementPublishSchema,
  announcementReadsQuerySchema,
  announcementUpdateSchema,
  idParamSchema,
  type Announcement,
  type AnnouncementCreate,
  type AnnouncementListQuery,
  type AnnouncementPublish,
  type AnnouncementReadRow,
  type AnnouncementUpdate,
  type IdParam,
  type ListEnvelope,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { PlatformAdminGuard } from '../platform/guards/platform-admin.guard.js';
import { RequiresPlatformRole } from '../platform/decorators/requires-platform-role.decorator.js';

import { AnnouncementsService } from './announcements.service.js';

/**
 * P-C7 — `docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4: خمسة مسارات كما نصّت الخطة.
 *
 * الرمز واحد (`console.notifications.manage`) للقراءة والكتابة، كما سمّته الخطة: الإعلان
 * ليس بيانات عميل تُقرأ في سياق آخر، بل مستند المنصة إلى عملائها — ومَن يكتبه هو مَن يراجعه.
 */
@ApiTags('platform')
@ApiBearerAuth()
@Controller('platform/announcements')
@UseGuards(PlatformAdminGuard)
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  @RequiresPlatformRole('console.notifications.manage')
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiQuery({ name: 'filter[status]', required: false, description: 'draft | scheduled | published' })
  @ApiQuery({ name: 'filter[audience]', required: false, description: 'all | plan | status' })
  @ApiOperation({ summary: 'List announcements (newest first); publishes what has come due' })
  @ApiOkResponse({ description: 'Announcement page' })
  async list(
    @Query(new ZodValidationPipe(announcementListQuerySchema)) query: AnnouncementListQuery,
  ): Promise<ListEnvelope<Announcement>> {
    return this.announcements.list(query);
  }

  @Post()
  @RequiresPlatformRole('console.notifications.manage')
  @ApiOperation({ summary: 'Write an announcement (draft, or scheduled with publishAt)' })
  @ApiOkResponse({ description: 'Announcement created' })
  async create(
    @Body(new ZodValidationPipe(announcementCreateSchema)) body: AnnouncementCreate,
  ): Promise<{ data: Announcement }> {
    return { data: await this.announcements.create(body) };
  }

  @Patch(':id')
  @RequiresPlatformRole('console.notifications.manage')
  @ApiOperation({ summary: 'Edit a draft or a scheduled announcement (published ones are frozen)' })
  @ApiOkResponse({ description: 'Announcement updated' })
  async update(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Body(new ZodValidationPipe(announcementUpdateSchema)) body: AnnouncementUpdate,
  ): Promise<{ data: Announcement }> {
    return { data: await this.announcements.update(params.id, body) };
  }

  @Post(':id/publish')
  @RequiresPlatformRole('console.notifications.manage')
  @ApiOperation({ summary: 'Publish now and fan out (idempotent: replays only fill the gaps)' })
  @ApiOkResponse({ description: 'Announcement published (replays only fill the gaps)' })
  async publish(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Body(new ZodValidationPipe(announcementPublishSchema)) body: AnnouncementPublish,
  ): Promise<{ data: Announcement }> {
    return { data: await this.announcements.publish(params.id, body.reason) };
  }

  @Get(':id/reads')
  @RequiresPlatformRole('console.notifications.manage')
  @ApiOperation({ summary: 'Delivery follow-up per tenant: in-app, e-mail, reads' })
  @ApiOkResponse({ description: 'One row per targeted tenant' })
  async reads(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Query(new ZodValidationPipe(announcementReadsQuerySchema)) query: { limit: number; offset: number },
  ): Promise<ListEnvelope<AnnouncementReadRow>> {
    return this.announcements.reads(params.id, query);
  }
}
