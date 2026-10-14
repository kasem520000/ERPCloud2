import { describe, expect, it } from 'vitest';

import {
  POSTING_PROFILE_WILDCARD,
  POST_PROFILE_ACCOUNT_KEYS,
  companyProfilePutSchema,
  currencyCodeSchema,
  docTypeSchema,
  fxRateCreateSchema,
  fxRateStringSchema,
  isValidIban,
  maskIban,
  moneyStringSchema,
  nationalAddressSchema,
  orgCodeSchema,
  postProfileV1Schema,
  postingProfileUpsertSchema,
  priceListItemUpsertSchema,
  cashLocationCreateSchema,
} from './index.js';

/** Organization DTO contracts — API_CONTRACT §3, DATABASE_DESIGN §5. */

describe('organization contracts', () => {
  describe('orgCodeSchema', () => {
    it('normalises to upper case and accepts the documented character set', () => {
      expect(orgCodeSchema.parse('  main-01 ')).toBe('MAIN-01');
      expect(orgCodeSchema.parse('wh.a_1')).toBe('WH.A_1');
    });

    it('rejects codes with spaces, slashes, or a leading separator', () => {
      for (const candidate of ['main 01', 'a/b', '-main', '']) {
        expect(orgCodeSchema.safeParse(candidate).success, candidate).toBe(false);
      }
    });
  });

  describe('currencyCodeSchema', () => {
    it('upper-cases a 3-letter ISO code and rejects anything else', () => {
      expect(currencyCodeSchema.parse('sar')).toBe('SAR');
      expect(currencyCodeSchema.safeParse('SARS').success).toBe(false);
      expect(currencyCodeSchema.safeParse('S1R').success).toBe(false);
    });
  });

  describe('money and rate strings', () => {
    it('accepts decimal strings within the stored scale', () => {
      expect(moneyStringSchema.parse('1234.5000')).toBe('1234.5000');
      expect(moneyStringSchema.parse('-0.0001')).toBe('-0.0001');
      expect(fxRateStringSchema.parse('3.7512345678')).toBe('3.7512345678');
    });

    it('rejects floats, over-scaled values and non-positive rates', () => {
      expect(moneyStringSchema.safeParse('1.00001').success).toBe(false);
      expect(fxRateStringSchema.safeParse('0').success).toBe(false);
      expect(fxRateStringSchema.safeParse('-1').success).toBe(false);
      expect(fxRateStringSchema.safeParse('1.00000000001').success).toBe(false);
    });
  });

  describe('IBAN', () => {
    it('accepts valid IBANs regardless of spacing and case', () => {
      // Published ISO 13616 examples.
      expect(isValidIban('GB82 WEST 1234 5698 7654 32')).toBe(true);
      expect(isValidIban('sa0380000000608010167519')).toBe(true);
      expect(isValidIban('DE89370400440532013000')).toBe(true);
    });

    it('rejects a transposed digit — the reason the checksum exists at all', () => {
      expect(isValidIban('GB82WEST12345698765423')).toBe(false);
      expect(isValidIban('SA0380000000608010167518')).toBe(false);
      expect(isValidIban('XX')).toBe(false);
    });

    it('masks everything but the first and last four characters', () => {
      expect(maskIban('SA0380000000608010167519')).toBe('SA03****************7519');
      expect(maskIban('GB82 WEST 1234 5698 7654 32')).toBe('GB82**************5432');
      expect(maskIban('SHORT')).toBe('*****');
    });
  });

  describe('cashLocationCreateSchema', () => {
    it('rejects an invalid IBAN inside the bank block', () => {
      const parsed = cashLocationCreateSchema.safeParse({
        branchId: '018f3b8a-0000-7000-8000-000000000001',
        kind: 'bank',
        name: 'Main bank',
        bank: { bankName: 'Al Rajhi', iban: 'SA0380000000608010167518' },
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects unknown keys (mass-assignment defence)', () => {
      const parsed = cashLocationCreateSchema.safeParse({
        branchId: '018f3b8a-0000-7000-8000-000000000001',
        kind: 'safe',
        name: 'Main safe',
        tenantId: '018f3b8a-0000-7000-8000-000000000009',
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe('PostProfileV1', () => {
    it('accepts a versioned mapping and keeps the account keys in one list', () => {
      const parsed = postProfileV1Schema.parse({
        version: 1,
        salesAccountId: '018f3b8a-0000-7000-8000-000000000002',
        costCenterId: null,
      });
      expect(parsed.version).toBe(1);
      expect(POST_PROFILE_ACCOUNT_KEYS).toContain('salesAccountId');
      expect(POST_PROFILE_ACCOUNT_KEYS).toContain('vatOutputAccountId');
      expect(POST_PROFILE_ACCOUNT_KEYS).toContain('custodyAccountId');
      expect(POST_PROFILE_ACCOUNT_KEYS).toContain('cashInTransitAccountId');
    });

    it('refuses a profile that maps no account at all', () => {
      expect(postProfileV1Schema.safeParse({ version: 1 }).success).toBe(false);
      expect(
        postProfileV1Schema.safeParse({ version: 1, costCenterId: '018f3b8a-0000-7000-8000-000000000002' })
          .success,
      ).toBe(false);
    });

    it('refuses an unversioned or unknown-key mapping', () => {
      expect(
        postProfileV1Schema.safeParse({ salesAccountId: '018f3b8a-0000-7000-8000-000000000002' }).success,
      ).toBe(false);
      expect(
        postProfileV1Schema.safeParse({
          version: 1,
          salesAccountId: '018f3b8a-0000-7000-8000-000000000002',
          somethingElse: 1,
        }).success,
      ).toBe(false);
    });

    it('allows the wildcard doc type on an upsert but not an invented one', () => {
      const base = {
        docType: POSTING_PROFILE_WILDCARD,
        mapping: { version: 1, salesAccountId: '018f3b8a-0000-7000-8000-000000000002' },
      };
      expect(postingProfileUpsertSchema.safeParse(base).success).toBe(true);
      expect(postingProfileUpsertSchema.safeParse({ ...base, docType: 'made_up' }).success).toBe(false);
      expect(docTypeSchema.safeParse('sales_invoice').success).toBe(true);
    });
  });

  describe('fxRateCreateSchema', () => {
    it('rejects a self-referencing pair', () => {
      const parsed = fxRateCreateSchema.safeParse({
        fromCode: 'SAR',
        toCode: 'sar',
        rate: '1',
        effectiveFrom: '2026-01-01',
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects a malformed effective date', () => {
      const parsed = fxRateCreateSchema.safeParse({
        fromCode: 'USD',
        toCode: 'SAR',
        rate: '3.75',
        effectiveFrom: '01-01-2026',
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe('companyProfilePutSchema', () => {
    it('accepts a ZATCA national address and a 15-digit tax number', () => {
      const parsed = companyProfilePutSchema.parse({
        nameAr: 'شركة',
        taxNo: '300000000000003',
        address: { plot: '1234', building: '5678', street: 'King Fahd', district: 'Olaya', postal: '12345' },
        phones: ['+966500000000'],
        einvoiceFlags: { zatca: true },
      });
      expect(parsed.taxNo).toBe('300000000000003');
      expect(parsed.address?.district).toBe('Olaya');
    });

    it('rejects a non-numeric tax number and an unknown address field', () => {
      expect(companyProfilePutSchema.safeParse({ nameAr: 'x', taxNo: 'VAT-1' }).success).toBe(false);
      expect(nationalAddressSchema.safeParse({ province: 'Riyadh' }).success).toBe(false);
    });
  });

  describe('priceListItemUpsertSchema', () => {
    it('defaults the quantity break to the caller and validates the price scale', () => {
      const parsed = priceListItemUpsertSchema.parse({ unitPrice: '19.9900' });
      expect(parsed.minQty).toBeUndefined();
      expect(priceListItemUpsertSchema.safeParse({ unitPrice: '19.99999' }).success).toBe(false);
    });
  });
});
