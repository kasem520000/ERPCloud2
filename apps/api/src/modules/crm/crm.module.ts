import { Module } from '@nestjs/common';

import { WhatsappModule } from '../integrations/whatsapp/whatsapp.module.js';
import { PlatformModule } from '../platform/index.js';

import { CrmController } from './crm.controller.js';
import { CrmService } from './crm.service.js';

@Module({
  imports: [PlatformModule, WhatsappModule],
  controllers: [CrmController],
  providers: [CrmService],
})
export class CrmModule {}
