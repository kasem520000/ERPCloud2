import { Inject, Injectable } from '@nestjs/common';
import { env } from '@erp/config';
import { and, inArray, isNull } from 'drizzle-orm';
import { platformSettings, withPlatformAdminTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';

import type { OcrProvider, OcrProviderInput, OcrProviderResult } from './ocr.types.js';

const CONFIG_KEYS = ['ocr.provider', 'ocr.endpoint'] as const;
type ProviderName = (typeof CONFIG_KEYS)[number];

type OcrConfig = {
  provider: 'http' | 'mock';
  endpoint?: string;
};

function settingString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Provider adapter. The platform settings catalogue chooses the endpoint/provider, while
 * `OCR_API_KEY` remains a deployment secret and is never stored in a job payload or sent
 * back through the console settings API.
 *
 * The HTTP contract is intentionally small and provider-neutral:
 * `{ documentUrl, fileName, mimeType, languageHints, firstPageOnly }` in; a JSON object
 * containing recognised fields out. `normaliseOcrPayload` is the compatibility boundary
 * for Google/Azure/custom adapters, so the rest of ERPCloud never depends on one vendor.
 */
@Injectable()
export class ConfiguredOcrProvider implements OcrProvider {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  async extract(input: OcrProviderInput): Promise<OcrProviderResult> {
    const config = await this.readConfig();
    if (config.provider === 'mock') return { provider: 'mock', payload: mockPayload(input) };
    if (!config.endpoint) {
      throw new Error('OCR endpoint is not configured; set platform setting ocr.endpoint');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.OCR_TIMEOUT_MS);
    try {
      const response = await fetch(config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(env.OCR_API_KEY ? { authorization: `Bearer ${env.OCR_API_KEY}` } : {}),
        },
        body: JSON.stringify({
          documentUrl: input.documentUrl,
          fileName: input.file.name,
          mimeType: input.file.mime,
          languageHints: ['ar', 'en'],
          firstPageOnly: true,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        throw new Error(`OCR provider returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      }
      return { provider: 'http', payload: (await response.json()) as unknown };
    } finally {
      clearTimeout(timer);
    }
  }

  private async readConfig(): Promise<OcrConfig> {
    const configured = await withPlatformAdminTx(this.database.db, async (tx) =>
      tx
        .select({ key: platformSettings.key, value: platformSettings.value })
        .from(platformSettings)
        .where(and(isNull(platformSettings.tenantId), inArray(platformSettings.key, [...CONFIG_KEYS]))),
    );
    const values = new Map(configured.map((row) => [row.key as ProviderName, row.value]));
    const provider = settingString(values.get('ocr.provider')) ?? env.OCR_PROVIDER;
    const endpoint = settingString(values.get('ocr.endpoint')) ?? env.OCR_ENDPOINT;
    return { provider: provider === 'mock' ? 'mock' : 'http', endpoint };
  }
}

/** A visible, explicitly selected fixture provider for staging and contract tests. */
function mockPayload(input: OcrProviderInput): Record<string, unknown> {
  return {
    supplierName: 'OCR demo supplier',
    invoiceNumber: `DEMO-${input.file.id.slice(0, 8)}`,
    invoiceDate: new Date().toISOString().slice(0, 10),
    subtotal: '100.00',
    taxAmount: '15.00',
    total: '115.00',
    currency: 'SAR',
    confidence: 0.75,
    confidenceByField: {
      supplierName: 0.75,
      invoiceNumber: 0.75,
      invoiceDate: 0.75,
      subtotal: 0.75,
      taxAmount: 0.75,
      total: 0.75,
    },
    lines: [],
  };
}
