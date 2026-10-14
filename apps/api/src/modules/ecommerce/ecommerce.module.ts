import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module.js';
import { DeveloperModule } from '../developer/developer.module.js';
import { PlatformServicesModule } from '../platform-services/platform-services.module.js';
import { SalesModule } from '../sales/sales.module.js';

import { ECOMMERCE_TRANSPORT } from './ecommerce.tokens.js';
import { EcommerceController } from './ecommerce.controller.js';
import { EcommerceEventHandlers } from './ecommerce.events.js';
import { EcommerceJobHandlers } from './ecommerce.job-handlers.js';
import {
  HttpEcommerceTransport,
  EcommerceProviderRegistry,
  MockEcommerceTransport,
} from './ecommerce.providers.js';
import { EcommerceService } from './ecommerce.service.js';

@Module({
  imports: [DatabaseModule, PlatformServicesModule, SalesModule, DeveloperModule],
  controllers: [EcommerceController],
  providers: [
    EcommerceService,
    EcommerceJobHandlers,
    EcommerceEventHandlers,
    EcommerceProviderRegistry,
    MockEcommerceTransport,
    HttpEcommerceTransport,
    { provide: ECOMMERCE_TRANSPORT, useExisting: HttpEcommerceTransport },
  ],
  exports: [EcommerceService, EcommerceProviderRegistry, MockEcommerceTransport],
})
export class EcommerceModule {}
