import { Module } from '@nestjs/common';

import { CustomFieldsModule } from '../custom-fields/custom-fields.module.js';

import { PartiesController } from './parties.controller.js';
import { PartiesService } from './parties.service.js';
@Module({ imports: [CustomFieldsModule], controllers: [PartiesController], providers: [PartiesService], exports: [PartiesService] })
export class PartiesModule {}
