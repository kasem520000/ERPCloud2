/**
 * Derivations for the dashboard — one fetch of the sales invoice list plus the
 * inventory signals, then pure math. The API has no "dashboard" endpoint, so the
 * panel assembles the same KPIs the old tile-based home showed, from the same
 * data the invoice list page renders (one source of truth, no drift).
 *
 * Dates are compared in **UTC** to match server-side behaviour (the sandbox and
 * the API both think in UTC; Riyadh = UTC+3 without DST).
 */
import { apiList } from './api';
import { listBranches, listParties, type Branch, type Party } from './lookups';

export type DashboardInvoice = {
  id: string;
  number: string | null;
  kind: string;
  status: string;
  branchId: string | null;
  partyId: string | null;
  cashCustomerName: string | null;
  total: string;
  paidTotal: string;
  paymentStatus: string;
  postedAt: string | null;
  createdAt: string;
};

export type LowStockRow = {
  itemId: string;
  sku: string;
  nameAr: string;
  warehouseId: string;
  quantity: string;
  minQty: string;
  shortage: string;
};

export type ExpiryRow = Record<string, unknown>;

export type DashboardData = {
  invoices: DashboardInvoice[];
  branches: Branch[];
  parties: Party[];
  lowStock: LowStockRow[];
  expiry: ExpiryRow[];
};

export async function fetchDashboardData(): Promise<DashboardData> {
  const [invoices, branches, parties, lowStock, expiry] = await Promise.all([
    apiList<DashboardInvoice>('/sales/invoices'),
    listBranches(),
    listParties('customer'),
    apiList<LowStockRow>('/inventory/below-minimum'),
    apiList<ExpiryRow>('/inventory/expiry').catch(() => []),
  ]);
  return { invoices, branches, parties, lowStock, expiry };
}

const DAY_MS = 86_400_000;
const num = (value: string | null | undefined) => Number(value ?? 0) || 0;

export function greeting(): { time: string; first: string } {
  const hour = new Date().getUTCHours();
  const time = hour < 12 ? 'صباح الخير' : hour < 17 ? 'مساء الخير' : 'مساء الخير';
  return { time, first: '' };
}

export type DashboardStats = {
  todaySales: number;
  todayCount: number;
  yesterdaySales: number;
  monthSales: number;
  monthCount: number;
  lastMonthSales: number;
  receivable: number;
  overdueInvoices: number;
  overdueCustomers: number;
  unpaidInvoices: number;
  lowStockCount: number;
  nearExpiryCount: number;
  /** Last 7 days (oldest → today), each { label, date, total, count }. */
  week: Array<{ key: string; label: string; total: number; count: number }>;
  weekSpark: number[];
  /** All-time weekly totals for the sales sparkline. */
  branchTotals: Array<{ branchId: string; label: string; total: number; count: number }>;
  lastInvoices: DashboardInvoice[];
};

const WEEKDAY_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

export function computeStats(data: DashboardData, now = new Date()): DashboardStats {
  const postedSales = data.invoices.filter((row) => row.kind === 'sale' && row.status === 'posted');

  const byDay = new Map<string, { total: number; count: number }>();
  for (const row of postedSales) {
    const date = row.postedAt ?? row.createdAt;
    const day = new Date(date).toISOString().slice(0, 10);
    const entry = byDay.get(day) ?? { total: 0, count: 0 };
    entry.total += num(row.total);
    entry.count += 1;
    byDay.set(day, entry);
  }

  const todayKey = now.toISOString().slice(0, 10);
  const week: DashboardStats['week'] = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(now.getTime() - i * DAY_MS);
    const key = d.toISOString().slice(0, 10);
    const entry = byDay.get(key) ?? { total: 0, count: 0 };
    week.push({
      key,
      label: i === 0 ? 'اليوم' : i === 1 ? 'أمس' : (WEEKDAY_AR[d.getUTCDay()] ?? '—'),
      total: Math.round(entry.total),
      count: entry.count,
    });
  }

  const monthKey = now.toISOString().slice(0, 7);
  const lastMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
  const lastMonthKey = lastMonthDate.toISOString().slice(0, 7);

  let monthSales = 0;
  let monthCount = 0;
  let lastMonthSales = 0;
  for (const row of postedSales) {
    const date = row.postedAt ?? row.createdAt;
    const key = date.slice(0, 7);
    if (key === monthKey) {
      monthSales += num(row.total);
      monthCount += 1;
    } else if (key === lastMonthKey) {
      lastMonthSales += num(row.total);
    }
  }

  const unpaid = postedSales.filter((row) => num(row.total) > num(row.paidTotal));
  const receivable = unpaid.reduce((sum, row) => sum + (num(row.total) - num(row.paidTotal)), 0);
  const overduePartyIds = new Set(unpaid.map((row) => row.partyId).filter(Boolean));

  const branchMap = new Map<string, { label: string; total: number; count: number }>();
  for (const branch of data.branches) branchMap.set(branch.id, { label: branch.nameAr ?? branch.nameEn ?? branch.code ?? branch.id, total: 0, count: 0 });
  for (const row of postedSales) {
    if (!row.branchId) continue;
    const entry = branchMap.get(row.branchId) ?? { label: '—', total: 0, count: 0 };
    entry.total += num(row.total);
    entry.count += 1;
    branchMap.set(row.branchId, entry);
  }

  return {
    todaySales: Math.round(byDay.get(todayKey)?.total ?? 0),
    todayCount: byDay.get(todayKey)?.count ?? 0,
    yesterdaySales: Math.round(byDay.get(new Date(now.getTime() - DAY_MS).toISOString().slice(0, 10))?.total ?? 0),
    monthSales: Math.round(monthSales),
    monthCount,
    lastMonthSales: Math.round(lastMonthSales),
    receivable: Math.round(receivable),
    overdueInvoices: unpaid.length,
    overdueCustomers: overduePartyIds.size,
    unpaidInvoices: unpaid.length,
    lowStockCount: data.lowStock.length,
    nearExpiryCount: data.expiry.length,
    week,
    weekSpark: week.map((entry) => entry.total),
    branchTotals: [...branchMap.entries()]
      .map(([branchId, entry]) => ({ branchId, ...entry, total: Math.round(entry.total) }))
      .filter((entry) => entry.total > 0)
      .sort((a, b) => b.total - a.total),
    lastInvoices: [...postedSales]
      .sort((a, b) => (b.postedAt ?? b.createdAt).localeCompare(a.postedAt ?? a.createdAt))
      .slice(0, 5),
  };
}

export function partyName(row: DashboardInvoice, parties: Party[]): string {
  if (row.cashCustomerName) return `${row.cashCustomerName} (نقدي)`;
  const party = parties.find((entry) => entry.id === row.partyId);
  return party ? party.name : '—';
}
