import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module.js';

import { FitmentController } from './fitment.controller.js';
import { FitmentService } from './fitment.service.js';
@Module({ imports: [DatabaseModule], controllers: [FitmentController], providers: [FitmentService] })
export class FitmentModule {}
