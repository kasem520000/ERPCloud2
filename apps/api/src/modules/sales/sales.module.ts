import { Module } from '@nestjs/common';

import { AccountingModule } from '../accounting/accounting.module.js';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module.js';
import { ApprovalModule } from '../approvals/approvals.module.js';
import { DomainEventsModule } from '../../events/domain-events.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { DeveloperModule } from '../developer/developer.module.js';

import { SalesApprovalHandler } from './sales-approval.handler.js';
import { SalesController } from './sales.controller.js';
import { SalesService } from './sales.service.js';

@Module({
  imports: [ApprovalModule, AccountingModule, CustomFieldsModule, InventoryModule, OrganizationModule, DeveloperModule, DomainEventsModule],
  controllers: [SalesController],
  providers: [SalesService, SalesApprovalHandler],
  exports: [SalesService],
})
export class SalesModule {}
