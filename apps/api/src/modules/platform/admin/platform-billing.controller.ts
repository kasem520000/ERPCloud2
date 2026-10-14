import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  platformDunningRunSchema,
  platformInvoiceCreateSchema,
  platformInvoiceIssueSchema,
  platformInvoiceListQuerySchema,
  platformInvoicePaySchema,
  platformInvoiceVoidSchema,
  platformPlanEntitlementsUpdateSchema,
  platformPlanInputSchema,
  platformPlanUpdateSchema,
  platformSubscriptionCancelSchema,
  platformSubscriptionChangePlanSchema,
  platformSubscriptionGrantSchema,
  platformSubscriptionPauseSchema,
  platformSubscriptionResumeSchema,
  uuidSchema,
  type PlatformDunningRun,
  type PlatformInvoiceCreate,
  type PlatformInvoiceIssue,
  type PlatformInvoiceListQuery,
  type PlatformInvoicePay,
  type PlatformInvoiceVoid,
  type PlatformPlanEntitlementsUpdate,
  type PlatformPlanInput,
  type PlatformPlanUpdate,
  type PlatformSubscriptionCancel,
  type PlatformSubscriptionChangePlan,
  type PlatformSubscriptionGrant,
  type PlatformSubscriptionPause,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { RequiresPlatformRole } from '../decorators/requires-platform-role.decorator.js';
import { PlatformAdminGuard } from '../guards/platform-admin.guard.js';

import { PlatformBillingService } from './platform-billing.service.js';

/**
 * `/api/v1/platform/*` — P-C4 «الباقات والتراخيص والفوترة».
 *
 * | Route | Code |
 * |---|---|
 * | `GET plans` · `GET plans/entitlement-keys` · `POST plans` · `PATCH plans/:id` · `PUT plans/:id/entitlements` | `console.plans.manage` |
 * | `GET subscriptions` · `POST subscriptions` · `POST subscriptions/:id/change-plan\|pause\|resume\|cancel` | `console.subscriptions.manage` |
 * | `GET invoices` · `GET invoices/:id` · `GET invoices/:id/print` · `POST invoices` · `POST invoices/:id/issue\|pay\|void` | `console.billing.manage` |
 * | `GET dunning` · `POST dunning/:subscription/run` · `GET revenue` | `console.billing.manage` |
 *
 * Three codes, one subject each: what we sell (plans), who holds what (licences), and the
 * money documents themselves. `console.billing.manage` was declared in P-C1 and held by
 * `platform_owner` and `platform_billing` — P-C4 is its first consumer, so an invoice is
 * readable by the two roles that may charge a customer and by nobody else (the auditor
 * stays read-only over tenants and audit, as `platform-console-rbac.spec.ts` pins).
 *
 * Two routes of `PlatformAdminController` moved here **and changed shape**, both recorded in
 * the P-C4 report:
 *
 * - `PATCH plans/:id/active` (toggle, no reason) is replaced by `PATCH plans/:id`
 *   (a partial update that takes the plan's fields **and** a reason) — a plan's price moves
 *   the bill of every customer on it, so it is an act with a why, not a switch.
 * - `POST subscriptions/:id/cancel` (no body) now takes «السبب» and `atPeriodEnd`, so an
 *   immediate cancellation and one that waits for the paid period to end are different
 *   decisions on the same route.
 */
@ApiTags('platform-billing')
@ApiBearerAuth()
@Controller('platform')
@UseGuards(PlatformAdminGuard)
export class PlatformBillingController {
  constructor(private readonly billing: PlatformBillingService) {}

  // ------------------------------------------------------------------ plans

  @Get('plans/entitlement-keys')
  @RequiresPlatformRole('console.plans.manage')
  @ApiOperation({ summary: 'Every entitlement a plan may grant, with its Arabic label and kind' })
  async entitlementKeys() {
    return { data: this.billing.entitlementKeys() };
  }

