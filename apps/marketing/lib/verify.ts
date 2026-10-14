/**
 * P-M8 — منطق صفحة `/verify` ونصوصها (`docs/roadmap/MARKETING_SITE_PLAN.md` §5 P-M8).
 *
 * **العقد الحاكم للصفحة:** الرمز يُقرأ **في متصفّح الزائر** (عبر `lib/qr.ts` وهو غلافٌ حول
 * `decodeZatcaQrPayload` في `@erp/contracts`)، ولا يخرج منه شيء إلا إذا طلب الزائر نفسه
 * «التحقّق في الخادم». فالمنطق هنا **خالص** (بلا `fetch` وبلا حالة): يأخذ نصّاً ويعيد حُكماً،
 * فيُقاس في اختبار وحدة بلا متصفّح، وتبقى الصفحة رقيقة.
 *
 * **وحُكمان لا حُكم واحد:**
 *   * **حُكم الشكل** (`decideLocally`) — في المتصفّح: هل هذه حقولُ رمزِ فاتورةٍ كاملة؟ وليس
 *     فيه ادّعاء: لا يعرف هذا الفحص شيئاً عن سجلّ المنصّة ولا عن زاتكا.
 *   * **حُكم السجلّ** (`POST /public/verify`) — اختياريٌّ وبموافقةٍ صريحة: يضيف حالةَ الفاتورة
 *     في المنصّة، وهي المعلومة الوحيدة التي لا يملكها المتصفّح.
 *
 * والقواعد التي تُقاس عليها الحقول تأتي من العقد نفسه (`zatcaQrChecks`) — الواجهة والخادم
 * يحكمان بالقاعدة ذاتها، فلا يقول أحدهما «صالح» والآخر «غير صالح».
 */

import {
  PUBLIC_VERIFY_SAMPLE_PAYLOAD,
  ZATCA_FIELD_LABELS,
  zatcaQrChecks,
  zatcaQrVerdict,
  type PublicVerifyResult,
  type PublicVerifyStatusLabel,
  type ZatcaQrCheck,
  type ZatcaQrFields,
} from '@erp/contracts';

import { decodeZatcaQr } from './qr';

export const VERIFY_PATH = '/verify';

/** المثال المعروض في الصفحة: فاتورةٌ ببياناتها الوهمية الصريحة (٣١٠٠٠٠٠٠٠٠٠٠٠٠٣ = مثال الهيئة). */
export const VERIFY_SAMPLE_PAYLOAD = PUBLIC_VERIFY_SAMPLE_PAYLOAD;

export type VerifyMode = 'payload' | 'uuid';

export type VerifyLocalOutcome =
  | { ok: false; messageAr: string; tone: 'error' | 'info' }
  | {
      ok: true;
      fields: ZatcaQrFields;
      checks: ZatcaQrCheck[];
      /** تجاوز الفحوص القاطعة — والملاحظات لا تُبطله. */
      valid: boolean;
      /** عدد الملاحظات (فحوصٌ لم تنجح لكنها ليست أخطاء). */
      notes: number;
      headlineAr: string;
    };

/**
 * حُكم الشكل في المتصفّح. ولا يُخدع الزائر: الفحص يقول ما يقيسه («فحوص الحقول الخمسة»)، ولا
 * يقول «الفاتورة صحيحة» — لأن ذلك حكمُ جهةٍ لا حكمُ قارئ.
 */
