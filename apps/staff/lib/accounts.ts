import { apiData } from './api';

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
  currencyCode?: string | null;
  level?: number;
  branchId?: string | null;
  normalBalance?: string | null;
  /** 📅 تاريخ فتح الحساب · 💰 الرصيد الافتتاحي · 📊 مركز التكلفة — `frmAccountsTree` (migration 0045). */
  openedAt?: string | null;
  openingBalance?: string | null;
  costCenterId?: string | null;
  /** 📋 تفاصيل الحسابات — the parent's name, not its uuid (`frmAccountsDirectory`). */
  parentName?: string | null;
  /**
   * الرصيد — only present when the directory is read with `with_balances=1`, and only
   * ever counted from **posted** entries, rolled up the account's `ltree` path.
   */
  balance?: {
    ownDebit?: string;
    ownCredit?: string;
    ownBalance?: string;
    debit?: string;
    credit?: string;
    balance?: string;
    descendants?: number;
  };
};

/** الرصيد as a number, or 0 when the row carries none. */
export function balanceOf(account: Account): number {
  return Number(account.balance?.balance ?? 0);
}

/** The API has grown both camelCase DTOs and raw snake_case rows; tolerate both. */
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

export const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  asset: 'أصول',
  liability: 'خصوم',
  equity: 'حقوق ملكية',
  revenue: 'إيرادات',
  expense: 'مصروفات',
};

export function listAccounts(query = ''): Promise<Account[]> {
  return apiData<Account[]>(`/accounts${query ? `?${query}` : ''}`);
}

/** 📂 شجرة الحسابات — the directory read with every node's balance. */
export function listAccountDirectory(filters: { q?: string; type?: string; branchId?: string } = {}): Promise<Account[]> {
  const params = new URLSearchParams({ with_balances: '1' });
  if (filters.q?.trim()) params.set('q', filters.q.trim());
  if (filters.type) params.set('type', filters.type);
  if (filters.branchId) params.set('branch_id', filters.branchId);
  return apiData<Account[]>(`/accounts?${params.toString()}`);
}

export function accountLabel(account: Account): string {
  return `${account.code} — ${nameOf(account)}`;
}

/** Downloads any array of flat rows as UTF-8 CSV (Excel-friendly BOM). */
export function downloadCsv(fileName: string, headers: string[], rows: Array<Array<string | number>>): void {
  const escape = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
  const content = [headers.map(escape).join(','), ...rows.map((row) => row.map(escape).join(','))].join('\n');
  const blob = new Blob(['\uFEFF' + content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
