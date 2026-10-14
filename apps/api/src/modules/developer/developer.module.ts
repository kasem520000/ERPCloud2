import { Module } from '@nestjs/common';

import { PlatformModule } from '../platform/platform.module.js';

import { ApiKeyGuard } from './api-key.guard.js';
import { DeveloperService } from './developer.service.js';
import { IntegrationController } from './integration.controller.js';
import { PlatformDeveloperController } from './platform-developer.controller.js';
import { WebhookPublisher } from './webhook-publisher.service.js';

/**
 * P-C11 — وحدة «بوابة المطوّر».
 *
 * سطحيان في وحدةٍ واحدة، لأن ما يجمعهما أكثر مما يفرّقهما: عقودٌ واحدة، وقاعدةٌ واحدة،
 * وقرارٌ واحد بأن المفتاح نصٌّ لا يُخزَّن وأن الحدث لا يُنتَج بلا مُنتِج.
 *
 * وتُصدِّر `WebhookPublisher` **لا** `DeveloperService` — والفرق جوهريّ: وحدات العميل
 * (المبيعات، نقاط البيع، الفوترة الإلكترونية، المخزون، باقات المنصة) تحتاج أن **تُعلن**
 * حدثاً، لا أن تُنشئ مفتاحاً أو تدوّر اعتماداً. فالواجهة المصدَّرة هي الواجهة التي نريدها،
 * والباقي يبقى داخل الوحدة.
 */
@Module({
  imports: [PlatformModule],
  controllers: [PlatformDeveloperController, IntegrationController],
  providers: [DeveloperService, WebhookPublisher, ApiKeyGuard],
  exports: [DeveloperService, WebhookPublisher],
})
export class DeveloperModule {}
