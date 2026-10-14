import { Module } from '@nestjs/common';

import { SalesModule } from '../../sales/sales.module.js';

import { WhatsappController } from './whatsapp.controller.js';
import { WhatsappService } from './whatsapp.service.js';

@Module({
  // `SalesModule` — a 💬 press reads the invoice it is sending: its number, its customer,
  // its money. Nothing is written back onto it; the log is the only thing created.
  imports: [SalesModule],
  controllers: [WhatsappController],
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
