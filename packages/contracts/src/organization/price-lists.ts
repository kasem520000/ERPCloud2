import { z } from 'zod';

import { uuidSchema } from '../ids.js';

import {
  currencyCodeSchema,
  moneyStringSchema,
  orgAuditDtoSchema,
  orgListQuerySchema,
  versionSchema,
} from './common.js';

/**
 * Price lists and their items — API_CONTRACT §3, DATABASE_DESIGN §5 (legacy
 * `priceTypes` / `Pricing`).
 *
 * PHASE_05 §4: the `price_list_items.item_id` FK is deferred to PHASE_06, when `items`
 * exists. Until then the column is a validated uuid with no referential check, which is
 * why the DTO documents it as a placeholder rather than pretending it is verified.
 */

export const priceListDtoSchema = orgAuditDtoSchema.extend({
  id: uuidSchema,
  name: z.string(),
  currencyCode: z.string(),
  isDefault: z.boolean(),
  isActive: z.boolean(),
});

export type PriceListDto = z.infer<typeof priceListDtoSchema>;

export const priceListCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    currencyCode: currencyCodeSchema,
    isDefault: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export type PriceListCreate = z.infer<typeof priceListCreateSchema>;

export const priceListUpdateSchema = priceListCreateSchema
  .partial()
  .extend({ version: versionSchema.optional() })
  .strict();

export type PriceListUpdate = z.infer<typeof priceListUpdateSchema>;

export const priceListItemDtoSchema = orgAuditDtoSchema.extend({
  id: uuidSchema,
  priceListId: uuidSchema,
  /** `ValidatedAtRuntime: P06` — no FK to `items` yet. */
  itemId: uuidSchema.nullable(),
  /** R19 — وحدة القياس (NULL = الأساسية). `ItemPrices.UnitID` في الديسكتوب. */
  unitId: uuidSchema.nullable(),
  unitPrice: moneyStringSchema,
  minQty: moneyStringSchema,
});

export type PriceListItemDto = z.infer<typeof priceListItemDtoSchema>;

export const priceListItemUpsertSchema = z
  .object({
    itemId: uuidSchema.nullable().optional(),
    /** R19 — وحدة القياس (NULL = الأساسية). */
    unitId: uuidSchema.nullable().optional(),
    unitPrice: moneyStringSchema,
    /** Quantity break; `0` is the default tier. */
    minQty: moneyStringSchema.optional(),
    version: versionSchema.optional(),
  })
  .strict();

export type PriceListItemUpsert = z.infer<typeof priceListItemUpsertSchema>;

export const PRICE_LIST_FILTERS = ['isActive', 'isDefault', 'currencyCode'] as const;
export const PRICE_LIST_SORT_COLUMNS = ['name', 'createdAt'] as const;
export const PRICE_LIST_ITEM_FILTERS = ['itemId', 'unitId'] as const;
export const PRICE_LIST_ITEM_SORT_COLUMNS = ['minQty', 'createdAt'] as const;

export const priceListListQuerySchema = orgListQuerySchema;
export type PriceListListQueryDto = z.infer<typeof priceListListQuerySchema>;

export const priceListItemListQuerySchema = orgListQuerySchema;
export type PriceListItemListQueryDto = z.infer<typeof priceListItemListQuerySchema>;
