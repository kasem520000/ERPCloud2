/**
 * Legacy/Android sync plane helpers.
 *
 * Devices authenticate with an API key, pull master data with a cursor and push
 * documents back; everything below is the operator-facing view of that exchange.
 */
import { apiData } from './api';

export type SyncDevice = {
  id: string;
  name: string;
  branchId: string;
  branchName: string | null;
  status: string;
  lastSeenAt: string | null;
  cursors: Record<string, { updatedAt: string; id: string }>;
};

export type SyncOverview = {
  devices: SyncDevice[];
  inbound: Array<{ entity: string; received: number; last_at: string | null }>;
  master: Array<{ entity: string; available: number; last_at: string | null }>;
};

export type SyncDocument = {
  id: string;
  number?: string | null;
  legacyId?: string | null;
  kind?: string | null;
  date?: string | null;
  occurredAt?: string | null;
  updatedAt?: string | null;
  status?: string | null;
  paymentStatus?: string | null;
  amount?: string | null;
  total?: string | null;
  qty?: string | null;
  totalCost?: string | null;
  direction?: string | null;
  docType?: string | null;
  itemName?: string | null;
  warehouseName?: string | null;
};

export const SYNC_ENTITY_LABELS: Record<string, string> = {
  invoices: 'الفواتير',
  vouchers: 'السندات',
  journals: 'القيود',
  stock: 'المخزون',
  items: 'المواد',
  parties: 'العملاء والموردون',
  accounts: 'دليل الحسابات',
  'tax-groups': 'المجموعات الضريبية',
};

export const SYNC_DOCUMENT_ENTITIES = ['invoices', 'vouchers', 'journals', 'stock'];

export const fetchSyncOverview = () => apiData<SyncOverview>('/compat/sync/overview');
export const fetchSyncDocuments = (entity: string) => apiData<SyncDocument[]>(`/compat/sync/documents?entity=${encodeURIComponent(entity)}`);