  @Get('plans')
  @RequiresPlatformRole('console.plans.manage')
  @ApiOperation({ summary: 'Plans with their entitlements, monthly equivalent and live licence count' })
  async listPlans() {
    return { data: await this.billing.listPlans() };
  }

  @Post('plans')
  @HttpCode(201)
  @RequiresPlatformRole('console.plans.manage')
  @ApiOperation({ summary: 'Create a plan, or update the one with the same code' })
  async createPlan(@Body(new ZodValidationPipe(platformPlanInputSchema)) body: PlatformPlanInput) {
    return { data: await this.billing.createPlan(body) };
  }

  @Patch('plans/:id')
  @RequiresPlatformRole('console.plans.manage')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Change a plan’s price or state (reason required; audited with the diff)' })
  async updatePlan(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(platformPlanUpdateSchema)) body: PlatformPlanUpdate,
  ) {
    return { data: await this.billing.updatePlan(id, body) };
  }

  @Put('plans/:id/entitlements')
  @RequiresPlatformRole('console.plans.manage')
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'The plan with its new entitlement set' })
  @ApiOperation({ summary: 'Replace a plan’s entitlements (unknown or duplicated keys are refused)' })
  async setEntitlements(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(platformPlanEntitlementsUpdateSchema))
    body: PlatformPlanEntitlementsUpdate,
  ) {
    return { data: await this.billing.setPlanEntitlements(id, body) };
  }

  // ------------------------------------------------------------------ licences

  @Get('subscriptions')
  @RequiresPlatformRole('console.subscriptions.manage')
  @ApiOperation({ summary: 'Every licence across all customers, with its lifecycle state' })
  async listSubscriptions(@Query('status') status?: string) {
    return { data: await this.billing.listSubscriptions(status) };
  }

  @Post('subscriptions')
  @HttpCode(201)
  @RequiresPlatformRole('console.subscriptions.manage')
  @ApiOperation({ summary: 'Issue a licence (optionally starting with a trial period)' })
  async grantSubscription(
    @Body(new ZodValidationPipe(platformSubscriptionGrantSchema)) body: PlatformSubscriptionGrant,
  ) {
    return { data: await this.billing.grantSubscription(body) };
  }

  @Post('subscriptions/:id/change-plan')
  @HttpCode(200)
  @RequiresPlatformRole('console.subscriptions.manage')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Upgrade or downgrade: prorate the period and draft the document' })
  async changePlan(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(platformSubscriptionChangePlanSchema)) body: PlatformSubscriptionChangePlan,
  ) {
    return { data: await this.billing.changePlan(id, body) };
  }

  @Post('subscriptions/:id/pause')
  @HttpCode(200)
  @RequiresPlatformRole('console.subscriptions.manage')
  @ApiOperation({ summary: 'Pause a licence (reason required; the licence stays live)' })
  async pauseSubscription(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(platformSubscriptionPauseSchema)) body: PlatformSubscriptionPause,
  ) {
    return { data: await this.billing.pauseSubscription(id, body) };
  }

  @Post('subscriptions/:id/resume')
  @HttpCode(200)
  @RequiresPlatformRole('console.subscriptions.manage')
  @ApiOperation({ summary: 'Resume a paused licence and give back the paused days' })
  async resumeSubscription(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(platformSubscriptionResumeSchema)) body: PlatformSubscriptionPause,
  ) {
    return { data: await this.billing.resumeSubscription(id, body) };
  }

  @Post('subscriptions/:id/cancel')
  @HttpCode(200)
  @RequiresPlatformRole('console.subscriptions.manage')
  @ApiOperation({ summary: 'Cancel a licence now or at the end of the paid period (reason required)' })
  async cancelSubscription(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(platformSubscriptionCancelSchema)) body: PlatformSubscriptionCancel,
  ) {
    return { data: await this.billing.cancelSubscription(id, body) };
  }

  // ------------------------------------------------------------------ invoices

  @Get('invoices')
  @RequiresPlatformRole('console.billing.manage')
  @ApiOperation({ summary: 'Subscription invoices and credit notes, newest first' })
  async listInvoices(
    @Query(new ZodValidationPipe(platformInvoiceListQuerySchema)) query: PlatformInvoiceListQuery,
  ) {
    return { data: await this.billing.listInvoices(query) };
  }

  @Get('invoices/:id')
  @RequiresPlatformRole('console.billing.manage')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'One invoice with its lines and payments' })
  async invoice(@Param('id', new ZodValidationPipe(uuidSchema)) id: string) {
    return { data: await this.billing.invoice(id) };
  }

  @Get('invoices/:id/print')
  @RequiresPlatformRole('console.billing.manage')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Printable A4 tax invoice (self-contained HTML, like the staff print pages)' })
  async printInvoice(@Param('id', new ZodValidationPipe(uuidSchema)) id: string) {
    return { html: await this.billing.printInvoice(id) };
  }

  @Post('invoices')
  @HttpCode(201)
  @RequiresPlatformRole('console.billing.manage')
  @ApiOperation({ summary: 'Draft an invoice for a licence period (VAT computed line by line)' })
  async createInvoice(
    @Body(new ZodValidationPipe(platformInvoiceCreateSchema)) body: PlatformInvoiceCreate,
  ) {
    return { data: await this.billing.createInvoice(body) };
  }

  @Post('invoices/:id/issue')
  @HttpCode(200)
  @RequiresPlatformRole('console.billing.manage')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Issue the document: allocate the next number and the due date' })
  async issueInvoice(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(platformInvoiceIssueSchema)) body: PlatformInvoiceIssue,
  ) {
    return { data: await this.billing.issueInvoice(id, body) };
  }

  @Post('invoices/:id/pay')
  @HttpCode(200)
  @RequiresPlatformRole('console.billing.manage')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Record a payment (partial allowed; more than the remainder is refused)' })
  async payInvoice(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(platformInvoicePaySchema)) body: PlatformInvoicePay,
  ) {
    return { data: await this.billing.payInvoice(id, body) };
  }

  @Post('invoices/:id/void')
  @HttpCode(200)
  @RequiresPlatformRole('console.billing.manage')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Void a draft or issued invoice (reason required; a paid one is refused)' })
  async voidInvoice(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(platformInvoiceVoidSchema)) body: PlatformInvoiceVoid,
  ) {
    return { data: await this.billing.voidInvoice(id, body) };
  }

  // ------------------------------------------------------------------ dunning

  @Get('dunning')
  @RequiresPlatformRole('console.billing.manage')
  @ApiOperation({ summary: 'Collection attempts, the ladder in force, and what runs next' })
  async dunning(
    @Query('subscriptionId', new ZodValidationPipe(uuidSchema.optional())) subscriptionId?: string,
  ) {
    return { data: await this.billing.dunningBoard(subscriptionId) };
  }

  @Post('dunning/:subscription/run')
  @HttpCode(200)
  @RequiresPlatformRole('console.billing.manage')
  @ApiParam({ name: 'subscription' })
  @ApiOperation({ summary: 'Schedule the next reminder for every overdue invoice of a licence' })
  async runDunning(
    @Param('subscription', new ZodValidationPipe(uuidSchema)) subscriptionId: string,
    @Body(new ZodValidationPipe(platformDunningRunSchema)) body: PlatformDunningRun,
  ) {
    return { data: await this.billing.runDunning(subscriptionId, body) };
  }

  // ------------------------------------------------------------------ revenue

  @Get('revenue')
  @RequiresPlatformRole('console.billing.manage')
  @ApiOperation({ summary: 'MRR, ARR, what is outstanding and what is overdue' })
  async revenue() {
    return { data: await this.billing.revenue() };
  }
}
