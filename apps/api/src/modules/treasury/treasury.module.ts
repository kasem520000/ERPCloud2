import { Module } from '@nestjs/common';

import { AccountingModule } from '../accounting/accounting.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { DeveloperModule } from '../developer/developer.module.js';

import { TreasuryController } from './treasury.controller.js';
import { TreasuryService } from './treasury.service.js';

@Module({
  imports: [AccountingModule, OrganizationModule, DeveloperModule],
  controllers: [TreasuryController],
  providers: [TreasuryService],
  exports: [TreasuryService],
})
export class TreasuryModule {}
