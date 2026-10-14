import { Module } from '@nestjs/common';

import { DeveloperModule } from '../developer/developer.module.js';

import { EinvoicingController } from './einvoicing.controller.js';
import { EinvoicingService } from './einvoicing.service.js';
import { ZatcaOnboardingService } from './zatca-onboarding.service.js';

@Module({
  imports: [DeveloperModule],
  controllers: [EinvoicingController],
  providers: [EinvoicingService, ZatcaOnboardingService],
  exports: [EinvoicingService, ZatcaOnboardingService],
})
export class EinvoicingModule {}
