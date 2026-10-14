import { Module } from '@nestjs/common';

import { PlatformModule } from '../platform/index.js';

import { MarketplaceController } from './marketplace.controller.js';
import { MarketplacePlatformController } from './marketplace-platform.controller.js';
import { MarketplaceService } from './marketplace.service.js';

@Module({
  imports: [PlatformModule],
  controllers: [MarketplaceController, MarketplacePlatformController],
  providers: [MarketplaceService],
  exports: [MarketplaceService],
})
export class MarketplaceModule {}
