import { Module } from '@nestjs/common';

import { AccountingModule } from '../accounting/accounting.module.js';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module.js';
import { ApprovalModule } from '../approvals/approvals.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { OrganizationModule } from '../organization/organization.module.js';

import { PurchaseNotesController } from './purchase-notes.controller.js';
import { PurchasesApprovalHandler } from './purchases-approval.handler.js';
import { PurchasesController } from './purchases.controller.js';
import { PurchasesService } from './purchases.service.js';

@Module({ imports: [ApprovalModule, AccountingModule, CustomFieldsModule, InventoryModule, OrganizationModule], controllers: [PurchasesController, PurchaseNotesController], providers: [PurchasesService, PurchasesApprovalHandler], exports: [PurchasesService] })
export class PurchasesModule {}
