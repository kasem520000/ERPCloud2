import { z } from 'zod';

import { uuidSchema } from '../ids.js';

import { orgAuditDtoSchema, orgListQuerySchema, versionSchema } from './common.js';

/**
 * Branch posting profiles — API_CONTRACT §3, DATABASE_DESIGN §5.
 *
 * Replaces the legacy global `SettingGeneral.*Acc` columns *and* the per-branch
 * `Branches.*Acc` overrides (DOMAIN_MODEL §3) with one versioned JSON document per
 * `(branch, doc_type)`. Posting engines from PHASE_08 onwards ask
 * `resolvePostProfile(branchId, docType)` instead of reading account columns, so adding
 * a mapping never means another migration.
 */

/** `doc_type` codes — DOMAIN_MODEL §1 (frozen vocabulary). */
export const docTypeSchema = z.enum([
  'sales_invoice',
  'sales_return',
  'credit_note',
  'debit_note',
  'purchase_invoice',
  'purchase_return',
  'receipt_voucher',
  'payment_voucher',
  'journal_entry',
  'stock_adjustment',
  'stock_voucher',
  'stock_transfer',
  'cash_transfer',
  'payroll_run',
  'shift_close',
  'progress_bill',
  'rent_invoice',
  'installment_contract',
  'opening_balance',
  /**
   * **PHASE_E (مخابز وتوزيع)** — الإنتاج.
   *
   * كان الإنتاج **محايداً في الدفاتر** عن قصد (`production-orders.service.ts`: ما يخرج من
   * المستودع كمكوّنات يعود إليه كمنتج بالقيمة نفسها، فلا تتحرك الميزانية ولا يلزم قيد)، وبقي
   * كذلك لمن لا يربط شيئاً. ما كان ناقصاً هو أن منشأة تفصل «المواد الخام» عن «المنتج التام»
   * في دفترها لا تملك نوع مستند تُعلّق عليه ربطها: المفردات كانت مغلقة ولا تحتوي الإنتاج.
   *
   * إضافةٌ صرفة: لا تغيّر أي ملف ترحيل قائم، وكل محرّك يستمر في الحياد ما لم تُربط الحسابات.
   * `manufacturing_order` = `WmsBomService` (BOM و`MF-`)، و`production_order` =
   * `ProductionOrdersService` (مكوّنات و`MO-`).
   */
  'manufacturing_order',
  'production_order',
]);

export type DocType = z.infer<typeof docTypeSchema>;

/** `*` is the catch-all profile — the direct heir of the legacy global mapping. */
export const POSTING_PROFILE_WILDCARD = '*';

export const postingProfileDocTypeSchema = z.union([docTypeSchema, z.literal(POSTING_PROFILE_WILDCARD)]);
export type PostingProfileDocType = z.infer<typeof postingProfileDocTypeSchema>;

/**
 * The account ids a profile may carry. Exported as data so PHASE_07 can iterate them
 * when it adds the "account exists and is postable" check (`ACCOUNT_NOT_POSTABLE`)
 * without duplicating the key list.
 */
