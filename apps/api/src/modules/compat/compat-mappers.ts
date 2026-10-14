import { DomainError } from '@erp/contracts';

import type { SalesInvoiceInput } from '../sales/sales.service.js';
import type { VoucherInput } from '../treasury/treasury.service.js';

export type LegacySalesInvoiceDto = {
  GlobalID: string;
  BranchID?: string;
  StockID?: string;
  CustID?: string;
  CashCustomer?: string;
  InvType: number | string;
  PayType?: number | string;
  Currency?: string;
  PriceIncludesVat?: boolean;
  Lines: Array<{ ItemID?: string; Name?: string; Qty: string | number; Price: string | number; Discount?: string | number; VAT?: string | number }>;
};

export type LegacyVoucherDto = {
  GlobalID: string;
  BranchID: string;
  SafeID: string;
  ReceiptType?: number | string;
  PaymentType?: number | string;
  Value: string | number;
  Date?: string;
  PartyID?: string;
  Notes?: string;
};

export type CompatEnumMaps = Record<string, Record<string, string>>;

const defaultInvoiceKind: Record<string, string> = { '2': 'sale', '3': 'sale', sale: 'sale', return: 'sale_return', '5': 'sale_return' };
const defaultPayment: Record<string, string> = { '1': 'cash', '2': 'card', '4': 'split', cash: 'cash', card: 'card', credit: 'credit', split: 'split' };

export function mapLegacySale(input: LegacySalesInvoiceDto, enumMaps: CompatEnumMaps = {}): SalesInvoiceInput & { legacyId: string; payMethod: string } {
  if (!input.GlobalID) throw new DomainError('VALIDATION_FAILED', 'Legacy GlobalID is required', 422);
  const kind = resolveEnum('invoiceKind', String(input.InvType), enumMaps, defaultInvoiceKind) as SalesInvoiceInput['kind'];
  const payMethod = resolveEnum('payMethod', String(input.PayType ?? '1'), enumMaps, defaultPayment);
  if (!input.Lines.length) throw new DomainError('VALIDATION_FAILED', 'At least one legacy invoice line is required', 422);
  return {
    legacyId: input.GlobalID,
    branchId: input.BranchID ?? '',
    warehouseId: input.StockID,
    partyId: input.CustID,
    cashCustomerName: input.CustID ? undefined : input.CashCustomer ?? 'Legacy cash customer',
    kind,
    currency: input.Currency ?? 'SAR',
    priceIncludesVat: input.PriceIncludesVat ?? false,
    payMethod,
    lines: input.Lines.map((line) => ({ itemId: line.ItemID, description: line.Name, quantity: String(line.Qty), unitPrice: String(line.Price), discountAmount: String(line.Discount ?? '0'), taxRate: String(line.VAT ?? '0') })),
  };
}

export function mapLegacyVoucher(input: LegacyVoucherDto, enumMaps: CompatEnumMaps = {}): VoucherInput & { legacyId: string } {
  if (!input.GlobalID) throw new DomainError('VALIDATION_FAILED', 'Legacy GlobalID is required', 422);
  const kind = resolveEnum('voucherKind', String(input.ReceiptType ?? 'receipt'), enumMaps, { receipt: 'receipt', payment: 'payment', '1': 'receipt', '2': 'payment' }) as 'receipt' | 'payment';
  const method = resolveEnum('payMethod', String(input.PaymentType ?? '1'), enumMaps, defaultPayment);
  return { legacyId: input.GlobalID, branchId: input.BranchID, cashLocationId: input.SafeID, kind, subtype: 'other', date: input.Date ?? new Date().toISOString().slice(0, 10), partyId: input.PartyID, method: method === 'bank' ? 'bank_transfer' : method as VoucherInput['method'], amount: String(input.Value), referenceNo: input.GlobalID, recipient: input.Notes };
}

function resolveEnum(name: string, raw: string, enumMaps: CompatEnumMaps, fallback: Record<string, string>): string {
  const configured = enumMaps[name]?.[raw];
  const resolved = configured ?? fallback[raw];
  if (!resolved) throw new DomainError('COMPAT_ENUM_UNKNOWN', `Unknown legacy ${name} value '${raw}'`, 422);
  return resolved;
}
