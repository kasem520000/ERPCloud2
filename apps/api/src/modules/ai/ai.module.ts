import { Module } from '@nestjs/common';

import { PlatformModule } from '../platform/index.js';
import { PlatformServicesModule } from '../platform-services/index.js';

import { AiController } from './ai.controller.js';
import { AiJobHandlers } from './ai.job-handlers.js';
import { AiPlatformController } from './ai-platform.controller.js';
import { AiService } from './ai.service.js';

@Module({
  imports: [PlatformModule, PlatformServicesModule],
  controllers: [AiController, AiPlatformController],
  providers: [AiService, AiJobHandlers],
  exports: [AiService],
})
export class AiModule {}
