import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module.js';
import { SalesModule } from '../sales/sales.module.js';

import { MarinaAdditionsService } from './additions.service.js';
import { MarinaDocumentsService } from './booking-documents.service.js';
import { MarinaGroupCardsService } from './group-cards.service.js';
import { MarinaController, MarinaOperationsController } from './marina.controller.js';
import { MarinaService } from './marina.service.js';

/**
 * The operations controller is listed **first**: its `bookings/uninvoiced` is a static
 * path, and the `bookings/:id` of the documents surface would otherwise swallow it —
 * Nest matches in the order the controllers are registered.
 */
@Module({
  imports: [DatabaseModule, SalesModule],
  controllers: [MarinaOperationsController, MarinaController],
  providers: [MarinaService, MarinaDocumentsService, MarinaGroupCardsService, MarinaAdditionsService],
})
export class MarinaModule {}
