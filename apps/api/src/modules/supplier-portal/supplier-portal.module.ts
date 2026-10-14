import { Module } from '@nestjs/common';

import { PlatformModule } from '../platform/platform.module.js';

import { EsignController, SupplierPortalController } from './supplier-portal.controller.js';
import { SupplierPortalService } from './supplier-portal.service.js';

@Module({
  imports: [PlatformModule],
  controllers: [SupplierPortalController, EsignController],
  providers: [SupplierPortalService],
  exports: [SupplierPortalService],
})
export class SupplierPortalModule {}
