import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module.js';
import { PlatformServicesModule } from '../platform-services/index.js';
import { TreasuryModule } from '../treasury/treasury.module.js';

import { InstallmentsController } from './installments.controller.js';
import { InstallmentsService } from './installments.service.js';

@Module({ imports: [DatabaseModule, PlatformServicesModule, TreasuryModule], controllers: [InstallmentsController], providers: [InstallmentsService], exports: [InstallmentsService] })
export class InstallmentsModule {}
