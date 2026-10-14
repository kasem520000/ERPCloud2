/**
 * Cross-module lookups and formatting.
 *
 * Almost every operational screen needs the same reference data (branches, warehouses,
 * items, parties, cash locations, accounts…) to fill a `<select>`. Keeping the fetchers
 * and the display formatting in one module means a screen states *what* it needs, not
 * how the endpoint happens to be shaped.
 */
import { apiData, apiDelete, apiList, apiPost } from './api';

export type Option = { id: string; label: string };

export type Branch = {
  id: string;
  code?: string;
  nameAr?: string;
  name_ar?: string;
  nameEn?: string;
  isDefault?: boolean;
};
export type Warehouse = {
  id: string;
  code?: string;
  name?: string;
  nameAr?: string;
  name_ar?: string;
  branchId?: string;
  isDefault?: boolean;
};
export type Item = {
  id: string;
  sku: string;
  barcode?: string | null;
  nameAr?: string;
  name_ar?: string;
  nameEn?: string;
  salePrice?: string | null;
  sale_price?: string | null;
  purchasePrice?: string | null;
  purchase_price?: string | null;
  categoryId?: string;
  category_id?: string;
  baseUnitId?: string;
  base_unit_id?: string;
  taxGroupId?: string | null;
  tax_group_id?: string | null;
  kind?: string;
  showInPos?: boolean;
  minQty?: string | null;
  min_qty?: string | null;
  maxQty?: string | null;
  max_qty?: string | null;
  trackLot?: boolean;
  track_lot?: boolean;
  trackSerial?: boolean;
  track_serial?: boolean;
};
export type Party = {
  id: string;
  code?: string;
  name: string;
  paymentMethodId?: string | null;
  kind?: string;
  phone?: string | null;
  taxNo?: string | null;
  tax_no?: string | null;
  creditLimit?: string | null;
};
export type CashLocation = {
  id: string;
  name: string;
  kind?: string;
  accountId?: string | null;
  account_id?: string | null;
  currencyCode?: string;
  currency_code?: string;
  isDefault?: boolean;
  is_default?: boolean;
  branchId?: string | null;
  branch_id?: string | null;
};
export type Category = {
  id: string;
  code: string;
  nameAr?: string;
  name_ar?: string;
  nameEn?: string | null;
  parentId?: string | null;
};
export type Unit = { id: string; code: string; nameAr?: string; name_ar?: string; nameEn?: string | null };
export type TaxGroup = {
  id: string;
  nameAr?: string;
  name_ar?: string;
  nameEn?: string | null;
  rate: string;
  isInclusiveDefault?: boolean;
};
export type Salesman = { id: string; name: string; active?: boolean };
export type VesselGroup = { id: string; name: string; code?: string | null; number?: number | null };
export type CostCenter = {
  id: string;
  code: string;
  nameAr?: string;
  name_ar?: string;
  nameEn?: string | null;
  parentId?: string | null;
  branchId?: string | null;
};
/** 📒 الحساب — the chart of accounts behind the «الحساب» / «الحساب الرئيسي» filters. */
export type Account = {
  id: string;
  code: string;
  nameAr?: string;
  name_ar?: string;
  nameEn?: string | null;
  type?: string;
  level?: number;
  isPostable?: boolean;
  is_postable?: boolean;
};
export type FiscalPeriod = {
  id: string;
  name: string;
  status: string;
  startDate?: string;
  start_date?: string;
  endDate?: string;
  end_date?: string;
  fiscalYearId?: string;
  fiscal_year_id?: string;
};
export type Employee = {
  id: string;
  employeeNo?: string;
  employee_no?: string;
  name: string;
  /** The membership this employee record belongs to — how a user links to a person. */
  membershipId?: string | null;
  departmentId?: string | null;
  jobId?: string | null;
  status?: string;
  salaryComponents?: Record<string, string>;
  salary_components?: Record<string, string>;
};
/** A lot (دفعة) — expiry tracking for a lot-controlled item. */
export type Lot = {
  id: string;
  itemId: string;
  item_id?: string;
  lotNo: string;
  lot_no?: string;
  /** 📅 تاريخ الإنتاج المطبوع على العبوة — عمودٌ مستقلٌّ عن تاريخ الاستلام (R5). */
  productionDate?: string | null;
  production_date?: string | null;
  expiryDate?: string | null;
  expiry_date?: string | null;
  receivedAt?: string | null;
  received_at?: string | null;
};
/** A serialised unit (رقم تسلسلي) — one tracked piece of stock. */
export type Serial = {
  id: string;
  itemId: string;
  item_id?: string;
  serialNo: string;
  serial_no?: string;
  status: string;
  warehouseId?: string | null;
  warehouse_id?: string | null;
  lotId?: string | null;
};

