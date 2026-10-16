/**
 * M6.4 — budget wrappers for the accounting app. The writes (create, replace-lines,
 * approve, delete-draft) map 1:1 onto the `BudgetsModule` endpoints and live ONLY here —
 * same contract as `lib/assets.ts`: pages never touch the API client, and money stays
 * decimal text end-to-end. The variance report is read-only and computed server-side
 * from the posted ledger; this module never recomputes it.
 */
import { apiData, apiDelete, apiPatch, apiPost } from '@erp/web-core/api';

// ---------------------------------------------------------------------- types

export type Budget = {
  id: string;
  name: string;
  status?: string;
  notes?: string | null;
  fiscalYearId?: string;
  fiscalYearName?: string;
  fiscalYearStart?: string;
  fiscalYearEnd?: string;
  approvedAt?: string | null;
  totalAmount?: string;
};

export type BudgetLine = {
  id?: string;
  accountId?: string;
  accountCode?: string;
  accountNameAr?: string;
  accountType?: string;
  fiscalPeriodId?: string;
  periodName?: string;
  periodStart?: string;
  periodEnd?: string;
  amount?: string;
};

export type BudgetCard = Budget & { lines?: BudgetLine[] };

export type VarianceRow = {
  accountId: string;
  accountCode?: string;
  accountNameAr?: string;
  accountType?: string;
  budgeted?: string;
  actual?: string;
  variance?: string;
  variancePct?: string | null;
  inBudget?: boolean;
};

export type VarianceReport = {
  budget?: { id?: string; name?: string; status?: string; fiscalYearName?: string };
  from?: string;
  to?: string;
  rows?: VarianceRow[];
  totals?: { budgetedResult?: string; actualResult?: string; variance?: string };
};

export const BUDGET_STATUS_LABELS: Record<string, string> = {
  draft: 'مسودة',
  approved: 'معتمدة',
};

export function statusLabelOf(budget: Budget): string {
  return BUDGET_STATUS_LABELS[budget.status ?? 'draft'] ?? (budget.status ?? '');
}

// ------------------------------------------------------------------- wrappers

export function listBudgets(): Promise<Budget[]> {
  return apiData<Budget[]>('/budgets');
}

export function createBudget(input: {
  name: string;
  fiscalYearId: string;
  notes?: string;
  lines: Array<{ accountId: string; annualAmount: string }>;
}): Promise<BudgetCard> {
  return apiPost<BudgetCard>('/budgets', input);
}

export function readBudget(id: string): Promise<BudgetCard> {
  return apiData<BudgetCard>(`/budgets/${encodeURIComponent(id)}`);
}

/** الاستبدال الكامل للسطور الشهرية — للمسودة فقط (المعتمدة مجمدة). */
export function replaceBudgetLines(
  id: string,
  lines: Array<{ accountId: string; fiscalPeriodId: string; amount: string }>,
): Promise<BudgetCard> {
  return apiPatch<BudgetCard>(`/budgets/${encodeURIComponent(id)}`, { lines });
}

export function approveBudget(id: string): Promise<BudgetCard> {
  return apiPatch<BudgetCard>(`/budgets/${encodeURIComponent(id)}`, { status: 'approved' });
}

/** حذف ناعم للمسودة وحدها. */
export function deleteDraftBudget(id: string): Promise<{ id: string }> {
  return apiDelete<{ id: string }>(`/budgets/${encodeURIComponent(id)}`);
}

export function budgetVariance(id: string, to?: string): Promise<VarianceReport> {
  const query = to ? `?to=${encodeURIComponent(to)}` : '';
  return apiData<VarianceReport>(`/budgets/${encodeURIComponent(id)}/variance${query}`);
}

// ------------------------------------------------------------ pure helpers

/**
 * معاينة التوزيع الشهري كما يوزّعه الخادم: قسط متساوٍ HALF_UP بدقة 4، والفترة
 * الأخيرة تحمل الباقي بالضبط — القاعدة نفسها التي يثبّتها اختبار القبول. تقديرٌ
 * للعرض في النموذج؛ الرقم الرسمي ما يعيده الخادم.
 */
export function previewDistribution(annualText: string, periods: number): Array<string> | null {
  const annual = Number(annualText);
  if (!Number.isFinite(annual) || annual <= 0 || !Number.isFinite(periods) || periods <= 0) return null;
  const instalment = Math.round(((annual / periods) + Number.EPSILON) * 10_000) / 10_000;
  const rows: string[] = [];
  let distributed = 0;
  for (let index = 0; index < periods; index += 1) {
    const isLast = index === periods - 1;
    const monthlyValue = isLast ? Math.round(((annual - distributed) + Number.EPSILON) * 10_000) / 10_000 : instalment;
    distributed += monthlyValue;
    rows.push(monthlyValue.toFixed(4));
  }
  return rows;
}

/** إشارة الانحراف بلغة المحاسب: فوق الموازنة/تحتها — بحسب طبيعة الحساب. */
export function varianceTone(row: { accountType?: string; variance?: string }): 'good' | 'bad' | 'flat' {
  const varianceValue = Number(row.variance ?? 0);
  if (!Number.isFinite(varianceValue) || varianceValue === 0) return 'flat';
  // المصروف: إنفاق أقل من الموازنة (انحراف موجب) = تحت الموازنة = جيد؛ الإيراد بالعكس.
  const isExpense = row.accountType === 'expense' || row.accountType === 'asset';
  const under = varianceValue > 0;
  return isExpense === under ? 'good' : 'bad';
}
