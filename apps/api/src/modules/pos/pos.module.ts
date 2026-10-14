import { Module } from '@nestjs/common';

import { SalesModule } from '../sales/sales.module.js';

import { PosController } from './pos.controller.js';
import { PosService } from './pos.service.js';

@Module({ imports: [SalesModule], controllers: [PosController], providers: [PosService], exports: [PosService] })
export class PosModule {}
