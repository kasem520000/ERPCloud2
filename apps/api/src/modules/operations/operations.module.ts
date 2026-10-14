import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { PlatformAdminModule } from '../platform/admin/platform-admin.module.js';

import { BackupService } from './backup.service.js';
import { CompanyFilesService } from './company-files.service.js';
import { MaintenanceService } from './maintenance.service.js';
import { OperationsController } from './operations.controller.js';

@Module({
  imports: [DatabaseModule, OrganizationModule, PlatformAdminModule],
  controllers: [OperationsController],
  providers: [BackupService, MaintenanceService, CompanyFilesService],
  exports: [BackupService, MaintenanceService, CompanyFilesService],
})
export class OperationsModule {}
