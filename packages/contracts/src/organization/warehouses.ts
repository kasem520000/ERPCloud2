import { z } from 'zod';

import { uuidSchema } from '../ids.js';

import { orgAuditDtoSchema, orgCodeSchema, orgListQuerySchema, versionSchema } from './common.js';

/**
 * Warehouses — API_CONTRACT §3, DATABASE_DESIGN §5 (legacy `Stocks`).
 *
 * `inventoryAccountId` is a plain uuid until PHASE_07 creates `accounts`; the FK and the
 * "must be a postable inventory account" rule are added by that phase
 * (`ValidatedAtRuntime: P07`, PHASE_05 §4).
 */

export const warehouseDtoSchema = orgAuditDtoSchema.extend({
  id: uuidSchema,
  branchId: uuidSchema,
  code: z.string(),
  name: z.string(),
  inventoryAccountId: uuidSchema.nullable(),
  isDefault: z.boolean(),
  isActive: z.boolean(),
});

export type WarehouseDto = z.infer<typeof warehouseDtoSchema>;

export const warehouseCreateSchema = z
  .object({
    branchId: uuidSchema,
    code: orgCodeSchema,
    name: z.string().trim().min(1).max(200),
    inventoryAccountId: uuidSchema.nullable().optional(),
    isDefault: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export type WarehouseCreate = z.infer<typeof warehouseCreateSchema>;

export const warehouseUpdateSchema = warehouseCreateSchema
  .omit({ code: true })
  .partial()
  .extend({ version: versionSchema.optional() })
  .strict();

export type WarehouseUpdate = z.infer<typeof warehouseUpdateSchema>;

export const WAREHOUSE_FILTERS = ['isActive', 'isDefault', 'branchId'] as const;
export const WAREHOUSE_SORT_COLUMNS = ['code', 'name', 'createdAt'] as const;

export const warehouseListQuerySchema = orgListQuerySchema;
export type WarehouseListQueryDto = z.infer<typeof warehouseListQuerySchema>;