export const POST_PROFILE_ACCOUNT_KEYS = [
  'salesAccountId',
  'salesReturnAccountId',
  'purchasesAccountId',
  'purchaseReturnAccountId',
  'discountGivenAccountId',
  'discountReceivedAccountId',
  'vatOutputAccountId',
  'vatInputAccountId',
  'exciseTaxAccountId',
  'inventoryAccountId',
  'cogsAccountId',
  /**
   * Phase 05 — the three accounts the stock ledger needs besides `inventory`:
   *
   * - `openingBalanceAccountId`: the other side of بضاعة أول المدة (opening stock).
   * - `inventoryAdjustmentAccountId`: variance — shortage and overage found by a count.
   * - `stockInTransitAccountId`: goods on the road between two warehouses, so a
   *   transfer in transit belongs to neither warehouse's balance.
   */
  'openingBalanceAccountId',
  'inventoryAdjustmentAccountId',
  'stockInTransitAccountId',
  'cashAccountId',
  'bankAccountId',
  'receivableAccountId',
  'payableAccountId',
  /**
   * Phase 06 — أوراق القبض: where a cheque sits between being taken and being honoured.
   * A pending cheque is a promise, not money, so neither the safe nor the bank has moved
   * yet; the account is what keeps the promise visible in the ledger until clearance.
   */
  'chequesInHandAccountId',
  /**
   * Phase 06 — فرق الصندوق: where the counted drawer and the books disagree.
   * The desktop posts the difference to `3110004` («فرق بالصندوق») when it closes a
   * shift (`Class/EntryOper.cs`, `BindCloseShiftToEntry`). Everything else in that
   * entry — sales, VAT, discount, the bank legs — the cloud already posted when each
   * invoice was posted, so the close only ever moves the difference.
   */
  'cashDifferenceAccountId',
  /**
   * **R12** — عهدة الإغلاق: the account the counted drawer is parked on when the shift is
   * closed, and the one a receipt voucher later clears it from. The desktop hardcodes
   * `1211002` for it (`ClosShiftAndroid.xaml.cs:1593`, `Class/EntryOper.cs:774`) and the
   * cloud's chart seeds the same code (`desktop-coa.ts:479`); a profile key is still the
   * right home for it, because a tenant whose chart moved the account must be able to say
   * so rather than edit code. Unmapped ⇒ the chart's own `1211002`; neither ⇒ 422.
   */
  'custodyAccountId',
  /**
   * **R13** — نقد تحت التحويل: where money sits between `📤 اعتماد الإرسال` and
   * `📥 تأكيد الاستلام`. The desktop moves money between treasuries with a سند صرف and a
   * سند قبض (`Form_WPF/frmPaymentVoucher.xaml.cs:559` — «السطر الأول: credit من
   * الخزنة/البنك»), two documents that each name the other side, so it never needed an
   * in-transit account; the cloud's `/cash-transfers` is one document whose money leaves
   * the source on send and reaches the destination on receive, and the days between the
   * two are real. Its pendant in this codebase is `stockInTransitAccountId`
   * («بضاعة تحت التحويل» `1270003`) for stock. Unmapped ⇒ the chart's own `1211003`;
   * neither ⇒ 422 `CASH_TRANSFER_TRANSIT_ACCOUNT_MISSING`.
   */
  'cashInTransitAccountId',
  /**
   * **PHASE_E (مخابز وتوزيع)** — حسابا الإنتاج، وكلاهما **اختياري**.
   *
   * - `rawMaterialsAccountId`: المواد الخام التي يستهلكها الإنتاج (دقيق، سكر، خميرة، زيت).
   * - `finishedGoodsAccountId`: المنتج التام الداخل إلى المستودع (خبز، سمبوسة، حلويات).
   *
   * القاعدة التي ينفّذها المحرّكان الرسميان (`WmsBomService.produce` و
   * `ProductionOrdersService.complete`) عبر `production-posting.ts`:
   *
   *   • **الطرفان مربوطان** ⇒ يُرحَّل قيدٌ واحد متوازن بقيمة ما استُهلك فعلياً — وهي القيمة
   *     نفسها التي دخل بها المنتج التام، لأن المحرّك يشتقّ تكلفة المنتج مما خرج من الرفّ لا
   *     من رقم مُدخل: «م. منتج تام ← م. مواد خام». لا يُخترع رقم ولا يُتلف؛
   *   • **ولا طرف مربوط** ⇒ يبقى الإنتاج محايداً في الدفاتر كما كان، فلا ينكسر مستأجر قائم؛
   *   • **طرف واحد فقط** ⇒ رفض صريح 422 `PRODUCTION_ACCOUNTS_INCOMPLETE` يسمّي الطرف الناقص،
   *     وتعود المعاملة كلها: لا قيد جزئي ولا حركة مخزنية؛
   *   • **قيمة مستهلَكة صفر** ⇒ لا قيد (قيدٌ بمبلغ صفر ضجيج في الدفتر، و`postJournalInTx`
   *     يرفضه أصلاً) ويُبلَّغ السبب في `postingBasis`.
   *
   * ولا يُنشأ حساب تلقائياً أبداً: الربط قرار المنشأة في «الإعدادات ← الربط المحاسبي».
   *
   * **وليس هنا `wipAccountId` عن قصد**: لا توجد مرحلة «تحت التشغيل» في المحرّكَيْن — الصرف
   * والإنتاج يقعان في المعاملة نفسها، فأي قيمة تمرّ بحساب تحت التشغيل تدخله وتخرج منه في القيد
   * نفسه وصافيها صفر. مفتاحٌ لا يقرأه شيء كذبٌ تعرضه شاشة الإعدادات على المحاسب؛ يُضاف حين
   * يصير في النظام إنتاج على مرحلتين (صرف مكوّنات ثم إنتاج لاحق) فعلاً.
   */
  'rawMaterialsAccountId',
  'finishedGoodsAccountId',
] as const;

