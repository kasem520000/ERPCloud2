import type { FileDto } from '@erp/contracts';

/** Stable, provider-neutral fields shown by the review screen. */
export type OcrLine = {
  description: string;
  quantity?: string;
  unitPrice?: string;
  taxRate?: string;
  total?: string;
  confidence?: number;
};

export type OcrExtraction = {
  supplierName: string | null;
  supplierTaxNumber: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  subtotal: string | null;
  taxAmount: string | null;
  total: string | null;
  currency: string | null;
  lines: OcrLine[];
  confidenceByField: Record<string, number>;
  confidence: number;
  rawText?: string | null;
};

export type OcrProviderInput = {
  file: Pick<FileDto, 'id' | 'name' | 'mime'>;
  documentUrl: string;
};

export type OcrProviderResult = {
  provider: string;
  payload: unknown;
};

export interface OcrProvider {
  extract(input: OcrProviderInput): Promise<OcrProviderResult>;
}

export const OCR_ENTITY_TYPE = 'purchase_invoice' as const;
export type OcrEntityType = typeof OCR_ENTITY_TYPE;
export type OcrJobStatus = 'queued' | 'processing' | 'done' | 'failed';
