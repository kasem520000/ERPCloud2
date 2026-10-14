import { Module } from '@nestjs/common';

import { PlatformModule } from '../platform/platform.module.js';
import { PlatformServicesModule } from '../platform-services/platform-services.module.js';

import { SupportController } from './support.controller.js';
import { SupportService } from './support.service.js';
import { TenantSupportController } from './tenant-support.controller.js';

/**
 * P-C8 — وحدة مكتب الدعم والدخول المؤقّت.
 *
 * `PlatformModule` يجلب حارس سطح المنصة و`TokenService` (إصدار رمز الدخول المؤقّت)،
 * و`PlatformServicesModule` يجلب التدقيق. وتعتمد عليها وحدة لوحة المنصة لتُركَّب مساراتها
 * في التطبيق — بنفس نمط الإعلانات (P-C7).
 */
@Module({
  imports: [PlatformModule, PlatformServicesModule],
  controllers: [SupportController, TenantSupportController],
  providers: [SupportService],
  exports: [SupportService],
})
export class SupportModule {}
