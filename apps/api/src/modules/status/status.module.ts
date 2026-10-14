import { Module } from '@nestjs/common';

import { PlatformOperationsModule } from '../operations/platform-operations.module.js';

import { PublicStatusController } from './public-status.controller.js';
import { PublicStatusService } from './public-status.service.js';

/**
 * P-M9 — وحدة «حالة الخدمة» العامّة.
 *
 * **لماذا وحدةٌ صغيرة بدل حشر المسار في `PlatformOperationsModule`؟** لأن تلك الوحدة تُسجّل
 * مسارات اللوحة بحارسها وصلاحياتها، وهذا المسار **عامٌّ بلا جلسة**: خلطُهما في وحدةٍ واحدة
 * يجعل من يقرأ الشيفرة يسأل «أين حارس هذا الملف؟» في كل مرة. والمشترك بينهما شيءٌ واحد
 * (`PlatformOperationsService`) يُستورَد صريحاً كما يُستورَد غيره.
 */
@Module({
  imports: [PlatformOperationsModule],
  controllers: [PublicStatusController],
  providers: [PublicStatusService],
})
export class StatusModule {}