export type PostProfileAccountKey = (typeof POST_PROFILE_ACCOUNT_KEYS)[number];

const accountMapping = Object.fromEntries(
  POST_PROFILE_ACCOUNT_KEYS.map((key) => [key, uuidSchema.nullable().optional()]),
) as Record<PostProfileAccountKey, z.ZodOptional<z.ZodNullable<typeof uuidSchema>>>;

/**
 * `PostProfileV1` — the versioned JSONB payload (PHASE_05 §5.5). The literal `version`
 * discriminator is what lets PHASE_08+ introduce a V2 shape without a data migration:
 * the reader switches on it.
 */
export const postProfileV1Schema = z
  .object({
    version: z.literal(1),
    ...accountMapping,
    costCenterId: uuidSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (value) => POST_PROFILE_ACCOUNT_KEYS.some((key) => value[key] !== undefined && value[key] !== null),
    { message: 'A posting profile must map at least one account' },
  );

export type PostProfileV1 = z.infer<typeof postProfileV1Schema>;

export const postingProfileDtoSchema = orgAuditDtoSchema.extend({
  id: uuidSchema,
  /** NULL = the tenant-wide default profile used when a branch has no override. */
  branchId: uuidSchema.nullable(),
  docType: z.string(),
  mapping: postProfileV1Schema,
});

export type PostingProfileDto = z.infer<typeof postingProfileDtoSchema>;

export const postingProfileUpsertSchema = z
  .object({
    branchId: uuidSchema.nullable().optional(),
    docType: postingProfileDocTypeSchema,
    mapping: postProfileV1Schema,
    version: versionSchema.optional(),
  })
  .strict();

export type PostingProfileUpsert = z.infer<typeof postingProfileUpsertSchema>;

/** `GET /branch-posting-profiles/resolve?branchId=…&docType=sales_invoice` */
export const postingProfileResolveQuerySchema = z
  .object({
    branchId: uuidSchema,
    docType: docTypeSchema,
  })
  .strict();

export type PostingProfileResolveQuery = z.infer<typeof postingProfileResolveQuerySchema>;

export const postingProfileResolutionDtoSchema = z.object({
  branchId: uuidSchema,
  docType: z.string(),
  mapping: postProfileV1Schema,
  /** Which rung of the fallback chain answered — never guess in the caller. */
  matchedBranchId: uuidSchema.nullable(),
  matchedDocType: z.string(),
});

export type PostingProfileResolutionDto = z.infer<typeof postingProfileResolutionDtoSchema>;

export const POSTING_PROFILE_FILTERS = ['branchId', 'docType'] as const;
export const POSTING_PROFILE_SORT_COLUMNS = ['docType', 'createdAt'] as const;

export const postingProfileListQuerySchema = orgListQuerySchema;
export type PostingProfileListQueryDto = z.infer<typeof postingProfileListQuerySchema>;
