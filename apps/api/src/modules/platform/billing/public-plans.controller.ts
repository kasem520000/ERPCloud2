import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { PublicPlan } from '@erp/contracts';

import { Public } from '../decorators/public.decorator.js';

import { PublicPlansService } from './public-plans.service.js';

/**
 * P-M3 — الواجهة العامة للتسعير (`docs/roadmap/MARKETING_SITE_PLAN.md` §5 · P-M3).
 *
 * المسار `public/plans` تحت `@Controller('public')` — أي `GET /public/plans` كما تنصّ الخطة —
 * وهو **غير المصادَق** (`@Public()`): الزائر يقرأ الأسعار قبل أن يملك حساباً، وهذا كل معنى
 * تسعيرٍ معلَن. ولذلك لا يمرّ هذا العنوان على `BillingController` (المسار `/billing/plans`
 * يقرأ `billing_plans` بلا حقوق)، ولا على `PlatformBillingController` (اللوحة: بجلسة مشغّل).
 *
 * ونقطة النهاية `GET` وحدها: صفحة الأسعار تقرأ. كتابة الباقة تبقى في اللوحة وحدها (`POST
 * /platform/plans` · `PUT …/entitlements`)، فلا يفتح الموقع باباً خلفياً على سلّة المنتج.
 */
@ApiTags('public')
@Controller('public')
export class PublicPlansController {
  constructor(private readonly plans: PublicPlansService) {}

  @Public()
  @Get('plans')
  @ApiOperation({
    summary: 'الباقات النشطة بحقوقها بلغتين (مصدر صفحة `/pricing`)',
    description:
      'النشطة فقط، وبلا معرّف مزوّد الدفع، والحقوق بتسمياتها العربية والإنجليزية من سجلّ المنتج. ' +
      'و`meta.vatRatePercent` نسبة الضريبة من إعدادات المنصة — لأن صفحة الأسعار تُخبر الزائر ' +
      'بالضريبة، ولا يجوز أن تقولها من نصٍّ مكتوب في الكود.',
  })
  async list(): Promise<{ data: PublicPlan[]; meta: { vatRatePercent: number; count: number } }> {
    const { plans, vatRatePercent } = await this.plans.publicPricing();
    return { data: plans, meta: { vatRatePercent, count: plans.length } };
  }
}
