import { Module } from '@nestjs/common';

import { MigrationController } from './migration.controller.js';
import { MigrationService } from './migration.service.js';

@Module({ controllers: [MigrationController], providers: [MigrationService], exports: [MigrationService] })
export class MigrationModule {}
