import { z } from 'zod';

import { uuidSchema } from '../ids.js';

import {
  nationalAddressSchema,
  orgAuditDtoSchema,
  orgCodeSchema,
  orgListQuerySchema,
  versionSchema,
} from './common.js';

/**
 * Branches — API_CONTRACT §3, DATABASE_DESIGN §5 (`Branches` in the legacy schema).
 *
 * A branch is the org node every document is dated and numbered against, and the unit
 * a membership's `branch_scope` restricts (MULTI_TENANCY §2). `is_default` is
 * single-valued per tenant and maintained transactionally by the service.
 */

export const branchDtoSchema = orgAuditDtoSchema.extend({
  id: uuidSchema,
  code: z.string(),
  nameAr: z.string(),
  nameEn: z.string().nullable(),
  address: nationalAddressSchema.nullable(),
  phone: z.string().nullable(),
  mobile: z.string().nullable(),
  email: z.string().nullable(),
  isDefault: z.boolean(),
  isActive: z.boolean(),
});

export type BranchDto = z.infer<typeof branchDtoSchema>;

export const branchCreateSchema = z
  .object({
    code: orgCodeSchema,
    nameAr: z.string().trim().min(1).max(200),
    nameEn: z.string().trim().min(1).max(200).nullable().optional(),
    address: nationalAddressSchema.nullable().optional(),
    phone: z.string().trim().max(32).nullable().optional(),
    mobile: z.string().trim().max(32).nullable().optional(),
    email: z.string().trim().email().max(320).nullable().optional(),
    isDefault: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export type BranchCreate = z.infer<typeof branchCreateSchema>;

/**
 * `code` is deliberately absent: a branch code is referenced by printed documents and
 * by the migration mapping tables, so renaming it is an ADR-level change, not a PATCH
 * (PROJECT_CONTRACT §5, "no feature deletion / silent renames").
 */
export const branchUpdateSchema = branchCreateSchema
  .omit({ code: true })
  .partial()
  .extend({ version: versionSchema.optional() })
  .strict();

export type BranchUpdate = z.infer<typeof branchUpdateSchema>;

export const BRANCH_FILTERS = ['isActive', 'isDefault'] as const;
export const BRANCH_SORT_COLUMNS = ['code', 'nameAr', 'createdAt'] as const;

export const branchListQuerySchema = orgListQuerySchema;
export type BranchListQueryDto = z.infer<typeof branchListQuerySchema>;
