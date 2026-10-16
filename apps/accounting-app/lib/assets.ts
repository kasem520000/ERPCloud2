/**
 * M6.1 — fixed-asset wrappers for the accounting app. Unlike the M3 wrappers in
 * `lib/accounting.ts` (read-only by contract), this module carries the milestone's
 * three writes — category, registration and the depreciation run — each of which maps
 * 1:1 onto an `AssetsModule` endpoint. The writes stay here, never inline in pages:
 * one place to audit, one place to localize errors.
 *
 * Rows are rendered defensively (both casing conventions) exactly like
 * `lib/accounting.ts`, and money is kept as decimal text end-to-end — the client never
 * recomputes a balance, it only displays what the API returned.
 */
import { apiData, apiPost } from '@erp/web-core/api';

// ------------------------------------------------------------------ categories

export type AssetCategory = {
  id: string;
  code: string;
  nameAr?: string;
  name_ar?: string;
  nameEn?: string;
  name_en?: string;
  defaultUsefulLifeMonths?: number;
  default_useful_life_months?: number;
  assetAccountId?: string | null;
  asset_account_id?: string | null;
  accumulatedAccountId?: string | null;
  accumulated_account_id?: string | null;
  depreciationAccountId?: string | null;
  depreciation_account_id?: string | null;
  notes?: string | null;
};

export function nameOfCategory(category: AssetCategory): string {
  return category.nameAr ?? category.name_ar ?? category.nameEn ?? category.name_en ?? category.code;
}

export function lifeOfCategory(category: AssetCategory): number {
  return category.defaultUsefulLifeMonths ?? category.default_useful_life_months ?? 0;
}

export type CategoryInput = {
  code: string;
  nameAr: string;
  nameEn?: string;
  defaultUsefulLifeMonths: number;
  assetAccountId?: string;
  accumulatedAccountId?: string;
  depreciationAccountId?: string;
  notes?: string;
};

export function listAssetCategories(): Promise<AssetCategory[]> {
  return apiData<AssetCategory[]>('/asset-categories');
}

export function createAssetCategory(input: CategoryInput): Promise<AssetCategory> {
  return apiPost<AssetCategory>('/asset-categories', input);
}

// -------------------------------------------------------------------- register

export type FixedAsset = {
  id: string;
  code: string;
  nameAr?: string;
  name_ar?: string;
  nameEn?: string;
  name_en?: string;
  categoryId?: string;
  category_id?: string;
  categoryName?: string | null;
  category_name?: string | null;
  categoryCode?: string | null;
  acquisitionDate?: string;
  acquisition_date?: string;
  acquisitionCost?: string;
  acquisition_cost?: string;
  salvageValue?: string;
  salvage_value?: string;
  usefulLifeMonths?: number;
  useful_life_months?: number;
  method?: string;
  status?: string;
  accumulatedDepreciation?: string;
  accumulated_depreciation?: string;
  netBookValue?: string;
  net_book_value?: string;
  depreciatedMonths?: number;
  depreciated_months?: number;
};

export function nameOfAsset(asset: FixedAsset): string {
  return asset.nameAr ?? asset.name_ar ?? asset.nameEn ?? asset.name_en ?? asset.code;
}

export const ASSET_STATUS_LABELS: Record<string, string> = {
  active: 'نشِط',
  fully_depreciated: 'مستوفى عمره',
  disposed: 'مُتخلَّص منه',
};

export function statusLabelOf(asset: FixedAsset): string {
  return ASSET_STATUS_LABELS[asset.status ?? 'active'] ?? (asset.status ?? '');
}

export type AssetInput = {
  code: string;
  nameAr: string;
  nameEn?: string;
  categoryId: string;
  acquisitionDate: string;
  acquisitionCost: string;
  salvageValue: string;
  usefulLifeMonths: number;
  assetAccountId?: string;
  accumulatedAccountId?: string;
  depreciationAccountId?: string;
  branchId?: string;
  notes?: string;
};

