import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { jobTypes } from '@erp/contracts';

import { JobHandlerRegistry } from '../platform-services/index.js';

import { OcrService } from './ocr.service.js';

@Injectable()
export class OcrJobHandlers implements OnModuleInit {
  constructor(private readonly registry: JobHandlerRegistry, private readonly ocr: OcrService) {}

  onModuleInit(): void {
    this.registry.register('maintenance', jobTypes.OCR_PROCESS, async (context) => {
      const jobId = context.payload.jobId;
      if (typeof jobId !== 'string') throw new Error('ocr.process payload is missing jobId');
      await this.ocr.processJob(context.tenantId, jobId);
    });
  }
}
