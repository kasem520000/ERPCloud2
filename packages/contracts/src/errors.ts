/**
 * Stable error-code registry — API_CONTRACT §0 ("Stable error codes (seed registry,
 * extend only)"). Every 4xx/5xx response carries one of these codes
 * (PROJECT_CONTRACT §10). Add codes at the end; never rename or remove one.
 */
export const errorCodes = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  /** AUD-08 — رمز تسليم الجلسة بين الواجهات: مجهول، منتهٍ، أو مُستعمل سابقاً. */
  HANDOFF_CODE_INVALID: 'HANDOFF_CODE_INVALID',
  FORBIDDEN: 'FORBIDDEN',
  TENANT_SUSPENDED: 'TENANT_SUSPENDED',
  TENANT_CONTEXT_MISSING: 'TENANT_CONTEXT_MISSING',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  FILTER_NOT_ALLOWED: 'FILTER_NOT_ALLOWED',
  NOT_FOUND: 'NOT_FOUND',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  IDEMPOTENCY_REPLAY: 'IDEMPOTENCY_REPLAY',
  ACCOUNT_NOT_POSTABLE: 'ACCOUNT_NOT_POSTABLE',
  JOURNAL_UNBALANCED: 'JOURNAL_UNBALANCED',
  ACCOUNTING_PERIOD_CLOSED: 'ACCOUNTING_PERIOD_CLOSED',
  ACCOUNTING_PERIOD_LOCKED_MODULE: 'ACCOUNTING_PERIOD_LOCKED_MODULE',
  DOCUMENT_ALREADY_POSTED: 'DOCUMENT_ALREADY_POSTED',
  DOCUMENT_NOT_DRAFT: 'DOCUMENT_NOT_DRAFT',
  PARTY_CREDIT_LIMIT_EXCEEDED: 'PARTY_CREDIT_LIMIT_EXCEEDED',
  STOCK_INSUFFICIENT: 'STOCK_INSUFFICIENT',
  SEQUENCE_EXHAUSTED: 'SEQUENCE_EXHAUSTED',
  EINVOICE_REJECTED: 'EINVOICE_REJECTED',
  MIGRATION_CONFLICT: 'MIGRATION_CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
  // PHASE_04 — a draft was accepted but must wait for the configured approval chain.
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  // PHASE_05 §7 — no posting profile answers a (branch, doc_type) lookup.
  ACCOUNT_PROFILE_MISSING: 'ACCOUNT_PROFILE_MISSING',
  // Round 11 — credentials were valid but the user has TOTP enabled and sent no code.
  MFA_REQUIRED: 'MFA_REQUIRED',
  // P-C5 — a tenant wrote past a limit that an operator had set (metric in the details).
  USAGE_LIMIT_REACHED: 'USAGE_LIMIT_REACHED',
  // P-C11 — a state transition the current state forbids: rotate a revoked API key,
  // revoke one twice, or retry a delivery that already succeeded. 409, not 400: the
  // request was well-formed and the resource exists — it is its state that refuses.
  INVALID_STATE: 'INVALID_STATE',
  // P-M5 — رابط محتوى مكرَّر: الرابط العام هو هويّة الصفحة في نظر محرّك البحث، وتكراره يعني
  // أن صفحةً ستُظلّل الأخرى بصمت. 409 لأن الطلب سليم والصراع على موردٍ قائم.
  CONTENT_SLUG_TAKEN: 'CONTENT_SLUG_TAKEN',
  // P-M4 — البريد الذي بدأ التسجيل يملك منشأةً بالفعل. 409 لأن الطلب سليم والصراع على هويّةٍ
  // قائمة: البدء من جديد لن يُنشئ مالكاً ثانياً، بل سيُعيد لصاحب البريد منشأةً لا يطلبها.
  SIGNUP_EMAIL_TAKEN: 'SIGNUP_EMAIL_TAKEN',
  // P-M4 — الرمز غير صحيح أو منتهٍ أو محاولاته استُهلكت. 422 لأن الطلب سليم الشكل ومرفوض
  // المعنى، ولأن الشاشة تعرضه بجانب الحقل لا كخطأ خادم.
  SIGNUP_CODE_INVALID: 'SIGNUP_CODE_INVALID',
  // P-M4 — رمز المعالج (`token`) غير معروف أو لا يخصّ هذا البريد. **404** عن قصد: الجواب
  // نفسه للعنوان المجهول وللرمز الخاطئ، فلا يتحوّل المسار العام إلى أداة سرد بريد.
  SIGNUP_TOKEN_INVALID: 'SIGNUP_TOKEN_INVALID',
  // P-M6 — طلب عميلٍ متوقَّع غير موجود. 404 هو الجواب الصحيح لا 403: المعرّف مجهول.
  LEAD_NOT_FOUND: 'LEAD_NOT_FOUND',
  // P-M6 — الطلب حُوّل من قبل إلى منشأة. 409 لأن الصراع على موردٍ قائم، وإعادة التحويل
  // تُنشئ منشأةً ثانية لعنوانٍ واحد — وهو ما يمنعه هذا الرمز.
  LEAD_ALREADY_CONVERTED: 'LEAD_ALREADY_CONVERTED',
  // P-M6 — انتقال حالةٍ غير مسموح (من `won`/`rejected` مثلاً). 422: الطلب سليم والمنع
  // قاعدةُ حالةٍ معلنة في العقد، لا خطأ خادم.
  LEAD_STATUS_LOCKED: 'LEAD_STATUS_LOCKED',
  // P-M7 — حملةٌ بدأ إرسالها لا تُعدَّل ولا تُلغى: صفوفُ رسائلها شواهدُ على ما خرج فعلاً،
  // ونسخةٌ أُرسلت لا تُعاد كتابتها. 422 لأن الصراع على **حالة** الكيان لا على وجوده.
  CAMPAIGN_LOCKED: 'CAMPAIGN_LOCKED',
  // P-M7 — الشريحة فارغة: لا أحد يطابق تعريفها الآن. 422 لا 404 — الحملة موجودة، والمُرسل
  // إليهم هم الغائبون. وإرسالُ حملةٍ إلى صفرٍ يُسجَّل «أُرسلت» في التقارير وهو لم يخرج شيء.
  CAMPAIGN_SEGMENT_EMPTY: 'CAMPAIGN_SEGMENT_EMPTY',
  // P-M7 — نصّ الحملة فيه `{{متغيّر}}` غير معروف. 422: النصّ يُكتب ثم يُراجَع، والمنع عند
  // الجدولة لا عند الحفظ — فلا تُقطَع مسوّدةٌ في منتصف كتابتها.
  CAMPAIGN_BODY_INVALID: 'CAMPAIGN_BODY_INVALID',
  // R1 — الخصم المكتوب يتجاوز الحدّ المُعلَن على العضوية (`max_discount_pct` /
  // `max_discount_amount`). 422 لا 403: العضوية **تملك** فعل الخصم، والمرفوض هو المقدار —
  // والشاشة تعرضه بجانب حقل الخصم مع الحدّ نفسه.
  DISCOUNT_LIMIT_EXCEEDED: 'DISCOUNT_LIMIT_EXCEEDED',
  // R2 — إلغاء فاتورة بيع قائمة عليها مستندٌ مشتقّ (مرتجعٌ أو إشعار) مُرحَّل: الإلغاء يعكس
  // قيد الفاتورة ومخزونها، والمستند المشتقّ يحتفظ بقيده ومخزونه ⇒ مرجعٌ معلّق إلى فاتورة
  // ملغاة. 409 لا 422: الطلب سليم والفاتورة موجودة — حالتها هي التي ترفض.
  SALES_VOID_HAS_RETURNS: 'SALES_VOID_HAS_RETURNS',
  // R2 — الوجه الآخر: ترحيل مرتجعٍ (أو إشعار) يشير إلى فاتورة بيع **ملغاة**. بلا هذا الحرس
  // يكفي أن تُنشأ المسودّة قبل الإلغاء ثم تُرحَّل بعده ليُعاد المرجع المعلّق نفسه.
  SALES_REFERENCE_VOIDED: 'SALES_REFERENCE_VOIDED',
  // R3 — مرآة الشراء: إلغاء فاتورة مشتريات قائمةٍ عليها فاتورةُ مردود **مُرحَّلة** يعكس قيد
  // المشتريات ويصرف البضاعة، والمردود يحتفظ بقيده ⇒ مرجعٌ معلّق إلى فاتورةٍ ملغاة.
  PURCHASE_VOID_HAS_RETURNS: 'PURCHASE_VOID_HAS_RETURNS',
  // R3 — وترحيلُ مردودِ مشترياتٍ فاتورتُه ملغاة يُرفض قبل أي كتابة (لا قيد ولا مخزون).
  PURCHASE_REFERENCE_VOIDED: 'PURCHASE_REFERENCE_VOIDED',
  // R4 — تعليق الفواتير في نقطة البيع ٨ خانات كما في الديسكتوب
  // (`frmPOS.xaml.cs` L1893–L1906: `Hold1Btn`…`Hold9Btn` و`HoldList[9]`)، والسلة تُملأ
  // فلا موضعَ لتعليقٍ آخر: «لقد وصلت للحد الاقصي من عمليات الايقاف المؤقت» (L1935).
  POS_HOLD_LIMIT_REACHED: 'POS_HOLD_LIMIT_REACHED',
  // R4 — حجز الخانة لا يملكه من ليس صاحبها: التعليق مرتبطٌ بالكاشير وبالفرع.
  POS_HOLD_NOT_FOUND: 'POS_HOLD_NOT_FOUND',
  // R4 — «⚖️ F6 مطابقة» (`frmPOSPay.xaml` L548): مجموع طرق الدفع يجب أن يساوي صافي
  // الفاتورة، والفرق يُعلَن بعدده لا يُسكت عنه.
  POS_TENDER_MISMATCH: 'POS_TENDER_MISMATCH',
  // R4 — «لا يمكن تعديل السعر» (`frmPOS.xaml.cs` L1377): سعرٌ يخالف سعر الصنف يحتاج
  // `pos.priceoverride` — وهو `User.EditPrice` في الديسكتوب (`Class/User.cs` L24، L95).
  POS_PRICE_OVERRIDE_FORBIDDEN: 'POS_PRICE_OVERRIDE_FORBIDDEN',
  // R4 — مجموع طرق الدفع أكثر من صافي المستند: لا يُقبض أكثر مما كُتب، والزيادة تُردّ
  // للعميل بنداءٍ مستقلّ لا بمدينٍ في القيد.
  SALES_SETTLEMENT_EXCEEDS_TOTAL: 'SALES_SETTLEMENT_EXCEEDS_TOTAL',
  // R5 — دفعةٌ واحدة بتاريخَي انتهاء: السطر يذكر رقم الدفعة وتاريخاً يخالف ما سُجّل لها
  // سابقاً. الرفض أهون من صفٍّ يقول شيئين عن الشيء نفسه.
  LOT_EXPIRY_MISMATCH: 'LOT_EXPIRY_MISMATCH',
  // R5 — الدفعة على السطر لصنفٍ لا يُتتبَّع بالدفعات: رمزٌ صريح بدل تجاهلٍ صامت.
  LOT_NOT_TRACKED: 'LOT_NOT_TRACKED',
  // R8 — أرقام سخط الفاتورة: الرموز الستة التي ترفضها مسارات التسلسلي منذ §12 كانت
  // تُرمى بـ`DomainError` بلا إعلانٍ هنا ⇒ `title` يخرج «Request failed» للعميل. الرمز
  // المعلَن يجعل الردّ مفهوماً للشاشة كما هي حال بقية الرموز.
  //   · SERIAL_DUPLICATE: رقمٌ مسجَّلٌ من قبل (إدخالٌ ثانٍ لقطعةٍ واحدة).
  //   · SERIAL_NOT_FOUND: الرقم ليس لهذه الشركة/هذا الصنف. (وموضعان يقرآن صفّاً بمعرّفه
  //     فيجيبان **404** صراحةً: `inventory.service.ts` حذفُ رقمٍ بالمحرّر.)
  //   · SERIAL_COUNT_MISMATCH: عددُ الأرقام ≠ عدد القطع على السطر.
  //   · SERIAL_INVALID_STATE: الرقم في حالةٍ لا تسمح بالحركة (مباعٌ يُصرف مثلاً).
  //   · SERIAL_WRONG_WAREHOUSE: الرقم في مستودعٍ آخر.
  //   · SERIAL_NOT_RETURNABLE: مرتجعٌ لرقمٍ لم تبعه الشركة (ليس `sold`).
  SERIAL_DUPLICATE: 'SERIAL_DUPLICATE',
  SERIAL_NOT_FOUND: 'SERIAL_NOT_FOUND',
  SERIAL_COUNT_MISMATCH: 'SERIAL_COUNT_MISMATCH',
  SERIAL_INVALID_STATE: 'SERIAL_INVALID_STATE',
  SERIAL_WRONG_WAREHOUSE: 'SERIAL_WRONG_WAREHOUSE',
  SERIAL_NOT_RETURNABLE: 'SERIAL_NOT_RETURNABLE',
  // R9 — مركز تكلفة مُسمّى على فاتورةٍ لا وجود له (أو لغير هذا المستأجر، أو محذوفٌ ناعماً).
  // 404 لا 422: الكيان المُشار إليه غائب، كحال `LOT_NOT_FOUND` — والرسالة تسمّي الحقل
  // (`costCenterId`) ليعرف المُدخِل أي قائمةٍ يختار منها.
  COST_CENTER_NOT_FOUND: 'COST_CENTER_NOT_FOUND',
  // R6 — معرّفٌ ليس UUID وصل إلى مسارٍ أو جسمٍ يتوقّع معرّف صفّ. كان يذهب إلى
  // `where id = $1` فيردّ Postgres `invalid input syntax for type uuid` ويخرج **500**؛
  // والطلب نفسه هو المعطوب لا الخادم، فالجواب **400**. والرمز يفصل هذا الرفض عن
  // `VALIDATION_FAILED` العام: الشاشة تعرف أنها أرسلت معرّفاً لا أن الحقول ناقصة.
  INVALID_ID: 'INVALID_ID',
  // R6 — بطاقة حسابٍ بمعرّفٍ صالحٍ لا وجود له: كان `readAccount` يرمي `Error` عادياً فيخرج
  // **500**؛ والصفّ غائب لا الخادم معطوب، فالجواب **404** برمزه.
  ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
  // R6 — «عميل/مورد» بمعرّفٍ لا وجود له: كان `get()` يعيد `undefined` فيخرج **200 بجسمٍ
  // فارغ** — أسوأ من الخطأ، لأن كل عميلٍ يقرأ JSON ينكسر بلا سبب مفهوم.
  PARTY_NOT_FOUND: 'PARTY_NOT_FOUND',
  // R7 — طُلب تحويل بايتات (رفعٌ أو تنزيل) والتخزين الكائني غير مُهيّأ على هذا الخادم.
  // كان `assertObjectStorageEnv` يرمي `Error` عادياً فيخرج **500** ويُقرأ «عطلٌ في الخادم»
  // بينما الحقيقة «ميزةٌ غير مُهيّأة» — وشاشة مدير الملفات تحتاج أن تقولها بصراحة بدل
  // أن تنهار. والتفصيل يسمّي متغيّرات البيئة الناقصة (`S3_*`) بلا كشف قيمها.
  STORAGE_NOT_CONFIGURED: 'STORAGE_NOT_CONFIGURED',
  // R11 — بطاقة البند (`frmTermsPM.xaml.cs` L244–L250: «من فضلك أدخل رقم البند» ·
  // «من فضلك أدخل اسم البند»): الحقول التي لا يقوم لها البند تُرفض برسالةٍ مفهومة لا
  // بـ500 من قيدٍ في القاعدة.
  BOQ_TERMS_REQUIRED: 'BOQ_TERMS_REQUIRED',
  // R11 — المشروع نفسه: `PM_Projects` يشترط الرقم والاسم والعميل (`projects.party_id`
  // مرجعٌ NOT NULL)، وغيابهم كان يبلغ القاعدة فيردّ 500.
  PROJECT_FIELDS_REQUIRED: 'PROJECT_FIELDS_REQUIRED',
  // R11 — المرحلة بلا اسم (`project_stages.name` NOT NULL).
  PROJECT_STAGE_NAME_REQUIRED: 'PROJECT_STAGE_NAME_REQUIRED',
  // R11 — مرحلةٌ مُسمّاة لا تخصّ المستأجر: 404 لأن المعرّف مجهولٌ عنده.
  PROJECT_STAGE_NOT_FOUND: 'PROJECT_STAGE_NOT_FOUND',
  // R11 — قالب المراحل («🗂️ المجموعة») بلا اسم أو بلا مرحلةٍ واحدة.
  PROJECT_STAGE_TEMPLATE_REQUIRED: 'PROJECT_STAGE_TEMPLATE_REQUIRED',
  // R11 — وأُعلنت هنا رموزٌ كانت وحدة المشاريع تستعملها بلا إعلان (القاعدة: كل رمز
  // `DomainError` يُعلَن في السجلّ): فرع المشروع · بندٌ مجهول · شهادة دفع في حالةٍ لا تقبل الفعل.
  PROJECT_BRANCH_REQUIRED: 'PROJECT_BRANCH_REQUIRED',
  BOQ_TERM_NOT_FOUND: 'BOQ_TERM_NOT_FOUND',
  PROGRESS_BILL_INVALID_STATE: 'PROGRESS_BILL_INVALID_STATE',
  // R11 — «كود البند مدخل مسبقاً» (`frmTermsPM.xaml.cs` L270) وبندٌ سبق فوترته في مستخلص.
  BOQ_TERM_CODE_TAKEN: 'BOQ_TERM_CODE_TAKEN',
  BOQ_TERM_BILLED: 'BOQ_TERM_BILLED',
  // R12 — إغلاق اليومية («عهدة الإغلاق»): رموزٌ كانت وحدة الخزينة تستعملها بلا إعلان
  // (القاعدة: كل رمز `DomainError` يُعلَن في السجلّ)، ورموزُ العهدة الجديدة.
  SHIFT_NOT_FOUND: 'SHIFT_NOT_FOUND',
  SHIFT_INVALID_STATE: 'SHIFT_INVALID_STATE',
  SHIFT_ALREADY_POSTED: 'SHIFT_ALREADY_POSTED',
  /** لا معدودَ ولا متوقّع: لا شيء يتحرّك، فلا قيد. */
  SHIFT_BALANCED: 'SHIFT_BALANCED',
  /** عهدةُ الإغلاق بلا حساب: لا ملفَّ ترحيلٍ يسمّيه ولا حسابَ `1211002` في الدليل. */
  SHIFT_CUSTODY_ACCOUNT_MISSING: 'SHIFT_CUSTODY_ACCOUNT_MISSING',
  // R13 — مناقلة الخزن: رموزٌ كانت وحدة الخزينة تستعملها بلا إعلان (القاعدة نفسها في
  // R11/R12: كل رمز `DomainError` يُعلَن في السجلّ، وإلّا خرج `title` بلا معنى للعميل)،
  // ورموزٌ جديدة لِما كان ناقصاً فعلاً في المناقلة.
  /** مناقلةٌ مُسمّاة لا تخصّ المستأجر: 404، كحال الوردية في R12. */
  CASH_TRANSFER_NOT_FOUND: 'CASH_TRANSFER_NOT_FOUND',
  /** فعلٌ في حالةٍ لا تقبله: إرسال المُرسَلة · استلام غير المُرسَلة · حذف ما خرج. */
  CASH_TRANSFER_INVALID_STATE: 'CASH_TRANSFER_INVALID_STATE',
  /** من خزنة إلى نفسها ليست مناقلة. */
  CASH_TRANSFER_INVALID: 'CASH_TRANSFER_INVALID',
  CASH_TRANSFER_AMOUNT_INVALID: 'CASH_TRANSFER_AMOUNT_INVALID',
  /**
   * حسابُ «نقد تحت التحويل» غائب — المال بين الإرسال والاستلام لا يسكن أيّاً من
   * الخزنتين، فيحتاج حساباً يحمله: ملفُّ ترحيل `cash_transfer.cashInTransitAccountId`،
   * وإلّا `1211003` في الدليل (امتدادُ السحابة، كما `1270003` «بضاعة تحت التحويل»).
   */
  CASH_TRANSFER_TRANSIT_ACCOUNT_MISSING: 'CASH_TRANSFER_TRANSIT_ACCOUNT_MISSING',
  /** خزنةٌ بلا حساب في الدليل: لا مدينَ ولا دائنَ لها — يُربط الحساب أوّلاً. */
  CASH_ACCOUNT_REQUIRED: 'CASH_ACCOUNT_REQUIRED',
  // R13 — سدّ الفجوة: رموزٌ كانت وحدة الخزينة تستعملها بلا إعلان منذ ما قبل R12
  // (القاعدة: كل رمز DomainError يُعلَن). أُضيفت هنا دفعةً واحدة لتجنّب «Request failed».
  CASH_LOCATION_NOT_FOUND: 'CASH_LOCATION_NOT_FOUND',
  CHEQUE_INVALID_STATE: 'CHEQUE_INVALID_STATE',
  CHEQUE_NO_REQUIRED: 'CHEQUE_NO_REQUIRED',
  MOVEMENT_DATE_INVALID: 'MOVEMENT_DATE_INVALID',
  MOVEMENT_RANGE_INVALID: 'MOVEMENT_RANGE_INVALID',
  MOVEMENT_TIME_INVALID: 'MOVEMENT_TIME_INVALID',
  SALESMAN_NOT_FOUND: 'SALESMAN_NOT_FOUND',
  VOUCHER_AMOUNT_INVALID: 'VOUCHER_AMOUNT_INVALID',
  VOUCHER_FOREIGN_AMOUNT_INVALID: 'VOUCHER_FOREIGN_AMOUNT_INVALID',
  VOUCHER_IMMUTABLE: 'VOUCHER_IMMUTABLE',
  VOUCHER_INVALID_STATUS: 'VOUCHER_INVALID_STATUS',
  VOUCHER_NOT_FOUND: 'VOUCHER_NOT_FOUND',
  VOUCHER_TIME_INVALID: 'VOUCHER_TIME_INVALID',
  VOUCHER_VOID_REASON_REQUIRED: 'VOUCHER_VOID_REASON_REQUIRED',
  // AUD-02 — دور نظامي (`is_system`) لا تُعدَّل صفوف صلاحياته من إدارة الأدوار العادية:
  // مجموعة صلاحياته هي **العقد** الذي تُقارَن به الأدوار المخصّصة، وتعديلها من شاشة
  // الأدوار يغيّر معنى «المالك» و«المحاسب» و«الكاشير» بصمت. 422 لأن الطلب سليم والمنع
  // قاعدةُ عقد، لا خطأ خادم.
  SYSTEM_ROLE_PERMISSIONS_IMMUTABLE: 'SYSTEM_ROLE_PERMISSIONS_IMMUTABLE',
  // AUD-02 — دور المالك لا يُمنح من مسارات إدارة العضويّات: منحُه يمنح `*` كاملاً، أي
  // تجاوزاً كاملاً على المنشأة. نقل الملكية عملية مستقلة مصرّح بها ومدقّقة في لوحة
  // المنصّة (`POST /platform/tenants/:id/owner/transfer`). 422 لا 403: مدير العضويّات
  // يملك فعل إدارة العضويّات، والمرفوض هو **الدور** المطلوب.
  OWNER_ROLE_NOT_ASSIGNABLE: 'OWNER_ROLE_NOT_ASSIGNABLE',
} as const;

