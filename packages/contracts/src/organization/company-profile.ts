import { z } from 'zod';

import { uuidSchema } from '../ids.js';

import { countryCodeSchema, nationalAddressSchema, phoneListSchema, versionSchema } from './common.js';

/**
 * Company profile — API_CONTRACT §3 (`GET/PUT /company-profile`), DATABASE_DESIGN §5
 * (legacy `Foundation`).
 *
 * Exactly one row per tenant: the table is keyed by `tenant_id`, so the endpoint is an
 * upsert, not a collection. `logoFileId` points at a **finalised** row of the PHASE_04
 * `files` table — the bytes live in object storage, never in this table.
 */

export const einvoiceFlagsSchema = z
  .object({
    zatca: z.boolean().optional(),
    eta: z.boolean().optional(),
  })
  .strict();

export type EinvoiceFlags = z.infer<typeof einvoiceFlagsSchema>;

export const companyProfileDtoSchema = z.object({
  tenantId: uuidSchema,
  nameAr: z.string(),
  nameEn: z.string().nullable(),
  taxNo: z.string().nullable(),
  crNo: z.string().nullable(),
  logoFileId: uuidSchema.nullable(),
  address: nationalAddressSchema.nullable(),
  phones: z.array(z.string()),
  email: z.string().nullable(),
  countryCode: z.string().nullable(),
  einvoiceFlags: einvoiceFlagsSchema,
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});

export type CompanyProfileDto = z.infer<typeof companyProfileDtoSchema>;

export const companyProfilePutSchema = z
  .object({
    nameAr: z.string().trim().min(1).max(200),
    nameEn: z.string().trim().min(1).max(200).nullable().optional(),
    /** 15-digit ZATCA VAT registration number when present. */
    taxNo: z
      .string()
      .trim()
      .max(20)
      .refine((value) => value === '' || /^\d{9,15}$/.test(value), {
        message: 'Tax number must be 9–15 digits',
      })
      .nullable()
      .optional(),
    crNo: z.string().trim().max(20).nullable().optional(),
    logoFileId: uuidSchema.nullable().optional(),
    address: nationalAddressSchema.nullable().optional(),
    phones: phoneListSchema.optional(),
    email: z.string().trim().email().max(320).nullable().optional(),
    countryCode: countryCodeSchema.nullable().optional(),
    einvoiceFlags: einvoiceFlagsSchema.optional(),
    version: versionSchema.optional(),
  })
  .strict();

export type CompanyProfilePut = z.infer<typeof companyProfilePutSchema>;

/** The `files.entity` discriminator a company logo is attached with (PHASE_04 §4). */
export const COMPANY_PROFILE_FILE_ENTITY = 'company_profile';
