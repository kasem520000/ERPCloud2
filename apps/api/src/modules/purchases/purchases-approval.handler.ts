import { Injectable, type OnModuleInit } from '@nestjs/common';
import { APPROVAL_APPROVED_EVENT } from '@erp/contracts';

import { DomainEventsService } from '../../events/domain-events.service.js';

import { PurchasesService, type PurchasePostingInput } from './purchases.service.js';

/** Completes the purchase posting only after the final approval transaction commits. */
@Injectable()
export class PurchasesApprovalHandler implements OnModuleInit {
  constructor(
    private readonly events: DomainEventsService,
    private readonly purchases: PurchasesService,
  ) {}

  onModuleInit(): void {
    this.events.on(APPROVAL_APPROVED_EVENT, async (event) => {
      if (event.payload.entityType !== 'purchase_invoice' || !event.tenantId) return;
      const posting =
        event.payload.posting && typeof event.payload.posting === 'object'
          ? (event.payload.posting as PurchasePostingInput)
          : {};
      await this.purchases.postApproved(event.tenantId, String(event.payload.entityId), posting);
    });
  }
}
