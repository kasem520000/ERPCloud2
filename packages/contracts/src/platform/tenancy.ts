import { z } from 'zod';

import { uuidSchema } from '../ids.js';
import { paginationQuerySchema } from '../pagination.js';

import { membershipStatusSchema } from './auth.js';
import { discountLimitFields } from './discount-limits.js';

/**
 * Tenancy & Access DTOs — API_CONTRACT §2.
 * Write schemas are `.strict()`: unknown keys are rejected, never ignored
 * (SECURITY_ARCHITECTURE §6, mass-assignment defence).
 */

export const tenantStatusSchema = z.enum(['active', 'suspended', 'archived']);
export type TenantStatus = z.infer<typeof tenantStatusSchema>;

export const tenantDtoSchema = z.object({
  id: uuidSchema,
  code: z.string(),
  name: z.string(),
  status: tenantStatusSchema,
  baseCurrency: z.string().length(3),
  timezone: z.string(),
  locale: z.string(),
  countryCode: z.string().length(2),
  settings: z.record(z.union([z.string(), z.boolean(), z.number(), z.null()])),
});

export type TenantDto = z.infer<typeof tenantDtoSchema>;

export const tenantPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    locale: z.string().trim().min(2).max(16).optional(),
    settings: z.record(z.unknown()).optional(),
  })
  .strict();

export type TenantPatch = z.infer<typeof tenantPatchSchema>;

export const settingValueSchema = z
  .object({
    value: z.union([z.string(), z.boolean(), z.number(), z.null()]),
  })
  .strict();

export type SettingValueRequest = z.infer<typeof settingValueSchema>;

/** MULTI_TENANCY §2 — `null` branch scope means "all branches". */
export const branchScopeSchema = z.union([z.array(uuidSchema).min(1), z.null()]);

export const membershipCreateSchema = z
  .object({
    email: z.string().trim().email().max(320),
    fullName: z.string().trim().min(1).max(200).optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
    branchScope: branchScopeSchema.optional(),
    roleIds: z.array(uuidSchema).min(1),
    ...discountLimitFields,
  })
  .strict();

export type MembershipCreate = z.infer<typeof membershipCreateSchema>;

export const membershipUpdateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200).optional(),
    branchScope: branchScopeSchema.optional(),
    status: membershipStatusSchema.optional(),
    roleIds: z.array(uuidSchema).min(1).optional(),
    ...discountLimitFields,
  })
  .strict();

export type MembershipUpdate = z.infer<typeof membershipUpdateSchema>;

export const roleCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).optional(),
    permissionCodes: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type RoleCreate = z.infer<typeof roleCreateSchema>;

export const roleUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    permissionCodes: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type RoleUpdate = z.infer<typeof roleUpdateSchema>;

export const rolePermissionsSchema = z
  .object({
    permissionCodes: z.array(z.string().min(1)),
  })
  .strict();

export type RolePermissionsRequest = z.infer<typeof rolePermissionsSchema>;

export const roleDetailDtoSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  description: z.string().nullable(),
  isSystem: z.boolean(),
  permissionCodes: z.array(z.string()),
});

export type RoleDetailDto = z.infer<typeof roleDetailDtoSchema>;

/**
 * Per-role scope restrictions (2026-09 RBAC reorganisation).
 *
 * A `(membership, role)` grant can be restricted to one branch, warehouse, cash
 * location or POS terminal. No rows = the grant is tenant-wide. Branch scoping
 * keeps its dedicated `branchScope` + `X-Branch-Id` mechanism; these rows cover
 * the finer warehouse / cash / terminal restrictions.
 */
export const membershipScopeTypeSchema = z.enum(['branch', 'warehouse', 'cash_location', 'pos_terminal']);

export type MembershipScopeType = z.infer<typeof membershipScopeTypeSchema>;

/**
 * Sentinel UUID stored in `membership_role_scopes.scope_id` when a `(membership, role)`
 * grant is explicitly configured as tenant-wide ("all scopes") for a given `scopeType`.
 * An unconfigured role (zero rows for `scopeType`) does NOT override restrictions placed on
 * other held roles; only this explicit sentinel (or specific `scopeId` rows) widens the union.
 */
export const TENANT_WIDE_SCOPE_ID = '00000000-0000-0000-0000-000000000000' as const;

export const membershipScopesSchema = z
  .object({
    scopes: z.array(
      z
        .object({
          roleId: uuidSchema,
          scopeType: membershipScopeTypeSchema,
          scopeId: uuidSchema,
        })
        .strict(),
    ),
  })
  .strict();

export type MembershipScopesRequest = z.infer<typeof membershipScopesSchema>;

/** Allow-listed query filters per resource (API_ARCHITECTURE §3). */
export const MEMBERSHIP_FILTERS = ['status', 'roleId'] as const;
export const ROLE_FILTERS = ['isSystem'] as const;
export const MEMBERSHIP_SORT_COLUMNS = ['displayName', 'createdAt'] as const;
export const ROLE_SORT_COLUMNS = ['name', 'createdAt'] as const;

/**
 * List query shapes. Unknown `filter[...]` keys are *not* rejected here — they are
 * rejected with the dedicated `FILTER_NOT_ALLOWED` code by `parseFilters`, which is what
 * API_ARCHITECTURE §3 prescribes.
 */
const listQueryBase = {
  q: z.string().trim().max(200).optional(),
  sort: z.string().trim().max(200).optional(),
  filter: z.record(z.union([z.string(), z.array(z.string())])).optional(),
};

export const membershipListQuerySchema = paginationQuerySchema.extend(listQueryBase);
export type MembershipListQueryDto = z.infer<typeof membershipListQuerySchema>;

export const roleListQuerySchema = paginationQuerySchema.extend(listQueryBase);
export type RoleListQueryDto = z.infer<typeof roleListQuerySchema>;
