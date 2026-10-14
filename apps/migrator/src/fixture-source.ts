import type { LegacyRow, LegacySnapshot, LegacySource } from './types.js';

export const fixtureSnapshot: LegacySnapshot = {
  Foundation: [{ CompanyID: '1', NameA: 'شركة نموذجية', TaxNo: '300000000000003' }],
  SettingGeneral: [{ id: 'vat', Key: 'vat.enabled', Value: 'true' }],
  Branches: [{ GlobalID: 'BR1', Code: 'MAIN', NameA: 'الرئيسي' }],
  Stocks: [{ GlobalID: 'ST1', BranchID: 'BR1', NameA: 'مستودع رئيسي' }],
  Safes: [{ GlobalID: 'SF1', NameA: 'الصندوق', IsBank: 0 }],
  Currency: [{ Code: 'SAR', NameA: 'ريال', IsBase: 1 }],
  Accounts_Index: [{ AccountCode: '1000', ParentCode: '', AccountNameA: 'الأصول', HasChildren: 0 }],
  AccountingPeriods: [{ id: '2026-01', FromDate: '2026-01-01', ToDate: '2026-12-31', IsClosed: 0 }],
  Customers: [{ GlobalID: 'C1', NameA: 'عميل نقدي', AccountCode: '1000', TaxNo: '300000000000003' }],
  Suppliers: [{ GlobalID: 'S1', NameA: 'مورد نقدي', AccountCode: '1000' }],
  Employees: [{ GlobalID: 'E1', NameA: 'مندوب' }],
  Category: [{ GlobalID: 'CAT1', NameA: 'عام' }],
  units: [{ id: 'U1', Code: 'EA', NameA: 'حبة' }],
  Items: [{ GlobalID: 'I1', Code: 'SKU-1', NameA: 'صنف تجريبي', HasExpire: 0, HasSerial: 0 }],
  Entry: [{ GlobalID: 'JE1', state: 1, EntryDate: '2026-01-05', Notes: 'قيد افتتاحي' }],
  Entry_sub: [
    { GlobalID: 'JEL1', EntryGlobalID: 'JE1', AccountCode: '1000', Debit: '100.000', Credit: '0' },
    { GlobalID: 'JEL2', EntryGlobalID: 'JE1', AccountCode: '1000', Debit: '0', Credit: '100.000' },
  ],
  Inv: [{ InvGlobalID: 'INV1', InvType: 'sale', BranchID: 'BR1', Net: '115.00' }],
  Inv_Sub: [{ GlobalID: 'IL1', InvGlobalID: 'INV1', ItemID: 'I1', StockID: 'ST1', Qty: '1.000' }],
  Receipts: [{ GlobalID: 'V1', IsPayment: 0, Value: '115.00' }],
  CasherClosed: [{ GlobalID: 'SH1', CloseDate: '2026-01-05', Expected: '115.00' }],
  Currency_Lastprice: [{ id: 'FX1', FromCode: 'USD', ToCode: 'SAR', Rate: '3.750000' }],
  ZatcaResponse: [{ InvGlobalID: 'INV1', UUID: '11111111-1111-4111-8111-111111111111', InvoiceHash: 'hash', QRCode: 'qr' }],
  AttachFiles: [{ GlobalID: 'A1', Path: '/safe/anonymized/invoice.pdf', Entity: 'invoice' }],
};

export class FixtureLegacySource implements LegacySource {
  readonly readOnly = true as const;
  readonly label: string;
  constructor(private readonly snapshot: LegacySnapshot = fixtureSnapshot, label = 'fixture:Data16') { this.label = label; }
  async extract(tableName: string): Promise<LegacyRow[]> { return [...(this.snapshot[tableName] ?? [])]; }
  async listTables(): Promise<string[]> { return Object.keys(this.snapshot).sort(); }
}