/** Both spellings exist in the API surface (DTOs vs. raw rows); ask once, here. */
export function arabicName(row: {
  nameAr?: string | null;
  name_ar?: string | null;
  nameEn?: string | null;
  name?: string | null;
  code?: string;
}): string {
  return row.nameAr ?? row.name_ar ?? row.name ?? row.nameEn ?? row.code ?? '—';
}

export const listBranches = () => apiList<Branch>('/branches');
export const listWarehouses = () => apiList<Warehouse>('/warehouses');
export const listItems = (q?: string) =>
  apiList<Item>(`/organization/catalog/items${q ? `?q=${encodeURIComponent(q)}` : ''}`);
export const listCategories = () => apiList<Category>('/organization/catalog/categories');
export const listUnits = () => apiList<Unit>('/organization/catalog/units');
export const listTaxGroups = () => apiList<TaxGroup>('/organization/catalog/tax-groups');

/**
 * وحدات الصنف المتعددة — `ratio` is **base units per one of this unit**: a carton of 12
 * makes `12`, and the stock engine moves `qty × ratio` base units.
 */
export type ItemUnit = {
  itemId: string;
  unitId: string;
  unitCode?: string;
  unitNameAr?: string;
  ratio: string;
  barcode?: string | null;
  salePrice?: string | null;
  purchasePrice?: string | null;
  isDefaultSale?: boolean;
  isDefaultPurchase?: boolean;
};
export type ItemBarcode = {
  barcode: string;
  itemId: string;
  unitId?: string | null;
  unitNameAr?: string | null;
};
export const listItemUnits = (itemId: string) =>
  apiList<ItemUnit>(`/organization/catalog/items/${itemId}/units`);
export const setItemUnit = (itemId: string, body: unknown) =>
  apiPost<ItemUnit>(`/organization/catalog/items/${itemId}/units`, body);
export const removeItemUnit = (itemId: string, unitId: string) =>
  apiDelete(`/organization/catalog/items/${itemId}/units/${unitId}`);
/** مكوّنات الصنف — the bill of materials on the item card. */
export type ItemComponent = {
  itemId: string;
  componentItemId: string;
  sku: string;
  nameAr: string | null;
  qty: string;
  unitId: string;
  unitCode: string;
  unitNameAr: string | null;
  kind: string;
  warehouseId: string | null;
  warehouseName: string | null;
  baseUnitId: string;
};
export const listItemComponents = (itemId: string) =>
  apiList<ItemComponent>(`/organization/catalog/items/${itemId}/components`);
export const setItemComponent = (itemId: string, body: unknown) =>
  apiData<ItemComponent>(`/organization/catalog/items/${itemId}/components`, { method: 'POST', body: JSON.stringify(body) });
export const removeItemComponent = (itemId: string, componentItemId: string) =>
  apiData<{ deleted: boolean }>(`/organization/catalog/items/${itemId}/components/${componentItemId}`, { method: 'DELETE' });

export const listItemBarcodes = (itemId: string) =>
  apiList<ItemBarcode>(`/organization/catalog/items/${itemId}/barcodes`);
export const addItemBarcode = (itemId: string, body: unknown) =>
  apiPost<ItemBarcode>(`/organization/catalog/items/${itemId}/barcodes`, body);
export const removeItemBarcode = (itemId: string, barcode: string) =>
  apiDelete(`/organization/catalog/items/${itemId}/barcodes/${encodeURIComponent(barcode)}`);

/** تواريخ الصلاحية — what is on the shelf and when it stops being sellable. */
export type ExpiryRow = {
  lotId: string;
  lotNo: string;
  expiryDate: string;
  daysLeft: number;
  expired: boolean;
  itemId: string;
  sku: string;
  nameAr: string;
  warehouseId?: string | null;
  quantity: string;
};
export const expiryReport = (days = 30) => apiList<ExpiryRow>(`/inventory/expiry?days=${days}`);

/** One scan: which item, in which unit, and by what factor. */
export type ScanResult = {
  barcode: string;
  itemId: string;
  sku: string;
  nameAr: string;
  salePrice?: string | null;
  purchasePrice?: string | null;
  trackLot?: boolean;
  trackSerial?: boolean;
  unitId: string;
  unitNameAr?: string | null;
  factor: string;
  matchedBy: string;
};
export const scanBarcode = (code: string) =>
  apiData<ScanResult>(`/inventory/barcode/${encodeURIComponent(code.trim())}`);
