import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module.js';

import { CustomFieldsController } from './custom-fields.controller.js';
import { CustomFieldsService } from './custom-fields.service.js';
import { CustomReportsController } from './custom-reports.controller.js';
import { CustomReportsService } from './custom-reports.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [CustomFieldsController, CustomReportsController],
  providers: [CustomFieldsService, CustomReportsService],
  exports: [CustomFieldsService, CustomReportsService],
})
export class CustomFieldsModule {}