export function decideLocally(mode: VerifyMode, value: string): VerifyLocalOutcome {
  const text = value.trim();
  if (text.length === 0) return { ok: false, tone: 'error', messageAr: 'لم تُدخل شيئاً بعد.' };
  if (mode === 'uuid') {
    return {
      ok: false,
      tone: 'info',
      messageAr:
        'رمز الفاتورة (UUID) لا حقول فيه ليُقرأ في متصفّحك: فعّل خيار الموافقة ثم اضغط «التحقّق في الخادم» ليعود بحالة الفاتورة من سجلّ المنصّة، أو الصق حِمل رمز QR لتحصل على الفحص كاملاً هنا بلا إرسال.',
    };
  }

  let fields: ZatcaQrFields;
  try {
    fields = decodeZatcaQr(text);
  } catch (error) {
    return { ok: false, tone: 'error', messageAr: error instanceof Error ? error.message : 'تعذّرت قراءة الرمز.' };
  }

  const checks = zatcaQrChecks(fields);
  const verdict = zatcaQrVerdict(checks);
  if (!verdict.valid) {
    return {
      ok: true,
      fields,
      checks,
      valid: false,
      notes: verdict.notes,
      headlineAr: 'الحقول تُقرأ، لكن الفحص لا يجتاز: هذا ليس رمزَ فاتورةٍ سليمة الشكل.',
    };
  }

  return {
    ok: true,
    fields,
    checks,
    valid: true,
    notes: verdict.notes,
    headlineAr:
      verdict.notes === 0
        ? 'الرمز يُقرأ كفاتورة إلكترونية سليمة الشكل: الحقول الخمسة موجودة، والرقم الضريبي والتاريخ والأرقام متّسقة.'
        : `الرمز يُقرأ كفاتورة سليمة الشكل، ومعه ${verdict.notes === 1 ? 'ملاحظةٌ واحدة' : `${verdict.notes} ملاحظات`} مشروحة في الفحوص أدناه.`,
  };
}

/** حِمل الإرسال إلى الخادم — واحدٌ من الحقلين لا الاثنان (والعقد يرفض غير ذلك بمخالفة مدخل). */
export function serverInput(mode: VerifyMode, value: string): { payload: string } | { uuid: string } {
  const text = value.trim();
  return mode === 'uuid' ? { uuid: text } : { payload: text };
}

/** رسالة عطل الخادم — والخادم قد يسقط وفحصُ المتصفّح يبقى صالحاً، فيُقال ذلك صراحةً. */
export function serverProblemMessage(status: number, code?: string): string {
  if (status === 0) {
    return 'تعذّر الوصول إلى الخادم — والفحص المحلي أعلاه ما زال صالحاً، لأنه لم يعتمد عليه أصلاً.';
  }
  if (status === 429 || code === 'RATE_LIMITED') return 'محاولات كثيرة خلال وقتٍ قصير — انتظر دقيقة ثم أعد المحاولة.';
  if (status === 400) return 'المدخل لا يصلح للفحص الخادمي: أدخل حِمل الرمز أو رمز الفاتورة — واحداً منهما لا الاثنين.';
  return 'تعذّر التحقّق في الخادم الآن. أعِد المحاولة، أو اكتفِ بالفحص المحلي الذي تمّ في متصفّحك.';
}

/** صنف الشارة من لون الحالة — والأنماط كلها من ورقة الأنماط القائمة (`badge ready|pending|failed`). */
export function toneClass(tone: PublicVerifyStatusLabel['tone']): string {
  if (tone === 'ok') return 'badge ready';
  if (tone === 'danger') return 'badge failed';
  if (tone === 'note') return 'badge pending';
  return 'badge';
}

/** صنف سطر الفحص: ناجح · ملاحظة · خطأ. */
export function checkClass(check: ZatcaQrCheck): string {
  if (check.ok) return 'badge ready';
  return check.severity === 'error' ? 'badge failed' : 'badge pending';
}

/** تاريخٌ مقروء للعرض — يُقال «آخر تحديث للحالة» لا «تاريخ الفاتورة». */
export function readableRecordedAt(value: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 16).replace('T', ' ') : value;
}

