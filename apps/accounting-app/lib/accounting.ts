/**
 * M3 — typed, read-only API wrappers for the accounting app. Every call maps to an
 * existing GET endpoint; this milestone adds no backend and no writes.
 *
 * The rows are rendered defensively (optional fields, both casing conventions) because
 * the API has grown both camelCase DTOs and raw snake_case rows — same tolerance the
 * staff panel's `lib/accounts.ts` applies.
 */
import { apiData } from '@erp/web-core/api';

// ------------------------------------------------------------------- accounts

export type Account = {
  id: string;
  code: string;
  nameAr?: string;
  nameEn?: string;
  name_ar?: string;
  name_en?: string;
  type?: string;
  accountType?: string;
  parentId?: string | null;
  parent_id?: string | null;
  isPostable?: boolean;
  is_postable?: boolean;
  parentName?: string | null;
  balance?: {
    debit?: string;
    credit?: string;
    balance?: string;
  };
};

export const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  asset: 'أصول',
  liability: 'خصوم',
  equity: 'حقوق ملكية',
  revenue: 'إيرادات',
  expense: 'مصروفات',
};

export function nameOf(account: Account): string {
  return account.nameAr ?? account.name_ar ?? account.nameEn ?? account.name_en ?? account.code;
}
export function typeOf(account: Account): string {
  return account.type ?? account.accountType ?? '';
}
export function parentOf(account: Account): string | null {
  return account.parentId ?? account.parent_id ?? null;
}
export function postableOf(account: Account): boolean {
  return account.isPostable ?? account.is_postable ?? true;
}

export function listAccounts(filters: { q?: string; type?: string } = {}): Promise<Account[]> {
  const params = new URLSearchParams({ with_balances: '1' });
  if (filters.q?.trim()) params.set('q', filters.q.trim());
  if (filters.type) params.set('type', filters.type);
  return apiData<Account[]>(`/accounts?${params.toString()}`);
}

// ------------------------------------------------------------------- journals

export type JournalEntry = {
  id: string;
  number?: string | number;
  entryNo?: string;
  entry_date?: string;
  entryDate?: string;
  postedAt?: string;
  posted_at?: string;
  status?: string;
  totalDebit?: string;
  total_debit?: string;
  totalCredit?: string;
  total_credit?: string;
  description?: string;
  notes?: string;
  branchName?: string | null;
  branch_name?: string | null;
  fiscalPeriodName?: string | null;
};

export function listJournalEntries(filters: { from?: string; to?: string; status?: string; limit?: number } = {}): Promise<JournalEntry[]> {
  const params = new URLSearchParams();
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.status) params.set('status', filters.status);
  if (filters.limit) params.set('limit', String(filters.limit));
  const query = params.toString();
  return apiData<JournalEntry[]>(`/journal-entries${query ? `?${query}` : ''}`);
}

// -------------------------------------------------------------------- periods

export type FiscalPeriod = {
  id: string;
  name?: string;
  periodName?: string;
  startDate?: string;
  start_date?: string;
  endDate?: string;
  end_date?: string;
  isActive?: boolean;
  is_active?: boolean;
  isClosed?: boolean;
  is_closed?: boolean;
  closedByName?: string | null;
  closed_by_name?: string | null;
  closedAt?: string | null;
  closed_at?: string | null;
  notes?: string | null;
};

export function listPeriods(): Promise<FiscalPeriod[]> {
  return apiData<FiscalPeriod[]>('/fiscal-periods');
}

export type FiscalYear = {
  id: string;
  name?: string;
  yearName?: string;
  startDate?: string;
  endDate?: string;
  status?: string;
};

export function listFiscalYears(): Promise<FiscalYear[]> {
  return apiData<FiscalYear[]>('/fiscal-years');
}

// ---------------------------------------------------------------- statements

export type TrialBalanceRow = {
  accountId?: string;
  account_id?: string;
  code?: string;
  nameAr?: string;
  name_ar?: string;
  accountName?: string;
  openingDebit?: string;
  opening_debit?: string;
  openingCredit?: string;
  opening_credit?: string;
  periodDebit?: string;
  period_debit?: string;
  periodCredit?: string;
  period_credit?: string;
  closingDebit?: string;
  closing_debit?: string;
  closingCredit?: string;
  closing_credit?: string;
};

