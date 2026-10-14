import { Module } from '@nestjs/common';

import { AccountingController } from './accounting.controller.js';
import { AccountingService } from './accounting.service.js';

@Module({
  controllers: [AccountingController],
  providers: [AccountingService],
  exports: [AccountingService],
})
export class AccountingModule {}
