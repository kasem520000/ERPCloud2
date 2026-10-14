import { Module } from '@nestjs/common';

import { WhatsappModule } from '../integrations/whatsapp/whatsapp.module.js';
import { SalesModule } from '../sales/sales.module.js';
import { TreasuryModule } from '../treasury/treasury.module.js';

import { PaymentLinksController } from './payment-links.controller.js';
import { PaymentLinksService } from './payment-links.service.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';

@Module({
  // `SalesModule` for one reason: an approved 💳 is money in, and it lands on the invoice
  // through `SalesService.addPayment` — the same call `POST sales/invoices/:id/payments`
  // makes, with `method: 'card'`. Online links reuse that path and also write a سند قبض.
  imports: [SalesModule, TreasuryModule, WhatsappModule],
  controllers: [PaymentsController, PaymentLinksController],
  providers: [PaymentsService, PaymentLinksService],
  exports: [PaymentsService, PaymentLinksService],
})
export class PaymentsModule {}