export type TrialBalanceTotals = {
  openingDebit?: string;
  opening_debit?: string;
  openingCredit?: string;
  opening_credit?: string;
  periodDebit?: string;
  period_debit?: string;
  periodCredit?: string;
  period_credit?: string;
  closingDebit?: string;
  closing_debit?: string;
  closingCredit?: string;
  closing_credit?: string;
};

export function trialBalance(filters: { from?: string; to?: string } = {}): Promise<{ rows: TrialBalanceRow[]; totals: TrialBalanceTotals }> {
  const params = new URLSearchParams();
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  const query = params.toString();
  return apiData(`/statements/trial-balance${query ? `?${query}` : ''}`);
}

export type IncomeStatementRow = {
  code?: string;
  nameAr?: string;
  name_ar?: string;
  accountName?: string;
  amount?: string;
  total?: string;
  kind?: string;
};

export function incomeStatement(filters: { from?: string; to?: string } = {}): Promise<IncomeStatementRow[]> {
  const params = new URLSearchParams();
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  const query = params.toString();
  return apiData<IncomeStatementRow[]>(`/statements/income-statement${query ? `?${query}` : ''}`);
}

// -------------------------------------------------------------- cost centres

export type CostCenter = {
  id: string;
  code?: string;
  nameAr?: string;
  name_ar?: string;
  nameEn?: string;
  name_en?: string;
  parentId?: string | null;
  parent_id?: string | null;
  isActive?: boolean;
  is_active?: boolean;
  balance?: {
    debit?: string;
    credit?: string;
    balance?: string;
  };
};

export function nameOfCost(center: CostCenter): string {
  return center.nameAr ?? center.name_ar ?? center.nameEn ?? center.name_en ?? center.code ?? '';
}

export function listCostCenters(filters: { q?: string } = {}): Promise<CostCenter[]> {
  const params = new URLSearchParams({ with_balances: '1' });
  if (filters.q?.trim()) params.set('q', filters.q.trim());
  return apiData<CostCenter[]>(`/cost-centers?${params.toString()}`);
}

// --------------------------------------------------------------- ZATCA desk

export type EinvoiceSettings = {
  sellerName?: string;
  vatNumber?: string;
  environment?: string;
  linked?: boolean;
  linkedAt?: string | null;
  address?: string | null;
  city?: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
};

export type EinvoiceFiling = {
  id: string;
  invoiceNumber?: string | number;
  invoice_number?: string;
  status?: string;
  totalAmount?: string;
  total_amount?: string;
  vatAmount?: string;
  vat_amount?: string;
  submittedAt?: string;
  submitted_at?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
};

export function einvoiceSettings(): Promise<EinvoiceSettings> {
  return apiData<EinvoiceSettings>('/einvoice/settings');
}

export function einvoiceFilings(filters: { status?: string } = {}): Promise<EinvoiceFiling[]> {
  const query = filters.status ? `?status=${encodeURIComponent(filters.status)}` : '';
  return apiData<EinvoiceFiling[]>(`/einvoice/filings${query}`);
}

// --------------------------------------------------------------- entitlement

export type MarketplaceAppView = {
  code: string;
  isCore: boolean;
  isActive: boolean;
  enabled: boolean;
  installedAt: string | null;
};

export type MarketplaceList = {
  apps: MarketplaceAppView[];
};

/**
 * D-002 — the accounting app is entitlement-controlled through the marketplace catalog
 * (`tenant_apps`), never through new tenancy. Rule, derived from what `/marketplace/apps`
 * reports:
 *   • installed + enabled → entitled;
 *   • core bundle with **no** install row → entitled (it ships with the system);
 *   • an explicit install row that is disabled → NOT entitled (operator control);
 *   • non-core, not installed → NOT entitled.
 */
export function accountingAppEntitled(app: MarketplaceAppView | undefined): boolean {
  if (!app) return false;
  if (app.enabled) return true;
  return app.isCore && app.installedAt === null;
}

export function fetchAccountingEntitlement(): Promise<boolean> {
  return apiData<MarketplaceList>('/marketplace/apps').then((list) =>
    accountingAppEntitled(list.apps?.find((app) => app.code === 'accounting')),
  );
}
