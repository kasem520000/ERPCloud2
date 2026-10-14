import { Body, Controller, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  contentBannerCreateSchema,
  contentBannerUpdateSchema,
  contentMenuPositions,
  contentMenuUpdateSchema,
  contentPageCreateSchema,
  contentPageListQuerySchema,
  contentPageUpdateSchema,
  contentPublishSchema,
  contentRestoreSchema,
  contentRetractSchema,
  idParamSchema,
  type ContentBanner,
  type ContentBannerCreate,
  type ContentBannerUpdate,
  type ContentMenu,
  type ContentMenuUpdate,
  type ContentPage,
  type ContentPageCreate,
  type ContentPageListQuery,
  type ContentPageUpdate,
  type ContentPublish,
  type ContentVersion,
  type IdParam,
  type ListEnvelope,
} from '@erp/contracts';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RequiresPlatformRole } from '../platform/decorators/requires-platform-role.decorator.js';
import { PlatformAdminGuard } from '../platform/guards/platform-admin.guard.js';

import { ContentService } from './content.service.js';

const positionParamSchema = z.object({ position: z.enum(contentMenuPositions) });
type PositionParam = z.infer<typeof positionParamSchema>;

const versionParamSchema = z.object({ id: idParamSchema.shape.id, version: z.coerce.number().int().positive() });
type VersionParam = z.infer<typeof versionParamSchema>;

/**
 * P-M5 — محرّر المحتوى في لوحة المنصّة.
 *
 * أربعة عشر مساراً، برمزين: **`console.content.view`** للقراءة (ومنها المسوّدات — وهي الفرق
 * عن العامّة)، و**`console.content.manage`** للكتابة والنشر والجدولة والاستعادة. والفصل
 * مقصود: من يراجع النصّ قبل نشره لا يلزمه أن يكون من ينشره (مراجعةٌ لغوية في فريق المحتوى)،
 * ومن ينشر لا يلزمه أن يملك ما يملكه مالك المنصّة من الإعدادات.
 *
 * و**لا مسار حذف**: الصفحة تُسحب إلى `draft` بسببٍ مكتوب، والرابط يبقى محجوزاً كي لا يشير
 * رابطٌ قديم في نتيجة بحثٍ إلى محتوى آخر انتقل إليه.
 */
@ApiTags('platform-content')
@ApiBearerAuth()
@Controller('platform/content')
@UseGuards(PlatformAdminGuard)
export class PlatformContentController {
  constructor(private readonly content: ContentService) {}

  // ── الصفحات

  @Get('pages')
  @RequiresPlatformRole('console.content.view')
  @ApiQuery({ name: 'filter[kind]', required: false })
  @ApiQuery({ name: 'filter[status]', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'sort', required: false, description: 'updated | published | title' })
  @ApiOperation({ summary: 'كل الصفحات — المسوّدات والمجدولة والمنشورة' })
  @ApiOkResponse({ description: 'Content page list' })
  async list(
    @Query(new ZodValidationPipe(contentPageListQuerySchema)) query: ContentPageListQuery,
  ): Promise<ListEnvelope<ContentPage>> {
    return this.content.listPages(query);
  }

  @Get('categories')
  @RequiresPlatformRole('console.content.view')
  @ApiOperation({ summary: 'تصنيفات المدوّنة ومركز المساعدة المشتقّة من المحتوى' })
  async categories(): Promise<{ data: { blog: string[]; help: string[] } }> {
    return { data: await this.content.categories() };
  }

  @Get('menus')
  @RequiresPlatformRole('console.content.view')
  @ApiOperation({ summary: 'القوائم الخمس بمواضعها' })
  async menus(): Promise<{ data: ContentMenu[] }> {
    return { data: await this.content.listMenus() };
  }

  @Put('menus/:position')
  @RequiresPlatformRole('console.content.manage')
  @ApiOperation({ summary: 'كتابة قائمة: العناصر مرتّبة كما تُرسل' })
  async updateMenu(
    @Param(new ZodValidationPipe(positionParamSchema)) params: PositionParam,
    @Body(new ZodValidationPipe(contentMenuUpdateSchema)) body: ContentMenuUpdate,
  ): Promise<{ data: ContentMenu }> {
    return { data: await this.content.updateMenu(params.position, body.items) };
  }

