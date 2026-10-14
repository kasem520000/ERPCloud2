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
 * Cash locations — API_CONTRACT §3, DATABASE_DESIGN §5.
 *
 * One table unifies the legacy `Safes`, `Banks` and `treasury` (DOMAIN_MODEL §3):
 * `kind` discriminates, and the bank-only attributes live in the `bank` JSON block so a
 * safe row carries no meaningless NULL columns.
 */

export const cashLocationKindSchema = z.enum(['safe', 'bank']);
export type CashLocationKind = z.infer<typeof cashLocationKindSchema>;

/**
 * IBAN check digits — ISO 13616 mod-97-10. A syntactic length/charset check alone
 * accepts transposed digits, which is exactly the error a human makes when typing an
 * IBAN, so the checksum is verified too.
 */
export function isValidIban(candidate: string): boolean {
  const value = candidate.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(value)) return false;

  const rearranged = value.slice(4) + value.slice(0, 4);
  let remainder = 0;
  for (const character of rearranged) {
    const digits = /\d/.test(character)
      ? character
      : String(character.charCodeAt(0) - 'A'.charCodeAt(0) + 10);
    for (const digit of digits) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

/**
 * Masks an IBAN for list responses (SECURITY_ARCHITECTURE §5: bank data is sensitive).
 * First 4 and last 4 characters survive — enough for a human to recognise the account,
 * not enough to use it.
 */
export function maskIban(iban: string): string {
  const value = iban.replace(/[\s-]/g, '').toUpperCase();
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}${'*'.repeat(value.length - 8)}${value.slice(-4)}`;
}

export const bankDetailsSchema = z
  .object({
    bankName: z.string().trim().min(1).max(200),
    /**
     * Phase 06 — the rest of `frmBanks.xaml`'s card: 🌍 الدولة، 🏙️ المدينة، 📍 المنطقة،
     * تليفون، موبايل، 💰 نسبة الاقتطاع %. They live in this block rather than in six
     * columns because they are meaningless for a safe, which is half the table.
     */
    country: z.string().trim().max(100).optional(),
    city: z.string().trim().max(100).optional(),
    region: z.string().trim().max(100).optional(),
    phone: z.string().trim().max(40).optional(),
    mobile: z.string().trim().max(40).optional(),
    /** 💰 نسبة الاقتطاع % — what the bank keeps; `0` … `100` as text. */
    deductionPct: z
      .string()
      .trim()
      .max(10)
      .refine((value) => /^\d{1,3}(\.\d{1,4})?$/.test(value) && Number(value) >= 0 && Number(value) <= 100, {
        message: 'Deduction percentage must be between 0 and 100',
      })
      .optional(),
    iban: z
      .string()
      .trim()
      .toUpperCase()
      .max(42)
      .refine(isValidIban, { message: 'Invalid IBAN (ISO 13616 check digits)' })
      .optional(),
    swift: z
      .string()
      .trim()
      .toUpperCase()
      .refine((value) => /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(value), {
        message: 'Invalid SWIFT/BIC code',
      })
      .optional(),
    accountNo: z.string().trim().max(64).optional(),
  })
  .strict();

export type BankDetails = z.infer<typeof bankDetailsSchema>;

export const cashLocationDtoSchema = orgAuditDtoSchema.extend({
  id: uuidSchema,
  branchId: uuidSchema,
  kind: cashLocationKindSchema,
  name: z.string(),
  accountId: uuidSchema.nullable(),
  currencyCode: z.string().nullable(),
  isDefault: z.boolean(),
  /** `iban` is masked on list responses and full on the detail read. */
  bank: bankDetailsSchema.nullable(),
  changeInPos: z.boolean(),
  isActive: z.boolean(),
  /** 📝 ملاحظات */
  notes: z.string().nullable(),
  /** 👤 مسئولي الصندوق — employee ids, in the order they were saved. */
  custodianIds: z.array(uuidSchema),
});

export type CashLocationDto = z.infer<typeof cashLocationDtoSchema>;

export const cashLocationCreateSchema = z
  .object({
    branchId: uuidSchema,
    kind: cashLocationKindSchema,
    name: z.string().trim().min(1).max(200),
    /**
     * The COA account this location posts to. Nullable until PHASE_07 introduces
     * `accounts` and turns the column NOT NULL + FK (CR-006).
     */
    accountId: uuidSchema.nullable().optional(),
    /** NULL = the tenant's base currency (DATABASE_DESIGN §5). */
    currencyCode: currencyCodeSchema.nullable().optional(),
    bank: bankDetailsSchema.nullable().optional(),
    changeInPos: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    isActive: z.boolean().optional(),
    /** 📝 ملاحظات */
    notes: z.string().trim().max(2000).nullable().optional(),
    /**
     * 👤 مسئولي الصندوق — replaced wholesale on every save, the way
     * `frmTreasury.xaml.cs` deletes `Stock_Emps` and re-inserts it. A صندوق must name at
     * least one; a bank account may be signed for by nobody.
     */
    custodianIds: z.array(uuidSchema).max(50).optional(),
  })
  .strict();

export type CashLocationCreate = z.infer<typeof cashLocationCreateSchema>;

export const cashLocationUpdateSchema = cashLocationCreateSchema
  .omit({ kind: true })
  .partial()
  .extend({ version: versionSchema.optional() })
  .strict();

export type CashLocationUpdate = z.infer<typeof cashLocationUpdateSchema>;

export const cashLocationBalanceDtoSchema = z.object({
  cashLocationId: uuidSchema,
  currencyCode: z.string(),
  /** Decimal string; the truth is the ledger, this row is a reconciled cache. */
  balance: moneyStringSchema,
  updatedAt: z.string().nullable(),
});

export type CashLocationBalanceDto = z.infer<typeof cashLocationBalanceDtoSchema>;

export const CASH_LOCATION_FILTERS = ['isActive', 'isDefault', 'branchId', 'kind'] as const;
export const CASH_LOCATION_SORT_COLUMNS = ['name', 'kind', 'createdAt'] as const;

export const cashLocationListQuerySchema = orgListQuerySchema;
export type CashLocationListQueryDto = z.infer<typeof cashLocationListQuerySchema>;
