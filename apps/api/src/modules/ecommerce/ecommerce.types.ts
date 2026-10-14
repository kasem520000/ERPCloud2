export const ECOMMERCE_PROVIDERS = ['salla', 'zid', 'shopify'] as const;
export type EcommerceProvider = (typeof ECOMMERCE_PROVIDERS)[number];

export type RemoteOrderLine = {
  id?: string;
  name: string;
  sku?: string;
  quantity: string;
  unitPrice: string;
  itemId?: string;
};

export type RemoteOrder = {
  id: string;
  orderNo?: string;
  status?: string;
  customerName?: string;
  customerMobile?: string;
  currency?: string;
  total: string;
  lines: RemoteOrderLine[];
  raw?: Record<string, unknown>;
};

export type EcommerceStoreSettings = {
  branchId?: string;
  warehouseId?: string;
  [key: string]: unknown;
};

export type EcommerceStoreInput = {
  provider: EcommerceProvider;
  apiKey?: string;
  code?: string;
  storeUrl?: string;
  refreshToken?: string;
  webhookSecret?: string;
  remoteStoreId?: string;
  settings?: EcommerceStoreSettings;
};

export type EcommerceStoreDto = {
  id: string;
  provider: EcommerceProvider;
  storeUrl: string | null;
  remoteStoreId: string | null;
  status: string;
  settings: EcommerceStoreSettings;
  hasAccessToken: boolean;
  accessTokenMasked: string;
  hasRefreshToken: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
};

export type EcommerceOrderDto = {
  id: string;
  storeId: string;
  provider: EcommerceProvider;
  remoteId: string;
  remoteOrderNo: string | null;
  remoteStatus: string | null;
  status: string;
  customerName: string | null;
  customerMobile: string | null;
  currency: string;
  total: string;
  payload: Record<string, unknown>;
  erpInvoiceId: string | null;
  error: string | null;
  receivedAt: string;
  importedAt: string | null;
};

export type SyncResult = {
  storeId: string;
  provider: EcommerceProvider;
  fetched: number;
  created: number;
  skipped: number;
  imported: number;
  failed: number;
  logId: string;
};