export type ErrorCode = (typeof errorCodes)[keyof typeof errorCodes];

export function isErrorCode(value: string): value is ErrorCode {
  return Object.prototype.hasOwnProperty.call(errorCodes, value);
}

/** HTTP status each stable code maps to. RFC 9457 `status` member. */
export const errorStatus: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  HANDOFF_CODE_INVALID: 401,
  FORBIDDEN: 403,
  TENANT_SUSPENDED: 423,
  TENANT_CONTEXT_MISSING: 400,
  VALIDATION_FAILED: 400,
  FILTER_NOT_ALLOWED: 400,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_REPLAY: 409,
  ACCOUNT_NOT_POSTABLE: 422,
  JOURNAL_UNBALANCED: 422,
  ACCOUNTING_PERIOD_CLOSED: 423,
  ACCOUNTING_PERIOD_LOCKED_MODULE: 423,
  DOCUMENT_ALREADY_POSTED: 409,
  DOCUMENT_NOT_DRAFT: 409,
  PARTY_CREDIT_LIMIT_EXCEEDED: 422,
  STOCK_INSUFFICIENT: 422,
  SEQUENCE_EXHAUSTED: 422,
  EINVOICE_REJECTED: 422,
  MIGRATION_CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  APPROVAL_REQUIRED: 202,
  ACCOUNT_PROFILE_MISSING: 422,
  MFA_REQUIRED: 401,
  USAGE_LIMIT_REACHED: 409,
  INVALID_STATE: 409,
  CONTENT_SLUG_TAKEN: 409,
  SIGNUP_EMAIL_TAKEN: 409,
  SIGNUP_CODE_INVALID: 422,
  SIGNUP_TOKEN_INVALID: 404,
  LEAD_NOT_FOUND: 404,
  LEAD_ALREADY_CONVERTED: 409,
  LEAD_STATUS_LOCKED: 422,
  CAMPAIGN_LOCKED: 422,
  CAMPAIGN_SEGMENT_EMPTY: 422,
  CAMPAIGN_BODY_INVALID: 422,
  DISCOUNT_LIMIT_EXCEEDED: 422,
  SALES_VOID_HAS_RETURNS: 409,
  SALES_REFERENCE_VOIDED: 409,
  PURCHASE_VOID_HAS_RETURNS: 409,
  PURCHASE_REFERENCE_VOIDED: 409,
  POS_HOLD_LIMIT_REACHED: 422,
  POS_HOLD_NOT_FOUND: 404,
  POS_TENDER_MISMATCH: 422,
  POS_PRICE_OVERRIDE_FORBIDDEN: 403,
  SALES_SETTLEMENT_EXCEEDS_TOTAL: 422,
  LOT_EXPIRY_MISMATCH: 409,
  LOT_NOT_TRACKED: 422,
  SERIAL_DUPLICATE: 409,
  SERIAL_NOT_FOUND: 422,
  SERIAL_COUNT_MISMATCH: 422,
  SERIAL_INVALID_STATE: 422,
  SERIAL_WRONG_WAREHOUSE: 422,
  SERIAL_NOT_RETURNABLE: 422,
  COST_CENTER_NOT_FOUND: 404,
  INVALID_ID: 400,
  ACCOUNT_NOT_FOUND: 404,
  PARTY_NOT_FOUND: 404,
  STORAGE_NOT_CONFIGURED: 503,
  BOQ_TERMS_REQUIRED: 422,
  PROJECT_FIELDS_REQUIRED: 422,
  PROJECT_STAGE_NAME_REQUIRED: 422,
  PROJECT_STAGE_NOT_FOUND: 404,
  PROJECT_STAGE_TEMPLATE_REQUIRED: 422,
  PROJECT_BRANCH_REQUIRED: 422,
  BOQ_TERM_NOT_FOUND: 404,
  PROGRESS_BILL_INVALID_STATE: 409,
  BOQ_TERM_CODE_TAKEN: 409,
  BOQ_TERM_BILLED: 409,
  SHIFT_NOT_FOUND: 404,
  SHIFT_INVALID_STATE: 422,
  SHIFT_ALREADY_POSTED: 409,
  SHIFT_BALANCED: 422,
  SHIFT_CUSTODY_ACCOUNT_MISSING: 422,
  CASH_TRANSFER_NOT_FOUND: 404,
  CASH_TRANSFER_INVALID_STATE: 422,
  CASH_TRANSFER_INVALID: 422,
  CASH_TRANSFER_AMOUNT_INVALID: 422,
  CASH_TRANSFER_TRANSIT_ACCOUNT_MISSING: 422,
  CASH_ACCOUNT_REQUIRED: 422,
  CASH_LOCATION_NOT_FOUND: 404,
  CHEQUE_INVALID_STATE: 422,
  CHEQUE_NO_REQUIRED: 422,
  MOVEMENT_DATE_INVALID: 422,
  MOVEMENT_RANGE_INVALID: 422,
  MOVEMENT_TIME_INVALID: 422,
  SALESMAN_NOT_FOUND: 404,
  VOUCHER_AMOUNT_INVALID: 422,
  VOUCHER_FOREIGN_AMOUNT_INVALID: 422,
  VOUCHER_IMMUTABLE: 409,
  VOUCHER_INVALID_STATUS: 409,
  VOUCHER_NOT_FOUND: 404,
  VOUCHER_TIME_INVALID: 422,
  VOUCHER_VOID_REASON_REQUIRED: 422,
  SYSTEM_ROLE_PERMISSIONS_IMMUTABLE: 422,
  OWNER_ROLE_NOT_ASSIGNABLE: 422,
};