/** بضاعة في الطريق — a transfer that left and never fully arrived. */
export type InTransitRow = {
  transferId: string;
  number: string;
  branchId?: string | null;
  fromWarehouseId: string;
  toWarehouseId: string;
  status: string;
  sentAt?: string | null;
  daysInTransit?: number | null;
  lineNo: number;
  itemId: string;
  sku?: string | null;
  nameAr?: string | null;
  unitId?: string | null;
  qty: string;
  baseQty: string;
  value: string;
};
export const inTransitReport = (warehouseId?: string) =>
  apiList<InTransitRow>(`/inventory/in-transit${warehouseId ? `?warehouse_id=${warehouseId}` : ''}`);
export const closeTransfer = (transferId: string, body: { mode: 'return' | 'shortage'; reason?: string }) =>
  apiPost<{
    transferId: string;
    number: string;
    status: string;
    mode: string;
    value: string;
    journalEntryId: string | null;
  }>(`/inventory/transfers/${transferId}/close`, body);

/** بطاقة الصنف — the item's ledger with a running balance. */
export type ItemCardRow = {
  id: string;
  itemId: string;
  sku?: string | null;
  itemNameAr?: string | null;
  warehouseId?: string | null;
  warehouseNameAr?: string | null;
  direction: 'in' | 'out';
  qty: string;
  baseQty: string;
  unitId?: string | null;
  unitNameAr?: string | null;
  factor: string;
  unitCost?: string | null;
  totalCost?: string | null;
  docType: string;
  docId: string;
  occurredAt: string;
  balanceQty: string;
  balanceValue: string;
  averageCost: string;
};
export type ItemCard = {
  itemId: string;
  sku?: string | null;
  nameAr?: string | null;
  warehouseId?: string | null;
  from?: string | null;
  to?: string | null;
  opening: { quantity: string; value: string };
  totals: { inQty: string; inValue: string; outQty: string; outValue: string };
  closing: { quantity: string; value: string };
  rows: ItemCardRow[];
};
export const itemCard = (params: { item_id: string; warehouse_id?: string; from?: string; to?: string }) => {
  const query = new URLSearchParams({ item_id: params.item_id });
  if (params.warehouse_id) query.set('warehouse_id', params.warehouse_id);
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);
  return apiData<ItemCard>(`/inventory/item-card?${query.toString()}`);
};

