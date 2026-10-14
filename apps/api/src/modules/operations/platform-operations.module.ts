import { Module } from '@nestjs/common';

import { OpsModule } from '../../ops/ops.module.js';
import { PlatformModule } from '../platform/platform.module.js';

import { PlatformOperationsController } from './platform-operations.controller.js';
import { PlatformOperationsService } from './platform-operations.service.js';

/**
 * P-C9 — وحدة «العمليات»: الطابور وصحة الخدمة ومدير الملفات.
 *
 * **لماذا ملفٌّ خاصّ بالمنصة ولا يُرمى في `platform-admin`؟** لأن هذه الوحدة تقرأ أربع
 * خدماتٍ مشتركة (`QUEUE_PORT` · `OBJECT_STORAGE` · `VIRUS_SCANNER` · `MetricsService`)
 * وواحدة منها (`MetricsService`) في `OpsModule` لا في `PlatformServicesModule` — فالتبعية
 * تُعلَن هنا صريحةً بدل أن تصير دَيناً في وحدةٍ ضخمة. و`PlatformModule` يجلب الحارس
 * والتدقيق كما في الدعم (P-C8).
 */
@Module({
  imports: [PlatformModule, OpsModule],
  controllers: [PlatformOperationsController],
  providers: [PlatformOperationsService],
  exports: [PlatformOperationsService],
})
export class PlatformOperationsModule {}
