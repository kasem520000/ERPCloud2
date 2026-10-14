import { Module } from '@nestjs/common';

import { BankFeedsController } from './bank-feeds.controller.js';
import { BankFeedsService } from './bank-feeds.service.js';

@Module({
  controllers: [BankFeedsController],
  providers: [BankFeedsService],
  exports: [BankFeedsService],
})
export class BankFeedsModule {}