/** RFC 9457 `title` member for each stable code. */
export const errorTitle: Record<ErrorCode, string> = {
  UNAUTHENTICATED: 'Unauthenticated',
  HANDOFF_CODE_INVALID: 'The handoff code is invalid, expired or already used',
  FORBIDDEN: 'Forbidden',
  TENANT_SUSPENDED: 'Tenant suspended',
  TENANT_CONTEXT_MISSING: 'Tenant context missing',
  VALIDATION_FAILED: 'Validation failed',
  FILTER_NOT_ALLOWED: 'Filter not allowed',
  NOT_FOUND: 'Not found',
  VERSION_CONFLICT: 'Version conflict',
  IDEMPOTENCY_REPLAY: 'Idempotency replay',
  ACCOUNT_NOT_POSTABLE: 'Account not postable',
  JOURNAL_UNBALANCED: 'Journal unbalanced',
  ACCOUNTING_PERIOD_CLOSED: 'Accounting period closed',
  ACCOUNTING_PERIOD_LOCKED_MODULE: 'Accounting period locked for module',
  DOCUMENT_ALREADY_POSTED: 'Document already posted',
  DOCUMENT_NOT_DRAFT: 'Document not draft',
  PARTY_CREDIT_LIMIT_EXCEEDED: 'Party credit limit exceeded',
  STOCK_INSUFFICIENT: 'Insufficient stock',
  SEQUENCE_EXHAUSTED: 'Sequence exhausted',
  EINVOICE_REJECTED: 'E-invoice rejected',
  MIGRATION_CONFLICT: 'Migration conflict',
  RATE_LIMITED: 'Rate limited',
  INTERNAL: 'Internal error',
  APPROVAL_REQUIRED: 'Approval required',
  ACCOUNT_PROFILE_MISSING: 'Posting profile missing',
  MFA_REQUIRED: 'Verification code required',
  USAGE_LIMIT_REACHED: 'Usage limit reached',
  INVALID_STATE: 'Invalid state transition',
  CONTENT_SLUG_TAKEN: 'Content slug already taken',
  SIGNUP_EMAIL_TAKEN: 'Email already has an account',
  SIGNUP_CODE_INVALID: 'Verification code rejected',
  SIGNUP_TOKEN_INVALID: 'Signup not found',
  LEAD_NOT_FOUND: 'Lead not found',
  LEAD_ALREADY_CONVERTED: 'Lead already converted',
  LEAD_STATUS_LOCKED: 'Lead status locked',
  CAMPAIGN_LOCKED: 'Campaign locked',
  CAMPAIGN_SEGMENT_EMPTY: 'Campaign segment is empty',
  CAMPAIGN_BODY_INVALID: 'Campaign body invalid',
  DISCOUNT_LIMIT_EXCEEDED: 'Discount limit exceeded',
  SALES_VOID_HAS_RETURNS: 'Invoice has posted returns',
  SALES_REFERENCE_VOIDED: 'Referenced invoice is voided',
  PURCHASE_VOID_HAS_RETURNS: 'Purchase has posted returns',
  PURCHASE_REFERENCE_VOIDED: 'Referenced purchase is voided',
  POS_HOLD_LIMIT_REACHED: 'POS hold slots are full',
  POS_HOLD_NOT_FOUND: 'POS hold was not found',
  POS_TENDER_MISMATCH: 'Tenders do not match the total',
  POS_PRICE_OVERRIDE_FORBIDDEN: 'POS price override is not permitted',
  SALES_SETTLEMENT_EXCEEDS_TOTAL: 'Settlements exceed the invoice total',
  LOT_EXPIRY_MISMATCH: 'This batch was recorded with another expiry date',
  LOT_NOT_TRACKED: 'This item is not tracked by batch',
  INVALID_ID: 'Identifier is not a valid UUID',
  ACCOUNT_NOT_FOUND: 'Account not found',
  SERIAL_DUPLICATE: 'Serial number already exists',
  SERIAL_NOT_FOUND: 'Serial number not found',
  SERIAL_COUNT_MISMATCH: 'Serial count does not match the quantity',
  SERIAL_INVALID_STATE: 'Serial number is not in a movable state',
  SERIAL_WRONG_WAREHOUSE: 'Serial number is in another warehouse',
  SERIAL_NOT_RETURNABLE: 'Serial number was not sold and cannot be returned',
  COST_CENTER_NOT_FOUND: 'Cost centre not found',
  PARTY_NOT_FOUND: 'Party not found',
  STORAGE_NOT_CONFIGURED: 'Object storage is not configured',
  BOQ_TERMS_REQUIRED: 'BOQ code, name and unit value are required',
  PROJECT_FIELDS_REQUIRED: 'Project code, name and customer are required',
  PROJECT_STAGE_NAME_REQUIRED: 'Stage name is required',
  PROJECT_STAGE_NOT_FOUND: 'Project stage not found',
  PROJECT_STAGE_TEMPLATE_REQUIRED: 'Template name and at least one stage are required',
  PROJECT_BRANCH_REQUIRED: 'Project branch is required',
  BOQ_TERM_NOT_FOUND: 'BOQ term not found',
  PROGRESS_BILL_INVALID_STATE: 'Progress bill is not in a state that allows this',
  BOQ_TERM_CODE_TAKEN: 'BOQ term code already exists on this project',
  BOQ_TERM_BILLED: 'A BOQ term already billed on a progress bill cannot be deleted',
  SHIFT_NOT_FOUND: 'Shift close not found',
  SHIFT_INVALID_STATE: 'Only a counted shift can be posted',
  SHIFT_ALREADY_POSTED: 'This shift was already posted',
  SHIFT_BALANCED: 'Nothing was counted and nothing was expected — there is nothing to post',
  SHIFT_CUSTODY_ACCOUNT_MISSING: 'The shift close custody account is not configured',
  CASH_TRANSFER_NOT_FOUND: 'Cash transfer not found',
  CASH_TRANSFER_INVALID_STATE: 'The transfer does not accept this action',
  CASH_TRANSFER_INVALID: 'A transfer needs two different locations',
  CASH_TRANSFER_AMOUNT_INVALID: 'Transfer amount must be positive',
  CASH_TRANSFER_TRANSIT_ACCOUNT_MISSING: 'The cash-in-transit account is not configured',
  CASH_ACCOUNT_REQUIRED: 'This cash location has no account',
  CASH_LOCATION_NOT_FOUND: 'Cash location not found',
  CHEQUE_INVALID_STATE: 'Cheque transition is not allowed',
  CHEQUE_NO_REQUIRED: 'Cheque number is required',
  MOVEMENT_DATE_INVALID: 'Movement date is invalid',
  MOVEMENT_RANGE_INVALID: 'Movement date range is invalid',
  MOVEMENT_TIME_INVALID: 'Movement time is invalid',
  SALESMAN_NOT_FOUND: 'Salesman not found',
  VOUCHER_AMOUNT_INVALID: 'Voucher amount is invalid',
  VOUCHER_FOREIGN_AMOUNT_INVALID: 'Foreign amount is invalid',
  VOUCHER_IMMUTABLE: 'Voucher can no longer be changed',
  VOUCHER_INVALID_STATUS: 'Voucher status does not allow this action',
  VOUCHER_NOT_FOUND: 'Voucher not found',
  VOUCHER_TIME_INVALID: 'Voucher time is invalid',
  VOUCHER_VOID_REASON_REQUIRED: 'Void reason is required',
  SYSTEM_ROLE_PERMISSIONS_IMMUTABLE: 'System role permissions cannot be changed',
  OWNER_ROLE_NOT_ASSIGNABLE: 'The owner role cannot be assigned here',
};

export function statusForCode(code: string): number {
  return isErrorCode(code) ? errorStatus[code] : 500;
}

export function titleForCode(code: string): string {
  return isErrorCode(code) ? errorTitle[code] : 'Request failed';
}
