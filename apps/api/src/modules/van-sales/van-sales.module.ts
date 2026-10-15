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
import { VanSalesCustodyService } from './van-sales-custody.service.js';
import { VanSalesDocumentsService } from './van-sales-documents.service.js';
import { VanSalesLegacyService } from './van-sales-legacy.service.js';
import { VanSalesLoadOrdersService } from './van-sales-load-orders.service.js';
import { VanSalesPricingService } from './van-sales-pricing.service.js';
import { VanSalesProductionService } from './van-sales-production.service.js';
import { VanSalesReportingService } from './van-sales-reporting.service.js';
import { VanSalesSharedService } from './van-sales-shared.service.js';

const VAN_SALES_SERVICES = [
  VanSalesSharedService,
  VanSalesReportingService,
  VanSalesPricingService,
  VanSalesProductionService,
  VanSalesLoadOrdersService,
  VanSalesDocumentsService,
  VanSalesCustodyService,
  VanSalesLegacyService,
];

/**
 * M1 decomposition (see ./README.md): the former 6.5k-line VanSalesService is split into
 * cohesive saga/read services behind the SAME controller routes — pure code movement, no
 * behavior change. All services are exported for the upcoming rep backend (M3).
 */
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
  providers: VAN_SALES_SERVICES,
  exports: VAN_SALES_SERVICES,
})
export class VanSalesModule {}
