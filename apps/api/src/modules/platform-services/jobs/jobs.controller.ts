import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  outboxListQuerySchema,
  QUEUE_NAMES,
  type ListEnvelope,
  type OutboxJobDto,
  type OutboxListQueryDto,
  type QueueHealthDto,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { getTenantContext, RequiresPermission } from '../../platform/index.js';

import { OutboxService } from './outbox.service.js';
import { QUEUE_PORT, type QueuePort } from './queue.service.js';

/**
 * Background-processing observability (CR-005) — `platform.job.view`.
 *
 * Read-only: jobs are produced by business transactions through the outbox, never by an
 * HTTP call, so there is no "enqueue" endpoint to expose.
 */
@ApiTags('platform-services')
@ApiBearerAuth()
@Controller('jobs')
export class JobsController {
  constructor(
    private readonly outbox: OutboxService,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
  ) {}

  @Get('outbox')
  @RequiresPermission('tenant.job.view')
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiQuery({ name: 'filter[status]', required: false, description: 'pending | published | dead' })
  @ApiQuery({ name: 'filter[queue]', required: false })
  @ApiQuery({ name: 'filter[type]', required: false })
  @ApiOperation({ summary: 'List the transactional outbox of this tenant' })
  @ApiResponse({ status: 200, description: 'Outbox page' })
  async outboxList(
    @Query(new ZodValidationPipe(outboxListQuerySchema)) query: OutboxListQueryDto,
  ): Promise<ListEnvelope<OutboxJobDto>> {
    return this.outbox.list(getTenantContext().tenantId, query);
  }

  @Get('health')
  @RequiresPermission('tenant.job.view')
  @ApiOperation({ summary: 'Queue driver state and this tenant outbox backlog' })
  @ApiResponse({ status: 200, description: 'Queue health' })
  async health(): Promise<{ data: QueueHealthDto }> {
    const counts = await this.outbox.counts(getTenantContext().tenantId);
    return {
      data: {
        enabled: this.queue.isEnabled(),
        driver: this.queue.driver,
        queues: [...QUEUE_NAMES],
        pending: counts.pending,
        dead: counts.dead,
      },
    };
  }
}
