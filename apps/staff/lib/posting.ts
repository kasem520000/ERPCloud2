'use client';

import { listPeriods, periodRange, type FiscalPeriod } from './lookups';

/**
 * Posting helpers shared by the screens that still post a document directly
 * (payroll, projects, treasury vouchers) — and nowhere else.
 *
 * This file used to *build* the journal lines for sales, purchases and the POS
 * on the client, by resolving the branch posting profile and mapping totals onto
 * accounts. Phases 02–04 moved that work into the API, where the profile is
 * resolved inside the same transaction as the ledger and the stock movement it
 * feeds. A client-built journal is a liability: it can be stale, it can disagree
 * with the document it claims to represent, and a retry can double it.
 *
 * What legitimately stays on this side of the wire:
 *
 * - `periodForDate`: the open period a manual posting must name.
 * - `POSTING_ACCOUNT_LABELS` / `PostingProfile`: the vocabulary the mapping
 *   screen («الإعدادات ← الربط المحاسبي») renders and edits. Nothing here posts.
 */

export type PostingProfile = {
  version: 1;
  salesAccountId?: string | null;
  salesReturnAccountId?: string | null;
  purchasesAccountId?: string | null;
  purchaseReturnAccountId?: string | null;
  discountGivenAccountId?: string | null;
  discountReceivedAccountId?: string | null;
  vatOutputAccountId?: string | null;
  vatInputAccountId?: string | null;
  inventoryAccountId?: string | null;
  cogsAccountId?: string | null;
  openingBalanceAccountId?: string | null;
  inventoryAdjustmentAccountId?: string | null;
  stockInTransitAccountId?: string | null;
  /**
   * 🏭 الإنتاج (PHASE_E) — اختياريان: ربطهما معاً يُرحّل قيد «منتج تام ← مواد خام»، وتركهما يبقي الإنتاج محايداً.
   * 🏭 M6.2 — و`wipAccountId` (تحت التشغيل) يفصل الصرف عن الإكمال: «تحت التشغيل ← مواد خام» عند
   * الصرف و«منتج تام ← تحت التشغيل» عند الإكمال؛ بلاه يبقى الصرف محايدًا والقيد كاملًا عند الإكمال.
   */
  rawMaterialsAccountId?: string | null;
  finishedGoodsAccountId?: string | null;
  wipAccountId?: string | null;
  cashAccountId?: string | null;
  bankAccountId?: string | null;
  receivableAccountId?: string | null;
  payableAccountId?: string | null;
  costCenterId?: string | null;
};

export const POSTING_ACCOUNT_LABELS: Record<string, string> = {
  salesAccountId: 'إيرادات المبيعات',
  salesReturnAccountId: 'مردودات المبيعات',
  purchasesAccountId: 'المشتريات / المخزون',
  purchaseReturnAccountId: 'مردودات المشتريات',
  discountGivenAccountId: 'خصم مسموح به',
  discountReceivedAccountId: 'خصم مكتسب',
  vatOutputAccountId: 'ضريبة المخرجات',
  vatInputAccountId: 'ضريبة المدخلات',
  inventoryAccountId: 'المخزون',
  cogsAccountId: 'تكلفة البضاعة المباعة',
  openingBalanceAccountId: 'بضاعة أول المدة',
  inventoryAdjustmentAccountId: 'تسويات المخزون (عجز/زيادة)',
  stockInTransitAccountId: 'بضاعة تحت التحويل',
  rawMaterialsAccountId: 'مواد خام الإنتاج (دقيق/سكر/زيت)',
  finishedGoodsAccountId: 'المنتج التام (خبز/حلويات)',
  wipAccountId: 'إنتاج تحت التشغيل (مواد صُرفت ولم تُنتج)',
  cashAccountId: 'الصندوق',
  bankAccountId: 'البنك',
  receivableAccountId: 'العملاء (ذمم مدينة)',
  payableAccountId: 'الموردون (ذمم دائنة)',
};

/** The open period that contains `date`, which every manual posting call needs. */
export async function periodForDate(date: string): Promise<FiscalPeriod | undefined> {
  const periods = await listPeriods();
  const covering = periods.filter((period) => {
    const range = periodRange(period);
    return range.from <= date && range.to >= date;
  });
  return covering.find((period) => period.status !== 'closed') ?? covering[0];
}
