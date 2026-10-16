import { Decimal } from 'decimal.js';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { DomainError, errorCodes } from '@erp/contracts';
import { branches, type DrizzleTx } from '@erp/database';

import { AccountingService } from '../accounting/accounting.service.js';
import { PostingProfilesService } from '../organization/posting-profiles/posting-profiles.service.js';

/**
 * 🏭 ترحيل الإنتاج — the single place that decides whether a production run owes the ledger an
 * entry, shared by the two official engines (`WmsBomService.produce` for a BOM/`MF-` order and
 * `ProductionOrdersService.complete` for a components/`MO-` order) so they cannot drift apart.
 *
 * **The default is still ledger-neutral, and that is a design decision, not an omission.** Both
 * engines take the produced item's cost from what actually left the shelf — the moving average the
 * inventory service charged for the components, divided by the produced quantity — so the value
 * that leaves المخزون as materials re-enters it as finished goods and the balance sheet does not
 * move. With one inventory control account there is nothing to post, and posting a zero-net pair
 * would be noise in the ledger.
 *
 * What a bakery that keeps «دقيق ومواد خام» and «خبز جاهز» in **different** accounts could not do
 * until now was say so: the posting-profile vocabulary had no production document type. It does now
 * (`manufacturing_order`, `production_order`) with two optional keys
 * (`rawMaterialsAccountId`, `finishedGoodsAccountId`), and the rule is:
 *
 *   • both mapped      ⇒ one balanced entry, «م. منتج تام ← م. مواد خام», for the value actually
 *                        consumed (which is exactly the value the output entered at — no number is
 *                        invented and none is destroyed);
 *   • neither mapped   ⇒ neutral, as before, so no existing tenant changes behaviour;
 *   • exactly one      ⇒ 422 `PRODUCTION_ACCOUNTS_INCOMPLETE` naming the missing side, and the
 *                        whole transaction rolls back: no half entry, no stock movement;
 *   • mapped but the consumed value is zero ⇒ no entry (a zero-amount journal line is refused by
 *                        `postJournalInTx` and meaningless to an accountant), reported as
 *                        `zero_consumed_value`.
 *
 * No account is ever created here: mapping is the tenant's decision in «الإعدادات ← الربط
 * المحاسبي». And a tenant with no posting profile at all keeps producing — a missing profile means
 * "nothing mapped", not "production is forbidden".
 *
 * **M6.2 — مرحلة تحت التشغيل.** `issue()` فصلت الصرف عن الإكمال زمنيًا، فصار للقيمة مكان
 * تقف فيه بين الخطوتين: حساب `wipAccountId`. القاعدة بامتداد المنطق نفسه:
 *
 *   • stage `issue`: الطرفان `wipAccountId` + `rawMaterialsAccountId` معًا ⇒ «تحت التشغيل ←
 *     مواد خام» بقيمة ما خرج من الرفّ فعلاً؛ وبلا `wipAccountId` ⇒ محايد (الإكمال يرحّل
 *     الزوج الكامل «منتج تام ← مواد خام» كما في المسار المباشر — لا انكسار لمنشأة ربطت
 *     الحسابين قبل وجود WIP)؛ و`wipAccountId` بلا مواد خام ⇒ 422 يسمّي الناقص؛
 *   • stage `complete`: إن كان الصرف قد مرّ تحت التشغيل (`wipPosted`) فالزوج المطلوب
 *     `finishedGoodsAccountId` + `wipAccountId` — القيمة تُصفّي من الحساب الذي دخلت منه،
 *     وتغيير الربط بين الخطوتين مرفوض (`PRODUCTION_WIP_MAPPING_CHANGED`) لا مُدار؛ وإلا
 *     فالزوج الأصلي «منتج تام ← مواد خام» كما كان.
 */

export type ProductionDocType = 'manufacturing_order' | 'production_order';

/** لماذا لا يوجد قيد — يُعرض للمحاسب بدل أن يُترك يخمّن. */
export type ProductionPostingBasis =
  /** الطرفان مربوطان ⇒ قيد مُرحَّل. */
  | 'accounts_mapped'
  /** لا ربط (أو لا ملف ترحيل) ⇒ الإنتاج محايد في الدفاتر. */
  | 'ledger_neutral'
  /** ربطٌ موجود لكن القيمة المستهلَكة صفر ⇒ لا قيد بمبلغ صفر. */
  | 'zero_consumed_value';