/** حركة المخزون — the same rows, narrowed to a period. */
export type MovementRow = Omit<ItemCardRow, 'balanceQty' | 'balanceValue' | 'averageCost'>;
export const movements = (params: {
  item_id?: string;
  warehouse_id?: string;
  from?: string;
  to?: string;
  limit?: number;
}) => {
  const query = new URLSearchParams();
  if (params.item_id) query.set('item_id', params.item_id);
  if (params.warehouse_id) query.set('warehouse_id', params.warehouse_id);
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);
  if (params.limit) query.set('limit', String(params.limit));
  const qs = query.toString();
  return apiList<MovementRow>(`/inventory/movements${qs ? `?${qs}` : ''}`);
};
export const listParties = (kind?: string) => apiList<Party>(`/parties${kind ? `?kind=${kind}` : ''}`);
export const listCashLocations = () => apiList<CashLocation>('/cash-locations');
/** 📁 الفئة — the مركب's group (`GroupMarine` in the desktop). */
export const listVesselGroups = () => apiList<VesselGroup>('/marina/groups');
export const listSalesmen = () => apiList<Salesman>('/sales/salesmen');
export const listCostCenters = () => apiList<CostCenter>('/cost-centers');
export const listAccounts = () => apiList<Account>('/accounts');
export const listPeriods = () => apiList<FiscalPeriod>('/fiscal-periods');
export const listEmployees = () => apiList<Employee>('/hrm/employees');
export const listLots = (filters: { itemId?: string; q?: string } = {}) => {
  const query = new URLSearchParams();
  if (filters.itemId) query.set('item_id', filters.itemId);
  if (filters.q) query.set('q', filters.q);
  const qs = query.toString();
  return apiList<Lot>(`/inventory/lots${qs ? `?${qs}` : ''}`);
};
export const deleteLot = (lotId: string) => apiDelete<{ deleted: boolean }>(`/inventory/lots/${lotId}`);
export const listSerials = (filters: { itemId?: string; status?: string; warehouseId?: string; q?: string } = {}) => {
  const query = new URLSearchParams();
  if (filters.itemId) query.set('item_id', filters.itemId);
  if (filters.status) query.set('status', filters.status);
  if (filters.warehouseId) query.set('warehouse_id', filters.warehouseId);
  if (filters.q) query.set('q', filters.q);
  const qs = query.toString();
  return apiList<Serial>(`/inventory/serials${qs ? `?${qs}` : ''}`);
};
/** ⚙️ توليد — a batch of serial numbers off one prefix (frmItemSerialNo's generator). */
export const generateSerials = (body: {
  itemId: string;
  prefix: string;
  startAt?: number;
  count: number;
  warehouseId?: string;
  lotId?: string;
}) => apiData<{ count: number; serialNos: string[] }>('/inventory/serials/generate', { method: 'POST', body: JSON.stringify(body) });
export const deleteSerial = (serialId: string) => apiDelete<{ deleted: boolean }>(`/inventory/serials/${serialId}`);
/** Which documents has this number travelled through? (`frmItemSerialNo.xaml.cs:524` reads them the same way.) */
export type SerialTrace = {
  serial: Serial;
  documents: Array<{ docType: string; docId: string; lineNo: number; createdAt: string }>;
};
export const traceSerial = (serialId: string) => apiData<SerialTrace>(`/inventory/serials/${serialId}/documents`);
export const reserveSerials = (serialIds: string[]) => apiData<{ status: string }>('/inventory/serials/reserve', { method: 'POST', body: JSON.stringify({ serialIds }) });
export const releaseSerials = (serialIds: string[]) => apiData<{ status: string }>('/inventory/serials/release', { method: 'POST', body: JSON.stringify({ serialIds }) });
export const consumeSerials = (serialIds: string[]) => apiData<{ status: string }>('/inventory/serials/consume', { method: 'POST', body: JSON.stringify({ serialIds }) });
export const returnSerials = (serialIds: string[]) => apiData<{ status: string }>('/inventory/serials/return', { method: 'POST', body: JSON.stringify({ serialIds }) });

export function branchOptions(rows: Branch[]): Option[] {
  return rows.map((row) => ({ id: row.id, label: `${row.code ? `${row.code} — ` : ''}${arabicName(row)}` }));
}
export function itemLabel(item: Item): string {
  return `${item.sku} — ${arabicName(item)}`;
}
export function partyLabel(party: Party): string {
  return `${party.code ? `${party.code} — ` : ''}${party.name}`;
}
export function cashLocationLabel(location: CashLocation): string {
  return `${location.kind === 'bank' ? '🏦' : '💵'} ${location.name}`;
}

/** The default branch/warehouse is what a single-branch tenant always wants preselected. */
export function defaultOf<T extends { isDefault?: boolean; is_default?: boolean }>(rows: T[]): T | undefined {
  return rows.find((row) => row.isDefault ?? row.is_default) ?? rows[0];
}

// ------------------------------------------------------------------ formatting

const decimal = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plain = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });

/** Money is carried as a string end-to-end; this only affects how it is displayed. */
export function money(value: string | number | null | undefined, currency?: string): string {
  if (value === null || value === undefined || value === '') return '—';
  const parsed = Number(value);
  const text = Number.isFinite(parsed) ? decimal.format(parsed) : String(value);
  return currency ? `${text} ${currency}` : text;
}

/** Start/end of a fiscal period, whichever spelling the endpoint used. */
export function periodRange(period: FiscalPeriod): { from: string; to: string } {
  return { from: period.startDate ?? period.start_date ?? '', to: period.endDate ?? period.end_date ?? '' };
}

export function quantity(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? plain.format(parsed) : String(value);
}

export function percent(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${plain.format(parsed * 100)}%` : String(value);
}

export function shortDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().slice(0, 10);
}

export function dateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A running money total computed in the browser — never sent to the API. */
export function amountLabel(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 10000) / 10000) : '0';
}

export const DOC_STATUS_LABELS: Record<string, string> = {
  draft: 'مسودة',
  posted: 'مرحّل',
  paid: 'مدفوع',
  voided: 'ملغي',
  cancelled: 'ملغي',
  reversed: 'معكوس',
  open: 'مفتوح',
  closed: 'مغلق',
  sent: 'مُرسل',
  received: 'مُستلم',
  approved: 'معتمد',
  pending: 'قيد الانتظار',
  active: 'نشط',
};

export function statusLabel(status?: string | null): string {
  if (!status) return '—';
  return DOC_STATUS_LABELS[status] ?? status;
}
