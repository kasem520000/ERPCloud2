import { Body, Controller, Get, Post, Param, Req, HttpCode, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DomainError } from '@erp/contracts';

import { Public } from '../decorators/public.decorator.js';
import { RequiresPlatformRole } from '../decorators/requires-platform-role.decorator.js';
import { PlatformAdminGuard } from '../guards/platform-admin.guard.js';

import { BillingService } from './billing.service.js';

/**
 * المسار القديم للفوترة (`/billing/*`) — لايزال له مستهلكون: `apps/staff/app/support/license`
 * تقرأ الرخصة والباقات وتُنشئ طلب تفعيل، و`apps/marketing` تقرأ الباقات عبر
 * `PublicPlansController`. فلا يُزال، بل يُضبط:
 *
 *   • AUD-04 — `POST /billing/webhook` كان **غير عامّ** بلا `@Public()`، فيرفضه `AuthGuard`
 *     بـ401 قبل أن يصل إلى التحقّق من التوقيع: أي أن Stripe لا تستطيع تسليم أي حدث. صار
 *     المسار عاماً، والتوقيع هو بيانات الاعتماد (لا تُقبل نوبة قبل `constructEvent` على
 *     البايتات الخام — `main.ts` يفعّل `rawBody`).
 *   • AUD-05 — مسارات المنصّة (`activation-requests` ومراجعتها) كانت تكتفي بفحص
 *     `isPlatformAdmin` داخل الخدمة بلا حارس دقيق؛ صارت خلف `PlatformAdminGuard` مع
 *     صلاحية المنصّة المطابقة لنظيرها الحديث في اللوحة (`console.subscriptions.manage`).
 */
@ApiTags('billing')
@ApiBearerAuth()
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Public()
  @Get('plans')
  @ApiOperation({ summary: 'List active subscription plans' })
  async plans() {
    return { data: await this.billing.listActivePlans() };
  }

  @Public()
  @Post('webhook')
  @HttpCode(200)
  @ApiOperation({ summary: 'Receive Stripe subscription events (signature is the credential)' })
  @ApiResponse({ status: 401, description: 'Missing or invalid Stripe signature' })
  @ApiResponse({ status: 200, description: 'Event accepted or already processed (duplicate)' })
  async webhook(@Req() request: Request) {
    const signature = request.headers['stripe-signature'];
    const rawBody = (request as Request & { rawBody?: Buffer }).rawBody;
    if (typeof signature !== 'string' || !rawBody) {
      throw new DomainError('BILLING_SIGNATURE_REQUIRED', 'Stripe signature is required', 401);
    }
    return { data: await this.billing.handleStripeWebhook(rawBody, signature) };
  }

  @Post('checkout')
  @ApiOperation({ summary: 'Create a Stripe subscription checkout session' })
  async checkout(@Body() body: { planId: string }) {
    return { data: await this.billing.createStripeCheckout(body.planId) };
  }

  @Post('activation-requests')
  @ApiOperation({ summary: 'Request manual tenant activation' })
  async requestActivation(@Body() body: { planId: string; notes?: string }) {
    return { data: await this.billing.requestManualActivation(body.planId, body.notes) };
  }

  @Get('subscription')
  @ApiOperation({ summary: 'Read the current tenant subscription' })
  async subscription() {
    return { data: await this.billing.mySubscription() };
  }

  @Get('activation-requests')
  @UseGuards(PlatformAdminGuard)
  @RequiresPlatformRole('console.subscriptions.manage')
  @ApiOperation({ summary: 'List pending activation requests for platform admins' })
  async activationRequests() {
    return { data: await this.billing.listActivationRequests() };
  }

  @Post('activation-requests/:id/review')
  @UseGuards(PlatformAdminGuard)
  @RequiresPlatformRole('console.subscriptions.manage')
  @ApiOperation({ summary: 'Approve or reject a manual activation request' })
  async review(
    @Param('id') id: string,
    @Body() body: { approve: boolean; notes?: string },
  ) {
    return { data: await this.billing.reviewActivation(id, body.approve, body.notes) };
  }
}
