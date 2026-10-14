import { apiData, apiDelete, apiList } from './api';

export type EcommerceProvider = 'salla' | 'zid' | 'shopify';
export type EcommerceProviderView = { provider: EcommerceProvider; label: string; supports: string[] };
export type EcommerceStore = {
  id: string;
  provider: EcommerceProvider;
  storeUrl: string | null;
  remoteStoreId: string | null;
  status: string;
  settings: Record<string, unknown>;
  hasAccessToken: boolean;
  accessTokenMasked: string;
  hasRefreshToken: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
};
export type EcommerceOrder = {
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

export async function ecommerceProviders(): Promise<EcommerceProviderView[]> {
  return apiList<EcommerceProviderView>('/ecommerce/providers');
}

export async function ecommerceStores(): Promise<EcommerceStore[]> {
  return apiList<EcommerceStore>('/ecommerce/stores');
}

export async function connectEcommerceStore(body: {
  provider: EcommerceProvider;
  apiKey: string;
  storeUrl?: string;
  webhookSecret?: string;
  settings?: { branchId?: string; warehouseId?: string };
}): Promise<EcommerceStore> {
  return apiData<EcommerceStore>('/ecommerce/stores', { method: 'POST', body: JSON.stringify(body) });
}

export async function syncEcommerceStore(
  id: string,
): Promise<{ fetched: number; created: number; skipped: number; imported: number; failed: number }> {
  return apiData(`/ecommerce/stores/${id}/sync`, { method: 'POST', body: JSON.stringify({}) });
}

export async function deleteEcommerceStore(id: string): Promise<void> {
  await apiDelete(`/ecommerce/stores/${id}`);
}

export async function ecommerceOrders(
  filters: { storeId?: string; status?: string } = {},
): Promise<EcommerceOrder[]> {
  const query = new URLSearchParams();
  if (filters.storeId) query.set('store_id', filters.storeId);
  if (filters.status) query.set('status', filters.status);
  return apiList<EcommerceOrder>(`/ecommerce/orders${query.toString() ? `?${query}` : ''}`);
}