export function listFixedAssets(filters: { q?: string; status?: string; categoryId?: string } = {}): Promise<FixedAsset[]> {
  const params = new URLSearchParams();
  if (filters.q?.trim()) params.set('q', filters.q.trim());
  if (filters.status) params.set('status', filters.status);
  if (filters.categoryId) params.set('category_id', filters.categoryId);
  const query = params.toString();
  return apiData<FixedAsset[]>(`/fixed-assets${query ? `?${query}` : ''}`);
}

export function registerFixedAsset(input: AssetInput): Promise<FixedAsset> {
  return apiPost<FixedAsset>('/fixed-assets', input);
}

// -------------------------------------------------------------------- schedule

export type ScheduleRow = {
  period?: string;
  plannedAmount?: string;
  planned_amount?: string;
  postedAmount?: string;
  posted_amount?: string;
  posted?: boolean;
  journalNumber?: string | null;
  journal_number?: string | null;
};

export type ScheduleView = {
  asset?: FixedAsset & {
    accumulatedDepreciation?: string;
    accumulated_depreciation?: string;
    netBookValue?: string;
    net_book_value?: string;
  };
  schedule?: ScheduleRow[];
};

export function assetSchedule(id: string): Promise<ScheduleView> {
  return apiData<ScheduleView>(`/fixed-assets/${encodeURIComponent(id)}/schedule`);
}

// ------------------------------------------------------------------- run month

export type DepreciationRunResult = {
  period?: string;
  processed?: number;
  skipped?: Array<{ code?: string; reason?: string }>;
  journalEntry?: { id?: string; number?: string | number; date?: string; description?: string | null } | null;
  journal_entry?: { id?: string; number?: string | number } | null;
  totalDepreciation?: string;
  total_depreciation?: string;
  assets?: Array<{ id?: string; code?: string; amount?: string }>;
};

/**
 * The run ledger: one row per asset per posted month — `asset_depreciation_entries`
 * joined to its journal entry, as `listRuns` returns them.
 */
export type DepreciationRunRow = {
  id: string;
  assetId?: string;
  asset_id?: string;
  assetCode?: string;
  asset_code?: string;
  assetName?: string;
  asset_name?: string;
  period?: string;
  depreciationDate?: string;
  depreciation_date?: string;
  amount?: string;
  journalEntryId?: string;
  journal_entry_id?: string;
  journalNumber?: string | number | null;
  journal_number?: string | number | null;
};

export function runDepreciation(input: { period: string; date?: string; branchId?: string; description?: string }): Promise<DepreciationRunResult> {
  return apiPost<DepreciationRunResult>('/fixed-assets/depreciation-runs', input);
}

export function listDepreciationRuns(period?: string): Promise<DepreciationRunRow[]> {
  const query = period ? `?period=${encodeURIComponent(period)}` : '';
  return apiData<DepreciationRunRow[]>(`/fixed-assets/depreciation-runs${query}`);
}

// ------------------------------------------------------- pure client helpers

/**
 * The monthly straight-line instalment, exactly as the service computes it:
 * (cost − salvage) / life rounded HALF-UP to 4 decimals. The last month of an asset's
 * life absorbs the telescoping remainder on the server; this preview never claims to
 * be that — it is the uniform instalment shown in the registration form.
 */
export function previewMonthlyAmount(costText: string, salvageText: string, life: number): string | null {
  const c = Number(costText);
  const s = Number(salvageText);
  if (!Number.isFinite(c) || !Number.isFinite(s) || !Number.isFinite(life) || life <= 0) return null;
  if (c - s <= 0) return null;
  const raw = (c - s) / life;
  // HALF-UP to 4 decimals (the server's numeric scale); positive values only.
  const scaled = Math.round((raw + Number.EPSILON) * 10_000) / 10_000;
  return scaled.toFixed(4);
}

/** `YYYY-MM` — the run's period format, validated client-side before the POST. */
const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidPeriod(period: string): boolean {
  return PERIOD_PATTERN.test(period);
}

/** A sensible default for the run form: the month of "today" in tenant time. */
export function currentPeriod(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}
