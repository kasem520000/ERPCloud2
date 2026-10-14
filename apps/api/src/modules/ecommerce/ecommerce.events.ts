import { Injectable, type OnModuleInit } from '@nestjs/common';

import { DomainEventsService } from '../../events/domain-events.service.js';

import { EcommerceService } from './ecommerce.service.js';

/** Bridges the sales domain event to the existing maintenance outbox. */
@Injectable()
export class EcommerceEventHandlers implements OnModuleInit {
  constructor(
    private readonly events: DomainEventsService,
    private readonly ecommerce: EcommerceService,
  ) {}

  onModuleInit(): void {
    this.events.on('sales.invoice.posted', (event) => this.ecommerce.enqueueStockForPostedSale(event));
  }
}
