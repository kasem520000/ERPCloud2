import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module.js';
import { TreasuryModule } from '../treasury/treasury.module.js';

import { TailoringController } from './tailoring.controller.js';
import { TailoringService } from './tailoring.service.js';
@Module({
  imports: [DatabaseModule, TreasuryModule],
  controllers: [TailoringController],
  providers: [TailoringService],
})
export class TailoringModule {}
