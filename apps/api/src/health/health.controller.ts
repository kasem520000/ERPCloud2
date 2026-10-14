import { Controller, Get } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';
import { Public } from '../modules/platform/decorators/public.decorator.js';

/**
 * Ops probes. They sit outside the versioned contract (excluded from the `api/v1` prefix
 * in `bootstrap.ts`) and are `@Public()` because a load balancer or kubelet must reach
 * them without a tenant access token. `/health/live` never touches the database;
 * `/health/ready` reports the pool state so a failing dependency is visible to the
 * orchestrator rather than hidden behind a green liveness probe.
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly databaseService: DatabaseService) {}

  @Get('live')
  live() {
    return { status: 'ok', service: 'api' };
  }

  @Get('ready')
  async ready() {
    const dbReady = await this.databaseService.checkConnection();
    return {
      status: dbReady ? 'ok' : 'degraded',
      checks: {
        database: dbReady ? 'connected' : 'unavailable',
        process: 'running',
        memory: process.memoryUsage().heapUsed > 0 ? 'ok' : 'unknown',
      },
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }
}
