import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { ReportingModule } from '../reporting/reporting.module.js';

import { PortalController } from './portal.controller.js';
import { PortalService } from './portal.service.js';

@Module({
  imports: [DatabaseModule, PlatformModule, ReportingModule],
  controllers: [PortalController],
  providers: [PortalService],
  exports: [PortalService],
})
export class PortalModule {}
