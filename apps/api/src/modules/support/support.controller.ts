import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
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
  IMPERSONATION_MAX_MINUTES,
  IMPERSONATION_MIN_MINUTES,
  impersonationStartSchema,
  ticketCreateSchema,
  ticketListQuerySchema,
  ticketReplySchema,
  ticketUpdateSchema,
  type ImpersonationSession,
  type ImpersonationStart,
  type ImpersonationStartResult,
  type ListEnvelope,
  type SupportTicket,
  type TicketCreate,
  type TicketDetail,
  type TicketListQueryDto,
  type TicketReply,
  type TicketUpdate,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RequiresPlatformRole } from '../platform/decorators/requires-platform-role.decorator.js';
import { PlatformAdminGuard } from '../platform/guards/platform-admin.guard.js';

import { SupportService } from './support.service.js';

/**
 * P-C8 — سطح الدعم للمشغّل (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
 *
 * الأسماء هي أسماء الخطة: `/platform/tickets` · `PATCH` للتعديل · `/:id/reply` ·
 * `/platform/impersonate` · `/impersonate/sessions` · و`DELETE /impersonate/:id` الذي
 * **يُغلق** الجلسة (`ended_at`) ولا يمسح صفّها — مسحُ من دخل باسم من ليس «إنهاءً».
 *
 * الرمز `console.support.manage` مطلوبٌ على كل مسار هنا: مكتب الدعم عملٌ منصّي، والحارس
 * (`PlatformAdminGuard`) هو من يفرضه — و`@RequiresPlatformPermission` وحدها تصريحٌ لا فرض.
 */
@ApiTags('platform')
@ApiBearerAuth()
@Controller('platform')
@UseGuards(PlatformAdminGuard)
export class SupportController {
  constructor(private readonly support: SupportService) {}

  // ─────────────────────────────────────────────────────────────── التذاكر

  @Get('tickets')
  @RequiresPlatformRole('console.support.manage')
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiQuery({ name: 'filter[status]', required: false, description: 'open | pending | resolved | closed' })
  @ApiQuery({ name: 'filter[priority]', required: false, description: 'low | normal | high | urgent' })
  @ApiQuery({ name: 'filter[tenantId]', required: false })
  @ApiQuery({ name: 'filter[assignedTo]', required: false, description: 'user id, or `none` for unassigned' })
  @ApiOperation({ summary: 'List support tickets across tenants (most urgent, then newest)' })
  @ApiOkResponse({ description: 'Ticket page' })
  async list(
    @Query(new ZodValidationPipe(ticketListQuerySchema)) query: TicketListQueryDto,
  ): Promise<{ data: SupportTicket[]; meta: ListEnvelope<SupportTicket>['meta'] }> {
    return this.support.list(query);
  }

  @Get('tickets/:id')
  @RequiresPlatformRole('console.support.manage')
  @ApiOperation({ summary: 'One ticket with its messages (internal notes included)' })
  @ApiOkResponse({ description: 'Ticket detail' })
  @ApiResponse({ status: 404, description: 'No such ticket' })
  async get(@Param('id') id: string): Promise<{ data: TicketDetail }> {
    return { data: await this.support.get(id) };
  }

  @Post('tickets')
  @RequiresPlatformRole('console.support.manage')
  @ApiOperation({
    summary: 'Open a ticket on behalf of a tenant (the first message is what the customer said)',
  })
  @ApiBody({ schema: { type: 'object' } })
  @ApiOkResponse({ description: 'Created ticket' })
  async create(
    @Body(new ZodValidationPipe(ticketCreateSchema)) body: TicketCreate,
  ): Promise<{ data: TicketDetail }> {
    return { data: await this.support.create(body) };
  }

  @Patch('tickets/:id')
  @RequiresPlatformRole('console.support.manage')
  @ApiOperation({ summary: 'Update status, priority, assignment or category (reason required)' })
  @ApiBody({ schema: { type: 'object' } })
  @ApiOkResponse({ description: 'Updated ticket' })
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ticketUpdateSchema)) body: TicketUpdate,
  ): Promise<{ data: TicketDetail }> {
    return { data: await this.support.update(id, body) };
  }

  @Post('tickets/:id/reply')
  @RequiresPlatformRole('console.support.manage')
  @ApiOperation({ summary: 'Reply to the customer, or add an internal note (isInternal)' })
  @ApiBody({ schema: { type: 'object' } })
  @ApiOkResponse({ description: 'Ticket with the new message' })
  async reply(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ticketReplySchema)) body: TicketReply,
  ): Promise<{ data: TicketDetail }> {
    return { data: await this.support.reply(id, body) };
  }

  @Get('tenants/:tenantId/tickets')
  @RequiresPlatformRole('console.support.manage')
  @ApiOperation({ summary: 'Tickets of one tenant, as the console sees them' })
  @ApiOkResponse({ description: 'Tickets' })
  async listForTenant(@Param('tenantId') tenantId: string): Promise<{ data: SupportTicket[] }> {
    return { data: await this.support.listForTenant(tenantId) };
  }

  // ───────────────────────────────────────────────────── الدخول المؤقّت

  @Post('impersonate')
  @RequiresPlatformRole('console.support.manage')
  @ApiOperation({
    summary: `Break-glass: act as a tenant owner for ${IMPERSONATION_MIN_MINUTES}–${IMPERSONATION_MAX_MINUTES} minutes (reason required)`,
  })
  @ApiBody({ schema: { type: 'object' } })
  @ApiOkResponse({ description: 'Session plus the short-lived token' })
  async impersonate(
    @Body(new ZodValidationPipe(impersonationStartSchema)) body: ImpersonationStart,
  ): Promise<{ data: ImpersonationStartResult }> {
    return { data: await this.support.startImpersonation(body) };
  }

  @Get('impersonate/sessions')
  @RequiresPlatformRole('console.support.manage')
  @ApiOperation({ summary: 'Support sessions (who entered which tenant, why, and for how long)' })
  @ApiOkResponse({ description: 'Sessions' })
  async listImpersonations(): Promise<{ data: ImpersonationSession[] }> {
    return { data: await this.support.listImpersonationSessions() };
  }

  @Delete('impersonate/:id')
  @RequiresPlatformRole('console.support.manage')
  @ApiOperation({
    summary:
      'End a support session — its token stops working on the next request (the row is closed, never deleted)',
  })
  @ApiBody({ schema: { type: 'object' } })
  @ApiOkResponse({ description: 'Ended session' })
  async endImpersonation(@Param('id') id: string): Promise<{ data: ImpersonationSession }> {
    // بلا جسم: `DELETE` يُنهي الجلسة، والسبب يُقيَّد في التدقيق نصّاً معروفاً.
    return { data: await this.support.endImpersonation(id, 'إنهاء الدخول المؤقّت من اللوحة') };
  }
}
