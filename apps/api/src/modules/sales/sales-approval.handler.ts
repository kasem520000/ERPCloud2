import { Injectable, type OnModuleInit } from '@nestjs/common';
import { APPROVAL_APPROVED_EVENT } from '@erp/contracts';

import { DomainEventsService } from '../../events/domain-events.service.js';

import { SalesService, type PostingInput } from './sales.service.js';

/** Completes the sales posting only after the final approval transaction commits. */
@Injectable()
export class SalesApprovalHandler implements OnModuleInit {
  constructor(
    private readonly events: DomainEventsService,
    private readonly sales: SalesService,
  ) {}

  onModuleInit(): void {
    this.events.on(APPROVAL_APPROVED_EVENT, async (event) => {
      if (event.payload.entityType !== 'sales_invoice' || !event.tenantId) return;
      const posting =
        event.payload.posting && typeof event.payload.posting === 'object'
          ? (event.payload.posting as PostingInput)
          : {};
      await this.sales.postApproved(event.tenantId, String(event.payload.entityId), posting);
    });
  }
}
