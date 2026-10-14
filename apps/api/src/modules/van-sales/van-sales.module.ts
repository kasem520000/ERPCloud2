import { Module } from '@nestjs/common';

import { AccountingModule } from '../accounting/accounting.module.js';
import { ApprovalModule } from '../approvals/approvals.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { OrganizationModule } from '../organization/index.js';
import { PlatformModule } from '../platform/index.js';
import { PlatformServicesModule } from '../platform-services/index.js';
import { SalesModule } from '../sales/sales.module.js';
import { TreasuryModule } from '../treasury/treasury.module.js';

import { VanSalesController } from './van-sales.controller.js';
import { VanSalesService } from './van-sales.service.js';

@Module({
  imports: [
    PlatformModule,
    PlatformServicesModule,
    OrganizationModule,
    InventoryModule,
    SalesModule,
    TreasuryModule,
    AccountingModule,
    ApprovalModule,
  ],
  controllers: [VanSalesController],
  providers: [VanSalesService],
  exports: [VanSalesService],
})
export class VanSalesModule {}
