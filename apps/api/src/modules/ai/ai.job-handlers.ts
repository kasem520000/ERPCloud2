import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { jobTypes } from '@erp/contracts';

import { JobHandlerRegistry } from '../platform-services/index.js';

import { AiService } from './ai.service.js';

/** Daily suggestion job on the existing maintenance queue. Idempotent per tenant and day. */
@Injectable()
export class AiJobHandlers implements OnModuleInit {
  private readonly logger = new Logger(AiJobHandlers.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly ai: AiService,
  ) {}

  onModuleInit(): void {
    this.registry.register('maintenance', jobTypes.AI_SUGGEST, async (context) => {
      const result = await this.ai.runDailySuggestions(context.tenantId);
      this.logger.log({ tenantId: context.tenantId, skipped: result.skipped, count: result.suggestions.length }, 'ai suggestions');
    });
  }
}
