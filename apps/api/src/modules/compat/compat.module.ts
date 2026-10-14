import { Module } from '@nestjs/common';

import { SalesModule } from '../sales/sales.module.js';
import { TreasuryModule } from '../treasury/treasury.module.js';

import { CompatController } from './compat.controller.js';
import { CompatService } from './compat.service.js';

@Module({ imports: [SalesModule, TreasuryModule], controllers: [CompatController], providers: [CompatService], exports: [CompatService] })
export class CompatModule {}
