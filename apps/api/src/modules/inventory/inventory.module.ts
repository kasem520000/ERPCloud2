import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module.js';
import { AccountingModule } from '../accounting/accounting.module.js';
import { CatalogModule } from '../organization/catalog/catalog.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { PlatformServicesModule } from '../platform-services/index.js';
import { DeveloperModule } from '../developer/developer.module.js';

import { InventoryController } from './inventory.controller.js';
import { InventoryService } from './inventory.service.js';
import { ManufacturingController } from './manufacturing.controller.js';
import { ProductionOrdersController } from './production-orders.controller.js';
import { ProductionOrdersService } from './production-orders.service.js';
import { WarehouseDocumentsController } from './warehouse-documents.controller.js';
import { WarehouseDocumentsService } from './warehouse-documents.service.js';
import { WmsController } from './wms.controller.js';
import { WmsBomService } from './wms-bom.service.js';

@Module({
  imports: [DatabaseModule, PlatformServicesModule, AccountingModule, OrganizationModule, CatalogModule, DeveloperModule],
  controllers: [InventoryController, WarehouseDocumentsController, ProductionOrdersController, WmsController, ManufacturingController],
  providers: [InventoryService, WarehouseDocumentsService, ProductionOrdersService, WmsBomService],
  exports: [InventoryService, WarehouseDocumentsService, ProductionOrdersService, WmsBomService],
})
export class InventoryModule {}
