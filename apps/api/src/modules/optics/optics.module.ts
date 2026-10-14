import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module.js';

import { OpticsController } from './optics.controller.js';
import { OpticsService } from './optics.service.js';
@Module({ imports: [DatabaseModule], controllers: [OpticsController], providers: [OpticsService] })
export class OpticsModule {}