/** صفوف الحقول الخمسة للعرض — بالتسميات التي يشترك فيها العقد، فلا تُكتب تسميةٌ في الواجهة. */
export function fieldRows(fields: ZatcaQrFields): Array<{ key: keyof typeof ZATCA_FIELD_LABELS; label: string; value: string }> {
  return (Object.keys(ZATCA_FIELD_LABELS) as Array<keyof typeof ZATCA_FIELD_LABELS>).map((key) => ({
    key,
    label: ZATCA_FIELD_LABELS[key].labelAr,
    value: fields[key],
  }));
}

/** هل طابق الخادمُ سجلّاً لفاتورة؟ — تُستعمل في عرض الحالة للتفرقة بين «لا سجلّ» و«سجلّ». */
export function hasRecord(result: PublicVerifyResult): boolean {
  return result.record !== null;
}

/** نصوص الصفحة في مكانٍ واحد — تُقاس في اختبار الوحدة، ولا تُكرَّر في الـJSX. */
export const verifyCopy = {
  titleAr: 'التحقّق من فاتورة إلكترونية',
  leadAr:
    'الصق حِمل رمز QR المطبوع على الفاتورة (نصّ base64) أو رمز الفاتورة، فيُقرأ الرمز وتُعرض حقوله — '
    + 'البائع · الرقم الضريبي · التاريخ · الإجمالي · الضريبة · الختم — ومعها حالةُ الفاتورة في سجلّ المنصّة إن طلبتها.',
  privacyAr:
    'القراءة تقع داخل متصفّحك، ولا يُرسل شيء إلى أي خادم ما لم تطلب ذلك بنفسك من زرّ «التحقّق في الخادم» أدناه.',
  payloadLabelAr: 'حِمل رمز QR',
  payloadHintAr: 'AQ4… (محتوى الرمز كاملاً — من الماسح أو من صورة الفاتورة)',
  uuidLabelAr: 'رمز الفاتورة (UUID)',
  uuidHintAr: 'مثال: 3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  readCtaAr: 'اقرأ الرمز في متصفّحك',
  clearCtaAr: 'مسح',
  sampleCtaAr: 'جرّب بمثال (بيانات وهمية)',
  serverCtaAr: 'التحقّق في الخادم',
  consentAr:
    'أوافق على إرسال هذا المُدخل إلى خادم المنصّة لقراءة حالة الفاتورة من سجلّها. ويُقرأ ويُجاب ولا يُخزَّن ولا يُدقَّق.',
  serverPendingAr: 'جارٍ السؤال…',
  serverIdleAr: 'لم يُرسل شيء إلى الخادم بعد. للحصول على حالة الفاتورة في السجلّ فعّل الخيار ثم اضغط الزرّ.',
  fieldsTitleAr: 'حقول الرمز',
  checksTitleAr: 'الفحوص',
  statusTitleAr: 'الحالة في سجلّ المنصّة',
  statusMissingAr:
    'لا سجلَّ لهذه الفاتورة في منصّتنا: الرمز قد يكون سليماً لكن الفاتورة ليست من إصدار هذه المنصّة (أو لم تُرسل إليها بعد).',
  recordedAtLabelAr: 'آخر تحديث للحالة',
  authoritySmallAr:
    'للتحقّق الرسمي من الفاتورة استخدم تطبيق «فاتورة» من هيئة الزكاة والضريبة والجمارك — هذه الصفحة تقرأ الرمز وحالةَ السجلّ ولا تُصدر حكماً نظامياً.',
  howToReadAr: [
    '«حقل» يعني وسماً قرأه النظام من الرمز نفسه؛ لا يمكن أن يظهر حقلٌ ليس في الرمز.',
    '«الختم» يعني وجود بصمة الفاتورة وتوقيعها (وسوم ٦ و٧)؛ غيابه يعني فاتورة مبسّطة بمرحلةٍ أولى — وهي صالحة.',
    '«الحالة في السجلّ» تظهر فقط من زرّ التحقّق في الخادم، وهي ما تعرفه المنصّة عن هذه الفاتورة إن كانت من إصدارها.',
  ],
} as const;
