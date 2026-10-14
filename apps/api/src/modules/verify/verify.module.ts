import { Module } from '@nestjs/common';

import { PublicVerifyController } from './public-verify.controller.js';
import { VerifyService } from './verify.service.js';

/**
 * P-M8 — وحدة التحقّق العام (`docs/roadmap/MARKETING_SITE_PLAN.md` §5 P-M8).
 *
 * وحدةٌ صغيرة عن قصد، وبلا استيراد `PlatformModule`: لا رمز صلاحية فيها ولا شاشة لوحة — مسارٌ
 * عامٌّ واحد (`POST /public/verify`) يقرأ حالة الفاتورة من `sales_invoices` في معاملة بسياق
 * المنصّة (`withPlatformAdminTx`)، والقرار وتبريره في رأس `verify.service.ts`.
 *
 * و`DatabaseModule` عالميّة (`@Global`)، فالوصول إلى القاعدة بلا استيراد — كما تفعل وحدة
 * الفاتورة الإلكترونية.
 */
@Module({
  controllers: [PublicVerifyController],
  providers: [VerifyService],
  exports: [VerifyService],
})
export class VerifyModule {}
