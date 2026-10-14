import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  idParamSchema,
  notificationCreateSchema,
  notificationListQuerySchema,
  type IdParam,
  type ListEnvelope,
  type NotificationCreate,
  type NotificationDto,
  type NotificationListQueryDto,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { zodApiBody } from '../../../openapi/zod-api-body.js';
import { getAuthContext } from '../../../request-context/request-context.js';
import { getTenantContext, RequiresPermission } from '../../platform/index.js';

import { NotificationsService } from './notifications.service.js';

/** API_CONTRACT §2 — `GET /notifications`, `POST /notifications/{id}/read` (+ CR-005 create). */
@ApiTags('platform-services')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @RequiresPermission('tenant.notification.view')
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiQuery({ name: 'filter[read]', required: false, description: 'true | false' })
  @ApiQuery({ name: 'filter[type]', required: false })
  @ApiOperation({ summary: 'List the calling membership inbox (newest first)' })
  @ApiResponse({ status: 200, description: 'Notification page' })
  async list(
    @Query(new ZodValidationPipe(notificationListQuerySchema)) query: NotificationListQueryDto,
  ): Promise<ListEnvelope<NotificationDto> & { meta: { unread: number } }> {
    const tenant = getTenantContext();
    const membershipId = getAuthContext().membershipId;
    const page = await this.notifications.list(tenant.tenantId, membershipId, query);
    const unread = await this.notifications.unreadCount(tenant.tenantId, membershipId);
    return { data: page.data, meta: { ...page.meta, unread } };
  }

  @Get(':id')
  @RequiresPermission('tenant.notification.view')
  @ApiOperation({ summary: 'Read one notification of the calling membership' })
  @ApiResponse({ status: 200, description: 'Notification' })
  @ApiResponse({ status: 404, description: 'Not found for this membership' })
  async read(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
  ): Promise<{ data: NotificationDto }> {
    const tenant = getTenantContext();
    return {
      data: await this.notifications.read(tenant.tenantId, getAuthContext().membershipId, params.id),
    };
  }

  @Post()
  @RequiresPermission('tenant.notification.manage')
  @zodApiBody(notificationCreateSchema)
  @ApiOperation({ summary: 'Create a notification for a membership of this tenant' })
  @ApiResponse({ status: 201, description: 'Notification created' })
  @ApiResponse({ status: 422, description: 'Unknown membership in this tenant' })
  async create(
    @Body(new ZodValidationPipe(notificationCreateSchema)) body: NotificationCreate,
  ): Promise<{ data: NotificationDto }> {
    const tenant = getTenantContext();
    return {
      data: await this.notifications.createForTenant(
        tenant.tenantId,
        getAuthContext().membershipId,
        body,
      ),
    };
  }

  @Post(':id/read')
  @RequiresPermission('tenant.notification.view')
  @ApiOperation({ summary: 'Mark a notification read (idempotent)' })
  @ApiResponse({ status: 201, description: 'Notification' })
  @ApiResponse({ status: 404, description: 'Not found for this membership' })
  async markRead(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
  ): Promise<{ data: NotificationDto }> {
    const tenant = getTenantContext();
    return {
      data: await this.notifications.markRead(tenant.tenantId, getAuthContext().membershipId, params.id),
    };
  }
}
