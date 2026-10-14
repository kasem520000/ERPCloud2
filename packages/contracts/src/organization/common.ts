import { z } from 'zod';

import { paginationQuerySchema } from '../pagination.js';

/**
 * Shared building blocks for the Organization DTOs — API_CONTRACT §3,
 * DATABASE_DESIGN §5.
 *
 * Every write schema in this module is `.strict()`: an unknown key is a 400, never a
 * silently ignored field (SECURITY_ARCHITECTURE §6, mass-assignment defence).
 */

/** ISO-4217 alphabetic code, normalised to upper case. */
export const currencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine((value) => /^[A-Z]{3}$/.test(value), { message: 'Must be a 3-letter ISO-4217 code' });

/** ISO-3166-1 alpha-2 country code. */
export const countryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine((value) => /^[A-Z]{2}$/.test(value), { message: 'Must be a 2-letter ISO-3166 code' });

/**
 * Human-typed master-data code (`branches.code`, `warehouses.code`, …). Unique per
 * tenant, so it is normalised to upper case here rather than in every service.
 */
export const orgCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(1)
  .max(32)
  .refine((value) => /^[A-Z0-9][A-Z0-9._-]*$/.test(value), {
    message: 'Use letters, digits, dot, dash or underscore',
  });

/**
 * Money over the wire is a **decimal string**, never a JSON number
 * (PROJECT_CONTRACT §3 / ADR-006). `numeric(20,4)` → at most 16 integer and 4 fraction
 * digits.
 */
export const moneyStringSchema = z
  .string()
  .trim()
  .refine((value) => /^-?\d{1,16}(\.\d{1,4})?$/.test(value), {
    message: 'Must be a decimal string with at most 4 fraction digits',
  });

/** FX rates are `numeric(20,10)` and strictly positive (DATABASE_DESIGN §3). */
export const fxRateStringSchema = z
  .string()
  .trim()
  .refine((value) => /^\d{1,10}(\.\d{1,10})?$/.test(value) && Number.parseFloat(value) > 0, {
    message: 'Must be a positive decimal string with at most 10 fraction digits',
  });

/**
 * ZATCA national address (`Foundation` → `company_profiles.address`,
 * DATABASE_DESIGN §5). Also reused by `branches.address`: the same shape keeps the
 * e-invoice payload builder of PHASE_13 free of per-entity special cases.
 */
export const nationalAddressSchema = z
  .object({
    plot: z.string().trim().max(20).optional(),
    building: z.string().trim().max(20).optional(),
    street: z.string().trim().max(200).optional(),
    addStreet: z.string().trim().max(200).optional(),
    district: z.string().trim().max(200).optional(),
    city: z.string().trim().max(200).optional(),
    postal: z.string().trim().max(20).optional(),
    countryCode: countryCodeSchema.optional(),
  })
  .strict();

export type NationalAddress = z.infer<typeof nationalAddressSchema>;

export const phoneListSchema = z.array(z.string().trim().min(3).max(32)).max(10);

/** ISO-8601 calendar date (`date` column, not a timestamp). */
export const isoDateSchema = z
  .string()
  .trim()
  .refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)), {
    message: 'Must be an ISO-8601 date (YYYY-MM-DD)',
  });

/**
 * Optimistic-concurrency token (DATABASE_DESIGN §0 `version`, API_ARCHITECTURE §3).
 * Optional on every PATCH: when supplied and stale the write is refused with
 * 409 `VERSION_CONFLICT` instead of silently overwriting a concurrent edit.
 */
export const versionSchema = z.coerce.number().int().min(1);

/** Audit envelope every organization DTO carries. */
export const orgAuditDtoSchema = z.object({
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});

export type OrgAuditDto = z.infer<typeof orgAuditDtoSchema>;

/**
 * Shared list-query shape. Unknown `filter[...]` keys are **not** rejected here: they are
 * rejected with the dedicated `FILTER_NOT_ALLOWED` code by `parseFilters`, which is what
 * API_ARCHITECTURE §3 prescribes.
 */
export const orgListQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().max(200).optional(),
  sort: z.string().trim().max(200).optional(),
  filter: z.record(z.union([z.string(), z.array(z.string())])).optional(),
});

export type OrgListQuery = z.infer<typeof orgListQuerySchema>;

/** `filter[isActive]=true` — query strings carry text, not JSON booleans. */
export function parseBooleanFilter(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return undefined;
}
