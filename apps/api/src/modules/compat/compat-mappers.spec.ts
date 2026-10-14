import { describe, expect, it } from 'vitest';

import { mapLegacySale, mapLegacyVoucher } from './compat-mappers.js';

describe('compat mappers', () => {
  it('maps legacy sale shape to canonical sales DTO and supports enum overrides', () => {
    const dto = mapLegacySale({ GlobalID: 'INV-1', BranchID: 'b', InvType: 9, Lines: [{ Qty: 2, Price: '10.00' }] }, { invoiceKind: { '9': 'sale' }, payMethod: { '1': 'cash' } });
    expect(dto.kind).toBe('sale');
    expect(dto.lines[0]?.quantity).toBe('2');
    expect(dto.legacyId).toBe('INV-1');
  });

  it('rejects unknown enum ints instead of guessing', () => {
    expect(() => mapLegacySale({ GlobalID: 'INV-2', BranchID: 'b', InvType: 99, Lines: [{ Qty: 1, Price: 1 }] })).toThrow('Unknown legacy invoiceKind');
  });

  it('maps vouchers with legacy GlobalID idempotency key', () => {
    const dto = mapLegacyVoucher({ GlobalID: 'V-1', BranchID: 'b', SafeID: 's', ReceiptType: 1, PaymentType: 1, Value: '5.00' });
    expect(dto.kind).toBe('receipt');
    expect(dto.method).toBe('cash');
    expect(dto.legacyId).toBe('V-1');
  });
});
