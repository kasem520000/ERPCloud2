import { Module } from '@nestjs/common';

import { PlatformModule } from '../platform/platform.module.js';

import { DashboardsController } from './dashboards.controller.js';
import { DashboardsService } from './dashboards.service.js';

@Module({
  imports: [PlatformModule],
  controllers: [DashboardsController],
  providers: [DashboardsService],
  exports: [DashboardsService],
})
export class DashboardsModule {}
