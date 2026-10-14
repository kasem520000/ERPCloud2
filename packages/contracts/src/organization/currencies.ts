import { z } from 'zod';

import { uuidSchema } from '../ids.js';

import {
  currencyCodeSchema,
  fxRateStringSchema,
  isoDateSchema,
  orgAuditDtoSchema,
  orgListQuerySchema,
  versionSchema,
} from './common.js';

/**
 * Currencies and FX rates — API_CONTRACT §3, DATABASE_DESIGN §3.
 *
 * `currencies` is keyed by `(tenant_id, code)`: a tenant enables the ISO codes it
 * trades in and marks exactly one of them base. `fx_rates` is an append-style journal —
 * one row per `(pair, effective_from)` — and `resolveFx` reads the latest row on or
 * before the requested date (legacy `Currency_Lastprice`).
 */

export const currencyDtoSchema = orgAuditDtoSchema.extend({
  code: z.string(),
  nameAr: z.string(),
  nameEn: z.string().nullable(),
  minorUnits: z.number().int(),
  isBase: z.boolean(),
  isActive: z.boolean(),
});

export type CurrencyDto = z.infer<typeof currencyDtoSchema>;

export const currencyCreateSchema = z
  .object({
    code: currencyCodeSchema,
    nameAr: z.string().trim().min(1).max(100),
    nameEn: z.string().trim().min(1).max(100).nullable().optional(),
    /** 0 for JPY-style currencies, 3 for KWD/BHD/OMR; 2 elsewhere. */
    minorUnits: z.number().int().min(0).max(4).optional(),
    isBase: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export type CurrencyCreate = z.infer<typeof currencyCreateSchema>;

export const currencyUpdateSchema = currencyCreateSchema
  .omit({ code: true })
  .partial()
  .extend({ version: versionSchema.optional() })
  .strict();

export type CurrencyUpdate = z.infer<typeof currencyUpdateSchema>;

export const fxRateDtoSchema = orgAuditDtoSchema.extend({
  id: uuidSchema,
  fromCode: z.string(),
  toCode: z.string(),
  /** Decimal string, `numeric(20,10)`: 1 `fromCode` = `rate` `toCode`. */
  rate: fxRateStringSchema,
  effectiveFrom: z.string(),
});

export type FxRateDto = z.infer<typeof fxRateDtoSchema>;

export const fxRateCreateSchema = z
  .object({
    fromCode: currencyCodeSchema,
    toCode: currencyCodeSchema,
    rate: fxRateStringSchema,
    effectiveFrom: isoDateSchema,
  })
  .strict()
  .refine((value) => value.fromCode !== value.toCode, {
    message: 'fromCode and toCode must differ',
    path: ['toCode'],
  });

export type FxRateCreate = z.infer<typeof fxRateCreateSchema>;

export const fxRateUpdateSchema = z
  .object({
    rate: fxRateStringSchema.optional(),
    version: versionSchema.optional(),
  })
  .strict();

export type FxRateUpdate = z.infer<typeof fxRateUpdateSchema>;

/** `GET /fx-rates/resolve?from=USD&to=SAR&date=2026-01-31` */
export const fxResolveQuerySchema = z
  .object({
    from: currencyCodeSchema,
    to: currencyCodeSchema,
    date: isoDateSchema.optional(),
  })
  .strict();

export type FxResolveQuery = z.infer<typeof fxResolveQuerySchema>;

export const fxResolutionDtoSchema = z.object({
  fromCode: z.string(),
  toCode: z.string(),
  rate: z.string(),
  /** How the number was obtained — a resolved rate is never silently synthesised. */
  source: z.enum(['identity', 'direct', 'inverse', 'triangulated']),
  effectiveFrom: z.string().nullable(),
  /** The pivot currency used when `source` is `triangulated`. */
  via: z.string().nullable(),
});

export type FxResolutionDto = z.infer<typeof fxResolutionDtoSchema>;

export const CURRENCY_FILTERS = ['isActive', 'isBase'] as const;
export const CURRENCY_SORT_COLUMNS = ['code', 'createdAt'] as const;
export const FX_RATE_FILTERS = ['fromCode', 'toCode'] as const;
export const FX_RATE_SORT_COLUMNS = ['effectiveFrom', 'createdAt'] as const;

export const currencyListQuerySchema = orgListQuerySchema;
export type CurrencyListQueryDto = z.infer<typeof currencyListQuerySchema>;

export const fxRateListQuerySchema = orgListQuerySchema;
export type FxRateListQueryDto = z.infer<typeof fxRateListQuerySchema>;
