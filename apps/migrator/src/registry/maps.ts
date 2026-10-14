import type { LegacyRow } from '../types.js';

export type WaveKey = `W${number}`;
export type RegistryMap = {
  wave: WaveKey;
  entity: string;
  legacyTable: string;
  target: string;
  key: string;
  required?: string[];
  dependsOn?: string[];
  packFlag?: 'hrm' | 'vertical';
  quirks: string[];
  transform(row: LegacyRow): Record<string, unknown>;
};

const text = (value: unknown, fallback = '') => String(value ?? fallback).trim();
const bool01 = (value: unknown) => value === true || value === 1 || value === '1';

export const registryMaps: readonly RegistryMap[] = [
  { wave: 'W1', entity: 'company_profiles', legacyTable: 'Foundation', target: 'company_profiles', key: 'CompanyID', required: ['CompanyID'], quirks: ['Foundation row becomes tenant company profile; secrets are never imported.'], transform: (row) => ({ legacyId: text(row.CompanyID), nameAr: text(row.NameA, 'Legacy company'), taxNo: text(row.TaxNo) }) },
  { wave: 'W1', entity: 'tenant_settings', legacyTable: 'SettingGeneral', target: 'tenant_settings', key: 'id', quirks: ['Distinct settings are emitted as typed tenant settings.'], transform: (row) => ({ key: text(row.Key), value: row.Value ?? null }) },
  { wave: 'W2', entity: 'branches', legacyTable: 'Branches', target: 'branches', key: 'GlobalID', required: ['GlobalID'], quirks: ['Missing branch code is generated from legacy PK.'], transform: (row) => ({ legacyId: text(row.GlobalID), code: text(row.Code, `BR-${text(row.GlobalID)}`), nameAr: text(row.NameA, 'فرع') }) },
  { wave: 'W2', entity: 'warehouses', legacyTable: 'Stocks', target: 'warehouses', key: 'GlobalID', required: ['GlobalID'], dependsOn: ['branches'], quirks: ['Stocks are mapped to warehouses and branch lookup is deferred.'], transform: (row) => ({ legacyId: text(row.GlobalID), nameAr: text(row.NameA, 'مستودع'), branchLegacyId: text(row.BranchID) }) },
  { wave: 'W2', entity: 'cash_locations', legacyTable: 'Safes', target: 'cash_locations', key: 'GlobalID', required: ['GlobalID'], dependsOn: ['branches'], quirks: ['Safes and banks become cash locations; balances are recomputed not trusted.'], transform: (row) => ({ legacyId: text(row.GlobalID), kind: bool01(row.IsBank) ? 'bank' : 'safe', name: text(row.NameA, 'Cash location') }) },
  { wave: 'W2', entity: 'currencies', legacyTable: 'Currency', target: 'currencies', key: 'Code', required: ['Code'], quirks: ['Currency_Lastprice imports later as FX; base currency selected from flags.'], transform: (row) => ({ code: text(row.Code, 'SAR'), nameAr: text(row.NameA, text(row.Code, 'SAR')), isBase: bool01(row.IsBase) }) },
  { wave: 'W3', entity: 'accounts', legacyTable: 'Accounts_Index', target: 'accounts', key: 'AccountCode', required: ['AccountCode'], quirks: ['ParentCode repair report RC-12 emitted for missing parents.'], transform: (row) => ({ legacyId: text(row.AccountCode), code: text(row.AccountCode), parentCode: text(row.ParentCode), nameAr: text(row.AccountNameA, 'حساب'), isPostable: !bool01(row.HasChildren) }) },
  { wave: 'W3', entity: 'fiscal_periods', legacyTable: 'AccountingPeriods', target: 'fiscal_periods', key: 'id', dependsOn: ['accounts'], quirks: ['Multi-db fiscal years are provisional per RC-27.'], transform: (row) => ({ legacyId: text(row.id), startsOn: text(row.FromDate), endsOn: text(row.ToDate), status: bool01(row.IsClosed) ? 'closed' : 'open' }) },
  { wave: 'W4', entity: 'parties', legacyTable: 'Customers', target: 'parties', key: 'GlobalID', required: ['GlobalID'], dependsOn: ['accounts'], quirks: ['Customers/Suppliers/Owners/Contractors/VAT clients converge to parties.'], transform: (row) => ({ legacyId: text(row.GlobalID), kind: 'customer', nameAr: text(row.NameA, 'عميل'), taxNo: text(row.TaxNo), accountLegacyCode: text(row.AccountCode) }) },
  { wave: 'W4', entity: 'suppliers', legacyTable: 'Suppliers', target: 'parties', key: 'GlobalID', required: ['GlobalID'], dependsOn: ['accounts'], quirks: ['Supplier credit terms preserved as metadata.'], transform: (row) => ({ legacyId: text(row.GlobalID), kind: 'supplier', nameAr: text(row.NameA, 'مورد'), accountLegacyCode: text(row.AccountCode) }) },
  { wave: 'W4', entity: 'salesmen', legacyTable: 'Employees', target: 'memberships', key: 'GlobalID', packFlag: 'hrm', quirks: ['If HRM pack is absent only lightweight salesman references are staged.'], transform: (row) => ({ legacyId: text(row.GlobalID), displayName: text(row.NameA, 'مندوب'), lightweight: true }) },
  { wave: 'W5', entity: 'item_categories', legacyTable: 'Category', target: 'item_categories', key: 'GlobalID', required: ['GlobalID'], quirks: ['Deleted categories are archived and not used for balances.'], transform: (row) => ({ legacyId: text(row.GlobalID), nameAr: text(row.NameA, 'تصنيف') }) },
  { wave: 'W5', entity: 'units', legacyTable: 'units', target: 'units_of_measure', key: 'id', required: ['id'], quirks: ['Unit ratios are validated in ItemUnits transform.'], transform: (row) => ({ legacyId: text(row.id), code: text(row.Code, text(row.NameA, 'EA')), nameAr: text(row.NameA, 'وحدة') }) },
  { wave: 'W5', entity: 'items', legacyTable: 'Items', target: 'items', key: 'GlobalID', required: ['GlobalID'], dependsOn: ['item_categories', 'units'], quirks: ['Barcodes, alternative codes, components and price history are child maps.'], transform: (row) => ({ legacyId: text(row.GlobalID), sku: text(row.Code, text(row.GlobalID)), nameAr: text(row.NameA, 'صنف'), trackLot: bool01(row.HasExpire), trackSerial: bool01(row.HasSerial) }) },
  { wave: 'W6', entity: 'journal_entries', legacyTable: 'Entry', target: 'journal_entries', key: 'GlobalID', dependsOn: ['accounts', 'fiscal_periods'], quirks: ['state=1 entries import as posted; unbalanced entries block.'], transform: (row) => ({ legacyId: text(row.GlobalID), posted: row.state === 1 || row.state === '1', docDate: text(row.EntryDate), description: text(row.Notes) }) },
  { wave: 'W6', entity: 'journal_lines', legacyTable: 'Entry_sub', target: 'journal_entry_lines', key: 'GlobalID', dependsOn: ['journal_entries', 'accounts'], quirks: ['Float values are rounded to minor units with variance payloads.'], transform: (row) => ({ legacyId: text(row.GlobalID), entryLegacyId: text(row.EntryGlobalID), accountCode: text(row.AccountCode), debitText: text(row.Debit, '0'), creditText: text(row.Credit, '0') }) },
  { wave: 'W7', entity: 'invoices', legacyTable: 'Inv', target: 'sales_or_purchase_invoices', key: 'InvGlobalID', dependsOn: ['parties', 'items'], quirks: ['Document kind requires RC-resolved legacyDocTypeMap; unknown kinds block.'], transform: (row) => ({ legacyId: text(row.InvGlobalID), invType: text(row.InvType), branchLegacyId: text(row.BranchID), netText: text(row.Net, '0') }) },
  { wave: 'W7', entity: 'invoice_lines', legacyTable: 'Inv_Sub', target: 'invoice_lines', key: 'GlobalID', dependsOn: ['invoices', 'items'], quirks: ['Computed totals are compared with header and issue variance rows.'], transform: (row) => ({ legacyId: text(row.GlobalID), invoiceLegacyId: text(row.InvGlobalID), itemLegacyId: text(row.ItemID), qtyText: text(row.Qty, '0') }) },
  { wave: 'W8', entity: 'inventory_replay', legacyTable: 'Inv_Sub', target: 'inventory_transactions', key: 'GlobalID', dependsOn: ['invoice_lines'], quirks: ['Ledger is rebuilt from documents then compared with legacy stock functions.'], transform: (row) => ({ legacyId: text(row.GlobalID), itemLegacyId: text(row.ItemID), warehouseLegacyId: text(row.StockID), qtyText: text(row.Qty, '0') }) },
  { wave: 'W9', entity: 'vouchers', legacyTable: 'Receipts', target: 'vouchers', key: 'GlobalID', dependsOn: ['parties', 'cash_locations'], quirks: ['Sand* and Receipts map uses inline RC-19 receipt/payment classification.'], transform: (row) => ({ legacyId: text(row.GlobalID), kind: bool01(row.IsPayment) ? 'payment' : 'receipt', valueText: text(row.Value, '0') }) },
  { wave: 'W10', entity: 'shift_closes', legacyTable: 'CasherClosed', target: 'shift_closes', key: 'GlobalID', dependsOn: ['cash_locations'], quirks: ['Archive-grade import; no back-posting of already closed shifts.'], transform: (row) => ({ legacyId: text(row.GlobalID), closedAt: text(row.CloseDate), expectedText: text(row.Expected, '0') }) },
  { wave: 'W10', entity: 'fx_rates', legacyTable: 'Currency_Lastprice', target: 'fx_rates', key: 'id', dependsOn: ['currencies'], quirks: ['Currency_SafeBalance is verify-only; FX rates use last known source date.'], transform: (row) => ({ legacyId: text(row.id), fromCode: text(row.FromCode), toCode: text(row.ToCode), rateText: text(row.Rate, '1') }) },
  { wave: 'W13', entity: 'einvoice_artifacts', legacyTable: 'ZatcaResponse', target: 'einvoice_submissions', key: 'InvGlobalID', dependsOn: ['invoices'], quirks: ['Legacy ZATCA artifacts import with status=imported and no resubmission.'], transform: (row) => ({ legacyId: text(row.InvGlobalID), uuid: text(row.UUID), hash: text(row.InvoiceHash), qrPayload: text(row.QRCode), status: 'imported' }) },
  { wave: 'W14', entity: 'attachments', legacyTable: 'AttachFiles', target: 'files', key: 'GlobalID', quirks: ['Attachment streaming copies bytes to S3; fixture stores metadata only.'], transform: (row) => ({ legacyId: text(row.GlobalID), path: text(row.Path), entity: text(row.Entity) }) },
] as const;

export function registryByDependencyOrder(): readonly RegistryMap[] {
  return [...registryMaps].sort((left, right) => Number(left.wave.slice(1)) - Number(right.wave.slice(1)));
}

export function validateRegistry(maps = registryMaps): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const map of maps) {
    if (seen.has(map.entity)) problems.push(`duplicate entity ${map.entity}`);
    seen.add(map.entity);
    for (const dependency of map.dependsOn ?? []) if (!maps.some((candidate) => candidate.entity === dependency)) problems.push(`${map.entity} depends on missing ${dependency}`);
    if (!map.legacyTable || !map.target || !map.key) problems.push(`${map.entity} is missing required map metadata`);
  }
  return problems;
}
