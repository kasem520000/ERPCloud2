import { Module } from '@nestjs/common';

import { PurchasesModule } from '../purchases/purchases.module.js';

import { ConfiguredOcrProvider } from './ocr.provider.js';
import { OcrController, OcrPurchaseInvoicesController } from './ocr.controller.js';
import { OcrJobHandlers } from './ocr.job-handlers.js';
import { OcrService } from './ocr.service.js';
import { OCR_PROVIDER } from './ocr.tokens.js';

@Module({
  imports: [PurchasesModule],
  controllers: [OcrController, OcrPurchaseInvoicesController],
  providers: [
    OcrService,
    OcrJobHandlers,
    ConfiguredOcrProvider,
    { provide: OCR_PROVIDER, useExisting: ConfiguredOcrProvider },
  ],
  exports: [OcrService],
})
export class OcrModule {}
