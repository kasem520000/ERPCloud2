import { Module } from '@nestjs/common';

import { MetricsController } from './metrics.controller.js';
import { MetricsService } from './metrics.service.js';
import { RetentionService } from './retention.service.js';

@Module({ controllers: [MetricsController], providers: [MetricsService, RetentionService], exports: [MetricsService, RetentionService] })
export class OpsModule {}
