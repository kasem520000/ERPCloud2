/**
 * P-M7 — صفحة إلغاء الاشتراك: منطقٌ خالص بلا متصفّح ولا شبكة.
 *
 * **ولماذا صفحةٌ في الموقع وليس ردَّ الـAPI وحده؟** لأن مسار الإلغاء يُمشى من بريدٍ يُقرأ في
 * عميلٍ لا يعرف JSON: إمّا صفحةٌ تقول «أُلغي اشتراكك» بلغةٍ يفهمها إنسان، أو رسالةُ خطأٍ
 * إنجليزية. والصفحة تقرأ الـAPI هي نفسها (`GET /api/v1/public/unsubscribe/:token`)، فلا
 * منطقَ إلغاءٍ ثانٍ في الواجهة — والقاعدة تبقى في مكانٍ واحد.
 *
 * والقرارات الثلاث هنا:
 *
 *   1. **الحالات أربع لا واحدة**: لا رمزَ في الرابط · رمزٌ غير معروف (404) · نجح الآن ·
 *      كان ملغى من قبل. ولكلٍّ نصُّه ولونُه، لأن «لم نعرف رابطك» ليست «أُلغي اشتراكك».
 *   2. **لا كشف**: الجواب لا يذكر هل كان العنوان مسجَّلاً في النشرة — وهذا شأن الخادم أصلاً،
 *      والصفحة تنقل ما قالته الـAPI لا أكثر.
 *   3. **بلا فهرسة**: `noindex` — صفحةُ إجراءٍ لا صفحةُ محتوى، وظهورها في نتائج البحث يشوّش
 *      من يبحث عن إلغاء الاشتراك (وهو يفتح رابط الرسالة لا نتائج البحث).
 */

export type UnsubscribeState = 'missing' | 'unknown' | 'done' | 'already';

export type UnsubscribeOutcome = {
  state: UnsubscribeState;
  /** `null` للعنوان: الصفحة لا تعرض بريد صاحبها (قد تُقرأ على شاشةٍ ليست له). */
  email: string | null;
  headingAr: string;
  bodyAr: string;
  tone: 'ok' | 'muted' | 'danger';
};

/** رسائل رموز الأخطاء التي تُعاد من الـAPI — تُقرأ كما يُقرأ رمز HTTP. */
export function unsubscribeOutcome(input: {
  token: string | undefined;
  status: number;
  email?: string | null;
  message?: string | null;
}): UnsubscribeOutcome {
  const token = (input.token ?? '').trim();
  if (token.length === 0) {
    return {
      state: 'missing',
      email: null,
      headingAr: 'لا رابطَ في هذه الصفحة',
      bodyAr:
        'لإلغاء الاشتراك افتح الرابط الذي في آخر الرسالة (أو زرّ «إلغاء الاشتراك» في عميل بريدك) — ' +
        'فالرابط يحمل رمزك، ولا يُخمَّن.',
      tone: 'muted',
    };
  }

  if (input.status === 404) {
    return {
      state: 'unknown',
      email: null,
      headingAr: 'الرابط غير معروف',
      bodyAr:
        'قد يكون الرابط قديماً أو ناقصاً عند نسخه. افتح رسالةً أخيرة منّا واضغط رابط الإلغاء فيها، ' +
        'أو اكتب إلينا وسنُزيل عنوانك يدوياً.',
      tone: 'danger',
    };
  }

  if (input.status !== 200) {
    return {
      state: 'unknown',
      email: null,
      headingAr: 'تعذّر تنفيذ الإلغاء الآن',
      bodyAr: input.message?.trim() || 'حدَث خللٌ مؤقّت. أعد المحاولة بعد قليل — وإن تكرّر راسلنا.',
      tone: 'danger',
    };
  }

  return {
    state: 'done',
    email: null,
    headingAr: 'أُلغي اشتراكك',
    bodyAr:
      'لن تصلك رسائل تسويقية بعد اليوم، وسُجِّل عنوانك في قائمة الحجب عبر المنصّة كلها لا في هذه ' +
      'الرسالة وحدها. وبقيتُ رسائل حسابك الضرورية (فاتورة · ترخيص · استعادة كلمة مرور) تصل كما هي ' +
      '— فهي ليست تسويقاً.',
    tone: 'ok',
  };
}

/**
 * «كان ملغى من قبل» حالةٌ سابعة لا تعرفها الـAPI (فهي تعيد 200 في الحالتين عن قصد).
 * فتُميَّز من نصّ الجواب: الرسالة تقول «مُلغى من قبل» — والمقصود ألّا يظنّ أحدٌ أنه فعّل شيئاً.
 */
export function wasAlreadyUnsubscribed(message: string | null | undefined): boolean {
  const text = (message ?? '').trim();
  return text.includes('من قبل');
}

/** نصوص الواجهة في مكانٍ واحد — تُقاس في اختبار الوحدة بلا متصفّح. */
export const unsubscribeCopy = {
  path: '/unsubscribe',
  titleAr: 'إلغاء الاشتراك',
  backHomeAr: 'العودة إلى الصفحة الرئيسية',
  contactAr: 'إن كان الإلغاء خطأ، اكتب إلينا وسنُعيدك إلى القائمة.',
  supportAr: 'تواصل معنا',
  noindex: true,
} as const;