  @Get('banners')
  @RequiresPlatformRole('console.content.view')
  @ApiOperation({ summary: 'اللافتات كلها (ووسم `live` يقول أيّها معروض الآن)' })
  async banners(): Promise<{ data: ContentBanner[] }> {
    return { data: await this.content.listBanners() };
  }

  @Post('banners')
  @RequiresPlatformRole('console.content.manage')
  @ApiOperation({ summary: 'إنشاء لافتة بنافذة عرضٍ وجمهور' })
  async createBanner(
    @Body(new ZodValidationPipe(contentBannerCreateSchema)) body: ContentBannerCreate,
  ): Promise<{ data: ContentBanner }> {
    return { data: await this.content.createBanner(body) };
  }

  @Patch('banners/:id')
  @RequiresPlatformRole('console.content.manage')
  @ApiOperation({ summary: 'تعديل لافتة (الإيقاف بحقل `active`)' })
  async updateBanner(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Body(new ZodValidationPipe(contentBannerUpdateSchema)) body: ContentBannerUpdate,
  ): Promise<{ data: ContentBanner }> {
    return { data: await this.content.updateBanner(params.id, body) };
  }

  @Post('pages')
  @RequiresPlatformRole('console.content.manage')
  @ApiOperation({ summary: 'إنشاء صفحة بكتلها — مسوّدةً أو مجدولةً أو منشورة' })
  async create(
    @Body(new ZodValidationPipe(contentPageCreateSchema)) body: ContentPageCreate,
  ): Promise<{ data: unknown }> {
    return { data: await this.content.createPage(body) };
  }

  @Get('pages/:id')
  @RequiresPlatformRole('console.content.view')
  @ApiOperation({ summary: 'صفحةٌ بكتلها (كما ستُعرض، مسوّدةً كانت أو منشورة)' })
  async get(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
    return { data: await this.content.getPage(params.id) };
  }

  @Patch('pages/:id')
  @RequiresPlatformRole('console.content.manage')
  @ApiOperation({ summary: 'تعديل صفحة — والكتل إن أُرسلت فهي البديل الكامل' })
  async update(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Body(new ZodValidationPipe(contentPageUpdateSchema)) body: ContentPageUpdate,
  ) {
    return { data: await this.content.updatePage(params.id, body) };
  }

  @Post('pages/:id/publish')
  @RequiresPlatformRole('console.content.manage')
  @ApiOperation({ summary: 'نشرٌ فوري، أو جدولةٌ إلى وقتٍ قادم بحقل `at`' })
  async publish(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Body(new ZodValidationPipe(contentPublishSchema)) body: ContentPublish,
  ) {
    return { data: await this.content.publishPage(params.id, body.at ?? null, body.note) };
  }

  @Post('pages/:id/retract')
  @RequiresPlatformRole('console.content.manage')
  @ApiOperation({ summary: 'سحب صفحةٍ من النشر إلى مسوّدة بسببٍ مكتوب (لا حذف)' })
  async retract(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Body(new ZodValidationPipe(contentRetractSchema)) body: { reason: string },
  ) {
    return { data: await this.content.retractPage(params.id, body.reason) };
  }

  @Get('pages/:id/versions')
  @RequiresPlatformRole('console.content.view')
  @ApiOperation({ summary: 'تاريخ الصفحة — أحدث خمسين نسخة' })
  async versions(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
  ): Promise<{ data: ContentVersion[] }> {
    return { data: await this.content.listVersions(params.id) };
  }

  @Post('pages/:id/versions/:version/restore')
  @RequiresPlatformRole('console.content.manage')
  @ApiOperation({ summary: 'استعادة نسخة — وتُحفظ الحالة القائمة نسخةً جديدة قبلها' })
  async restore(
    @Param(new ZodValidationPipe(versionParamSchema)) params: VersionParam,
    @Body(new ZodValidationPipe(contentRestoreSchema.omit({ version: true }))) body: { note?: string },
  ) {
    return { data: await this.content.restoreVersion(params.id, params.version, body.note) };
  }
}
