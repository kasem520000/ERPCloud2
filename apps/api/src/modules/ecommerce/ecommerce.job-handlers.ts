import { Injectable, type OnModuleInit } from '@nestjs/common';
import { jobTypes } from '@erp/contracts';

import { JobHandlerRegistry } from '../platform-services/index.js';

import { EcommerceService } from './ecommerce.service.js';

@Injectable()
export class EcommerceJobHandlers implements OnModuleInit {
  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly ecommerce: EcommerceService,
  ) {}

  onModuleInit(): void {
    this.registry.register('maintenance', jobTypes.ECOMMERCE_IMPORT, async (context) => {
      const orderId = context.payload.orderId;
      if (typeof orderId !== 'string') throw new Error('ecommerce.import payload is missing orderId');
      await this.ecommerce.processImport(context.tenantId, orderId);
    });
    this.registry.register('maintenance', jobTypes.ECOMMERCE_STOCK, async (context) => {
      const storeId = context.payload.storeId;
      const itemId = context.payload.itemId;
      if (typeof storeId !== 'string' || typeof itemId !== 'string')
        throw new Error('ecommerce.stock payload is missing storeId or itemId');
      await this.ecommerce.processStock(context.tenantId, {
        storeId,
        itemId,
        warehouseId:
          typeof context.payload.warehouseId === 'string' ? context.payload.warehouseId : undefined,
        remoteItemId:
          typeof context.payload.remoteItemId === 'string' ? context.payload.remoteItemId : undefined,
        invoiceId: typeof context.payload.invoiceId === 'string' ? context.payload.invoiceId : undefined,
      });
    });
  }
}
