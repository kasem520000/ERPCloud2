import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module.js';

import { PrintSettingsService } from './print-settings.service.js';
import { PrintTemplatesService } from './print-templates.service.js';
import { PrinterLinksService } from './printer-links.service.js';
import { ReportLayoutsService } from './report-layouts.service.js';
import { ReportingController } from './reporting.controller.js';
import { ReportingService } from './reporting.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [ReportingController],
  providers: [ReportingService, ReportLayoutsService, PrintTemplatesService, PrintSettingsService, PrinterLinksService],
  exports: [ReportingService, ReportLayoutsService, PrintTemplatesService, PrintSettingsService, PrinterLinksService],
})
export class ReportingModule {}
