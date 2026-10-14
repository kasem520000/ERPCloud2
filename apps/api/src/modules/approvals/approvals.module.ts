import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module.js';
import { DomainEventsModule } from '../../events/domain-events.module.js';
import { PlatformServicesModule } from '../platform-services/platform-services.module.js';

import { ApprovalController } from './approvals.controller.js';
import { ApprovalService } from './approvals.service.js';

@Module({
  imports: [DatabaseModule, DomainEventsModule, PlatformServicesModule],
  controllers: [ApprovalController],
  providers: [ApprovalService],
  exports: [ApprovalService],
})
export class ApprovalModule {}
