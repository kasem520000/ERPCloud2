import { Module } from '@nestjs/common';

import { CustomFieldsModule } from '../../custom-fields/custom-fields.module.js';

import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';

@Module({ imports: [CustomFieldsModule], controllers: [CatalogController], providers: [CatalogService], exports: [CatalogService] })
export class CatalogModule {}
