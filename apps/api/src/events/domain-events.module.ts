import { Global, Module } from '@nestjs/common';

import { DomainEventsService } from './domain-events.service.js';

/**
 * Global so that a producer (settings, in `modules/platform`) and a consumer
 * (notifications, in `modules/platform-services`) can share one bus without importing
 * each other's module.
 */
@Global()
@Module({
  providers: [DomainEventsService],
  exports: [DomainEventsService],
})
export class DomainEventsModule {}
