/**
 * M5 — the exact wire shapes of the M4 field-sync contract, mirrored client-side.
 *
 * These types are deliberately hand-written from
 * `apps/api/src/modules/field-sync/field-sync-snapshot.service.ts` and
 * `field-sync-replay.service.ts` (and pinned by `tests/offline.spec.ts`): the app's
 * acceptance gate is "the payloads this app builds are the payloads that API's specs
 * replay". Money and quantities are strings end-to-end (PROJECT_CONTRACT §3).
 */

export type RepCard = {
  salesmanId: string;
  salesmanName: string;
  warehouseId: string;
  vehiclePlate: string | null;
};

export type RepCustomer = {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  email: string | null;
  taxNo: string | null;
  branchId: string | null;
  creditLimit: string;
  isOwner: boolean;
};

export type RepCustomerPrice = {
  partyId: string;
  itemId: string | null;
  priceTierLabel: string;
  unitPrice: string;
  maxBonusPct: string;
  maxBonusQty: string;
  maxBonusKgPerInvoice: string;
  expectedDailyQty: string;
  preferredInvoiceMode: string;
  creditLimit: string;
  paymentTermsDays: string;
  lockPrice: boolean;
  maxDiscountPct: string;
  effectiveFrom: string;
  effectiveTo: string | null;
};

export type RepItem = {
  id: string;
  sku: string;
  barcode: string | null;
  nameAr: string;
  nameEn: string | null;
  categoryId: string | null;
  baseUnitId: string;
  kind: string;
  salePrice: string | null;
  purchasePrice: string | null;
  taxGroupId: string | null;
  trackLot: boolean;
  weightedScale: boolean;
  showInPos: boolean;
};

export type RepUnit = { id: string; code: string; nameAr: string; nameEn: string };
export type RepTax = {
  id: string;
  nameAr: string;
  nameEn: string;
  rate: string;
  isInclusiveDefault: boolean;
};
export type RepItemUnit = {
  itemId: string;
  unitId: string;
  ratio: string;
  barcode: string | null;
  salePrice: string | null;
  isDefaultSale: boolean;
};
export type RepBarcode = { barcode: string; itemId: string; unitId: string | null };
export type RepPriceList = {
  id: string;
  name: string;
  currencyCode: string;
  isDefault: boolean;
};
export type RepPriceListItem = {
  id: string;
  priceListId: string;
  itemId: string | null;
  unitId: string | null;
  unitPrice: string;
  minQty: string;
};
export type RepPaymentMethod = {
  id: string;
  code: string;
  nameAr: string;
  kind: string;
  dueDays: string;
  cashLocationId: string | null;
  isDefault: boolean;
};
export type RepStockRow = {
  itemId: string;
  warehouseId: string;
  quantity: string;
  value: string;
  averageCost: string;
};
export type RepOpenLoadOrder = {
  id: string;
  number: string;
  loadDate: string;
  status: string;
  itemId: string | null;
  warehouseId: string | null;
  vanWarehouseId: string | null;
  productionBatchNo: string;
  loadedQty: string;
  receivedQty: string;
  soldQty: string;
  bonusQty: string;
  returnedQty: string;
  damagedQty: string;
  expectedCash: string;
  collectedCash: string;
  stockTransferId: string | null;
};
export type RepOpenCreditDocument = {
  id: string;
  number: string;
  docDate: string;
  partyId: string | null;
  customerName: string;
  itemId: string | null;
  soldQty: string;
  unitPrice: string;
  total: string;
  paidAmount: string;
  outstanding: string;
  salesInvoiceId: string | null;
  loadOrderId: string | null;
};

/** `GET /field-sync/snapshot` → `{ data: RepSnapshot }`. */
export type RepSnapshot = {
  schemaVersion: number;
  generatedAt: string;
  watermark: string;
  expiresInSeconds: number;
  rep: RepCard;
  customers: RepCustomer[];
  customerPrices: RepCustomerPrice[];
  items: RepItem[];
  units: RepUnit[];
  taxes: RepTax[];
  itemUnits: RepItemUnit[];
  barcodes: RepBarcode[];
  priceLists: RepPriceList[];
  priceListItems: RepPriceListItem[];
  paymentMethods: RepPaymentMethod[];
  stock: RepStockRow[];
  openLoadOrders: RepOpenLoadOrder[];
  openCreditDocuments: RepOpenCreditDocument[];
};

/** `GET /field-sync/delta` → `{ data: RepDelta }`. */
export type RepDelta = {
  since: string;
  watermark: string;
  changed: {
    customers: RepCustomer[];
    customerPrices: RepCustomerPrice[];
    items: RepItem[];
    units: RepUnit[];
    taxes: RepTax[];
    priceLists: RepPriceList[];
    priceListItems: RepPriceListItem[];
    paymentMethods: RepPaymentMethod[];
  };
  deleted: {
    customers: string[];
    customerPrices: Array<{ partyId: string; itemId: string | null }>;
    items: string[];
    units: string[];
    taxes: string[];
    priceLists: string[];
    paymentMethods: string[];
  };
  full: {
    itemUnits: RepItemUnit[];
    barcodes: RepBarcode[];
    stock: RepStockRow[];
    openLoadOrders: RepOpenLoadOrder[];
    openCreditDocuments: RepOpenCreditDocument[];
  };
};

/** The four replay operations (`POST /field-sync/replay`). */
export type RepOperationKind = 'invoice' | 'collection' | 'return' | 'receipt';