export type ProductionPostingOutcome = {
  journalEntryId: string | null;
  postingBasis: ProductionPostingBasis;
};

const NEUTRAL: ProductionPostingOutcome = { journalEntryId: null, postingBasis: 'ledger_neutral' };

const today = (): string => new Date().toISOString().slice(0, 10);

/** الفرع الذي يُنسب إليه القيد: فرع المستودع، وإلا الفرع الافتراضي للمنشأة. */
async function resolveBranchInTx(
  tx: DrizzleTx,
  tenantId: string,
  branchId: string | null,
): Promise<string | null> {
  if (branchId) return branchId;
  const [row] = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.tenantId, tenantId), isNull(branches.deletedAt)))
    .orderBy(desc(branches.isDefault), branches.createdAt)
    .limit(1);
  return row?.id ?? null;
}

export async function postProductionJournalInTx(
  tx: DrizzleTx,
  tenantId: string,
  services: { accounting: AccountingService; profiles: PostingProfilesService },
  input: {
    docType: ProductionDocType;
    orderId: string;
    /** رقم الأمر كما يراه المحاسب في وصف القيد (`MF-000001` / `MO-000001`). */
    orderNumber: string;
    branchId: string | null;
    /** قيمة ما استُهلك فعلياً — وهي نفسها قيمة ما دخل منتجاً تاماً. */
    consumedValue: Decimal;
    /**
     * M6.2 — الخطوة التي يُرحَّل لها: `complete` (الافتراضية — سلوك المحرّكين قبل WIP
     * كما هو) أو `issue` (الصرف إلى الأرضية، زوج تحت التشغيل/المواد الخام).
     */
    stage?: 'issue' | 'complete';
    /**
     * هل صُرف هذا الأمر أصلًا عبر قيد تحت التشغيل؟ يحدّد زوج الإكمال (انظر الرأس).
     * `false` مع `stage: 'complete'` هو مسار الـdraft الموروث — لا سلوك جديد.
     */
    wipPosted?: boolean;
    /**
     * يميّز الخطوة داخل الأمر الواحد: الإنتاج الجزئي المتكرر على الأمر نفسه يُرحَّل أكثر من مرة،
     * و`journal_entries` يحمل فهرساً فريداً على `(tenant_id, idempotency_key)`، فبلا مفتاحٍ distinct
     * تصطدم الخطوة الثانية بالأولى.
     */
    stepKey: string;
    date?: string;
  },
): Promise<ProductionPostingOutcome> {
  const branchId = await resolveBranchInTx(tx, tenantId, input.branchId);

  let mapping: Record<string, string | null | undefined>;
  try {
    // بلا فرعٍ لا يُنسب قيد ولا يُحلّ ملف — ومنشأة بلا فروع لا ترحّل شيئاً أصلاً في هذا النظام.
    if (!branchId) return NEUTRAL;
    const profile = await services.profiles.resolvePostProfileInTx(tx, tenantId, branchId, input.docType);
    mapping = profile.mapping as unknown as Record<string, string | null | undefined>;
  } catch (error) {
    /**
     * لا ملف ترحيل يحلّ هذا النوع ⇒ «لا شيء مربوط» ⇒ إنتاج محايد كما كان قبل هذه الإضافة.
     * جعلُها رفضاً كان سيقطع الإنتاج على كل منشأة لم تفتح شاشة الربط المحاسبي بعد.
     */
    if (error instanceof DomainError && error.code === errorCodes.ACCOUNT_PROFILE_MISSING) return NEUTRAL;
    throw error;
  }

  const finishedGoodsAccountId = mapping.finishedGoodsAccountId ?? null;
  const rawMaterialsAccountId = mapping.rawMaterialsAccountId ?? null;
  const wipAccountId = mapping.wipAccountId ?? null;

  /**
   * M6.2 — زوجا الخطوتين. الصرف: (تحت التشغيل، مواد خام). الإكمال: (منتج تام، تحت
   * التشغيل) إن كان الصرف قد مرّ تحت التشغيل، وإلا (منتج تام، مواد خام) كما كان.
   */
  const stage = input.stage ?? 'complete';
  const debitKey = stage === 'issue' ? 'wipAccountId' : 'finishedGoodsAccountId';
  const creditKey =
    stage === 'issue' ? 'rawMaterialsAccountId' : input.wipPosted ? 'wipAccountId' : 'rawMaterialsAccountId';
  const debitAccountId = stage === 'issue' ? wipAccountId : finishedGoodsAccountId;
  const creditAccountId =
    stage === 'issue' ? rawMaterialsAccountId : input.wipPosted ? wipAccountId : rawMaterialsAccountId;

  if (stage === 'issue' && !wipAccountId) {
    /**
     * لا حساب تحت تشغيل ⇒ الصرف محايد، والإكمال يرحّل الزوج الكامل «منتج تام ← مواد خام»
     * كما في المسار المباشر — منشأة ربطت الحسابين قبل وجود WIP لا تنكسر، ومنشأة أرادت
     * فصل الخطوتين في الدفتر تربط wipAccountId فحسب.
     */
    return NEUTRAL;
  }

  if (stage === 'complete' && input.wipPosted && !wipAccountId) {
    /**
     * الصرف رُحِّل عبر تحت التشغيل ثم غيّرت المنشأة الربط قبل الإكمال: القيمة ما تزال
     * جالسة في حساب تحت التشغيل، والإكمال «منتج تام ← مواد خام» سيخصم المواد مرتين.
     * الرفض الصريح — تصفية الحساب الذي فُتح قرارُ محاسبي، لا إدارةً صامتة من المحرّك.
     */
    throw new DomainError(
      'PRODUCTION_WIP_MAPPING_CHANGED',
      `صرفُ هذا الأمر رُحِّل عبر حساب تحت التشغيل، ولا يمكن إكماله بلا ذلك الحساب: أعِد ربط wipAccountId لنوع المستند ${input.docType} من الإعدادات ← الربط المحاسبي حتى تُصفّى القيمة من حيث دخلت`,
      422,
      { field: 'wipAccountId', docType: input.docType },
    );
  }

  if (!debitAccountId && !creditAccountId) return NEUTRAL;
  if (!debitAccountId || !creditAccountId) {
    const missing = debitAccountId ? creditKey : debitKey;
    throw new DomainError(
      'PRODUCTION_ACCOUNTS_INCOMPLETE',
      `ترحيل الإنتاج يحتاج الطرفين معاً: حدّد ${missing} لنوع المستند ${input.docType} من الإعدادات ← الربط المحاسبي، أو أفرغ الطرف المربوط ليبقى الإنتاج محايداً في الدفاتر`,
      422,
      { field: missing, docType: input.docType },
    );
  }

  if (!input.consumedValue.isFinite() || input.consumedValue.lte(0)) {
    return { journalEntryId: null, postingBasis: 'zero_consumed_value' };
  }

  const date = input.date ?? today();
  const value = input.consumedValue.toFixed(4);
  const fiscalPeriodId = await services.accounting.openPeriodForDateInTx(tx, tenantId, date);
  const lineLabels =
    stage === 'issue'
      ? { debit: 'تحت التشغيل — مواد مصروفة', credit: 'مواد خام مستهلَكة' }
      : input.wipPosted
        ? { debit: 'منتج تام', credit: 'تحت التشغيل — مُصفّى' }
        : { debit: 'منتج تام', credit: 'مواد خام مستهلَكة' };
  const entry = await services.accounting.postJournalInTx(tx, tenantId, {
    branchId,
    fiscalPeriodId,
    date,
    description:
      stage === 'issue'
        ? `صرف ${input.orderNumber} — تحويل مواد خام إلى تحت التشغيل`
        : input.wipPosted
          ? `إنتاج ${input.orderNumber} — تحويل تحت التشغيل إلى منتج تام`
          : `إنتاج ${input.orderNumber} — تحويل مواد خام إلى منتج تام`,
    lines: [
      {
        accountId: debitAccountId,
        debit: value,
        branchId,
        description: `${lineLabels.debit} — ${input.orderNumber}`,
      },
      {
        accountId: creditAccountId,
        credit: value,
        branchId,
        description: `${lineLabels.credit} — ${input.orderNumber}`,
      },
    ],
    sourceType: input.docType,
    sourceId: input.orderId,
    // المفتاح كما كان دائماً — `stepKey` يميّز الخطوات (`issue`/`complete`/أزواج الكميات)،
    // وإلحاق المرحلة كان سيكسر مطابقة القيود التاريخية بلا حاجة.
    idempotencyKey: `${input.docType}-journal:${input.orderId}:${input.stepKey}`,
  });

  return { journalEntryId: entry?.id ?? null, postingBasis: 'accounts_mapped' };
}