export type RepInvoicePayload = {
  loadOrderId: string;
  partyId?: string;
  customerName?: string;
  itemId?: string;
  invoiceMode?: 'zatca_tax' | 'internal_delivery';
  paymentMethod?: 'cash' | 'card' | 'credit';
  cashLocationId?: string;
  soldQty: string;
  bonusQty?: string;
  bonusReason?: string;
  unitPrice: string;
  discountAmount?: string;
  discountReason?: string;
  notes?: string;
};

export type RepCollectionPayload = {
  documentId?: string;
  sourceOfflineId?: string;
  collectedAmount: string;
  cashLocationId?: string;
  offsetAccountId?: string;
  notes?: string;
};

export type RepReturnPayload = {
  documentId?: string;
  sourceOfflineId?: string;
  returnedQty: string;
  reason?: string;
  notes?: string;
};

export type RepReceiptPayload = {
  loadOrderId: string;
  receivedQty: string;
  notes?: string;
};

export type RepOperationPayload =
  | RepInvoicePayload
  | RepCollectionPayload
  | RepReturnPayload
  | RepReceiptPayload;

/** One queued row exactly as the replay endpoint expects it. */
export type RepOperation = {
  offlineId: string;
  deviceId: string;
  sequenceNo: number;
  operation: RepOperationKind;
  payload: RepOperationPayload;
  createdAt: string;
};

export type RepSyncResult = {
  offlineId: string;
  sequenceNo: number | null;
  status: 'synced' | 'conflict';
  operation?: RepOperationKind;
  documentId?: string | null;
  documentNumber?: string | null;
  total?: string | null;
  salesInvoiceId?: string | null;
  invoiceNumber?: string | null;
  movementId?: string | null;
  amount?: string | null;
  voucherId?: string | null;
  voucherNumber?: string | null;
  voucherStatus?: string | null;
  loadOrderId?: string | null;
  loadOrderStatus?: string | null;
  receivedQty?: string | null;
  result?: Record<string, unknown> | null;
  errorCode?: string | null;
  message?: string | null;
  resolution?: Record<string, unknown> | null;
};

export type RepSyncResponse = {
  processed: number;
  synced: number;
  conflicts: number;
  results: RepSyncResult[];
};

/** The device's own queue record (what the queue screen renders). */
export type RepQueueRecord = {
  offlineId: string;
  deviceId: string;
  sequenceNo: number;
  createdAt: string;
  operation: RepOperationKind;
  payload: RepOperationPayload;
  status: 'pending' | 'synced' | 'conflict';
  documentId?: string | null;
  documentNumber?: string | null;
  total?: string | null;
  invoiceNumber?: string | null;
  voucherNumber?: string | null;
  errorCode?: string | null;
  message?: string | null;
  resolution?: Record<string, unknown> | null;
  syncedAt?: string | null;
};

/** `GET /rep-workspace/day` → `{ data: RepDay }` (online surfaces). */
export type RepDay = {
  date: string;
  salesmanId: string;
  salesmanName: string;
  documents: Array<{
    id: string;
    number: string;
    documentKind: string;
    invoiceMode: string;
    paymentMethod: string;
    partyId: string | null;
    customerName: string;
    itemId: string | null;
    itemName: string;
    soldQty: string;
    bonusQty: string;
    unitPrice: string;
    subtotal: string;
    taxTotal: string;
    total: string;
    paidAmount: string;
    salesInvoiceId: string | null;
    invoiceNumber: string | null;
    invoiceStatus: string | null;
  }>;
  collections: Array<{
    id: string;
    collectedAt: string;
    amount: string;
    reason: string;
    voucherId: string | null;
    voucherNumber: string | null;
    voucherStatus: string | null;
  }>;
  totals: {
    documents: number;
    returns: number;
    revenue: string;
    cashSales: string;
    creditSales: string;
    collectedOnDocuments: string;
    collections: string;
    outstanding: string;
  };
  visits: Array<{
    customerName: string;
    partyId: string | null;
    documents: number;
    returns: number;
    revenue: string;
    collected: string;
  }>;
};

/** `GET /rep-workspace/custody` → `{ data: RepCustody }` (online surfaces). */
export type RepCustody = {
  salesmanId: string;
  salesmanName: string;
  warehouseId: string;
  vehiclePlate: string | null;
  balances: Array<{
    itemId: string;
    itemName: string;
    sku: string;
    warehouseId: string;
    warehouseName: string;
    quantity: string;
    value: string;
    averageCost: string;
  }>;
  custodyKg: string;
  custodyValue: string;
  openLoadOrders: Array<{
    id: string;
    number: string;
    loadDate: string;
    status: string;
    itemId: string | null;
    itemName: string;
    productionBatchNo: string;
    loadedQty: string;
    receivedQty: string;
    soldQty: string;
    bonusQty: string;
    returnedQty: string;
    damagedQty: string;
    shortageQty: string;
    expectedCash: string;
    collectedCash: string;
    outstandingCash: string;
    expectedRemainingQty: string;
    actualRemainingQty: string;
    stockSettlementStatus: string;
  }>;
};

/** `GET /field-sync/queue` rows (the server-side conflict inbox). */
export type RepServerQueueRow = {
  id: string;
  deviceId: string;
  offlineId: string;
  sequenceNo: string;
  operation: string;
  status: string;
  result: Record<string, unknown> | null;
  documentId: string | null;
  errorCode: string | null;
  errorDetail: string | null;
  createdAt: string;
  syncedAt: string | null;
};
