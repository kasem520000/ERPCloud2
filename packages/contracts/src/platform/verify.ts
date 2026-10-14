/**
 * P-M8 — عقد التحقّق العام من فاتورة (`docs/roadmap/MARKETING_SITE_PLAN.md` §5 P-M8).
 *
 * **القرار الأول: الفحص في المتصفّح افتراضاً.** الصفحة `/verify` تفكّ الرمز محلياً
 * (`@erp/contracts` → `decodeZatcaQrPayload`) وتُظهر حقوله بلا شبكة ولا إرسال. ولا تُرسل شيئاً
 * إلى الخادم إلا إن طلب الزائر ذلك صراحةً — لأن حِمل الرمز بياناتُ فاتورة، ومبدأ العمل أن
 * الزائر هو من يقرّر متى تخرج من جهازه.
 *
 * **والقرار الثاني: الخادم لا يقرأ الفاتورة، بل يقرأ حالتها.** ومع الحِمل يُرجَع حُكمٌ على
 * الشكل (`valid`) وحالةُ الفاتورة **في سجلّ المنصّة** إن كانت هذه المنصّة هي مُصدرها: هل
 * خُلِّصت لدى زاتكا؟ أُبلغت؟ فشلت؟ وهذا ما لا يعرفه المتصفّح، وهو كل ما يضيفه الخادم. ولا
 * يُعاد إجماليٌ ولا رقمُ فاتورةٍ ولا هويةُ منشأةٍ من القاعدة: الحقول التي تظهر هي حقول الرمز
 * نفسه، فلا يتعلّم الخادم عن الزائر شيئاً لا يعرفه أصلاً.
 *
 * **والقرار الثالث: لا «لم تُوجد».** الطلب الذي لا يقابل سجلّاً يعود `record: null` بحالة 200
 * لا بـ404 — فالفرق بين «رمزي صحيح ولا سجلّ له» و«رمزك غير معروف» فرقٌ يصنع أداةَ استكشاف.
 */

import { z } from 'zod';

import { ZATCA_QR_PAYLOAD_MAX, type ZatcaQrCheck, type ZatcaQrFields, type ZatcaQrTag } from '../zatca-qr.js';

/**
 * المدخل بحدٍّ أدنى: إمّا `payload` (حِمل الرمز كما هو) أو `uuid` (رمز الفاتورة في المنصّة).
 * والاثنان معاً أو لا شيء ⇒ 422: البديل يعني تخمين أيّهما فُحص فعلاً.
 */
export const publicVerifyInputSchema = z
  .object({
    payload: z.string().trim().min(8).max(ZATCA_QR_PAYLOAD_MAX).optional(),
    uuid: z.string().trim().uuid().optional(),
  })
  .strict()
  .refine((value) => Boolean(value.payload) !== Boolean(value.uuid), {
    message: 'أدخل حِمل الرمز أو رمز الفاتورة — واحداً منهما فقط',
  });
export type PublicVerifyInput = z.infer<typeof publicVerifyInputSchema>;

/** حالات الفاتورة كما تعود من سجلّ المنصّة — تُوحَّد هنا لأن `zatca_status` نصٌّ حرّ في القاعدة. */
export const publicVerifyStatuses = [
  'cleared',
  'reported',
  'signed',
  'prepared',
  'failed',
  'not_implemented',
  'voided',
  'unknown',
] as const;
export type PublicVerifyStatus = (typeof publicVerifyStatuses)[number];

export type PublicVerifyStatusLabel = {
  labelAr: string;
  labelEn: string;
  /** شرحٌ يقول ما تعنيه الحالة **لمن لا يعرف مصطلحات زاتكا** — وهو الغرض من الصفحة. */
  explanationAr: string;
  explanationEn: string;
  tone: 'ok' | 'note' | 'danger' | 'muted';
};

/**
 * الجدول واحد للواجهة والخادم: اللوحة تُخزّن `zatca_status` بنصٍّ يأتي من وحدة الفاتورة
 * الإلكترونية (`einvoicing.service.ts`: `prepared` · `signed` · `cleared` · `reported` ·
 * `not_implemented` · `failed`، والإلغاء بصيغة `voided:<السبب>` في `sales.service.ts:940`).
 */
export const publicVerifyStatusLabels: Record<PublicVerifyStatus, PublicVerifyStatusLabel> = {
  cleared: {
    labelAr: 'مخلَّصة لدى زاتكا',
    labelEn: 'Cleared with ZATCA',
    explanationAr: 'الفاتورة القياسية قُبلت وخُلِّصت عبر منصة «فاتورة» — وهي الحالة النهائية للفاتورة القياسية.',
    explanationEn: 'The standard invoice was accepted and cleared through Fatoora — the final state of a standard invoice.',
    tone: 'ok',
  },
  reported: {
    labelAr: 'مُبلَّغة إلى زاتكا',
    labelEn: 'Reported to ZATCA',
    explanationAr: 'الفاتورة المبسّطة قُبلت وأُبلغت خلال المهلة — وهي الحالة النهائية للفاتورة المبسّطة.',
    explanationEn: 'The simplified invoice was accepted and reported within the window — the final state of a simplified invoice.',
    tone: 'ok',
  },
  signed: {
    labelAr: 'موقَّعة في المنصّة',
    labelEn: 'Signed in the platform',
    explanationAr:
      'الفاتورة مُوقَّعة ومختومة برمزٍ من مرحلتَي زاتكا، ولم يُسجَّل إرسالها إلى منصة «فاتورة» بعد.',
    explanationEn: 'The invoice is signed and stamped per both ZATCA phases, but filing to Fatoora is not recorded yet.',
    tone: 'note',
  },
  prepared: {
    labelAr: 'مُهيّأة (اختُبرت)',
    labelEn: 'Prepared (test)',
    explanationAr:
      'الفاتورة أُصدرت في وضع التحقّق (simulation) ولم تُرسل إلى منصة «فاتورة» الحقيقية — تُقرأ بياناتها ولا يُدَّعى أنها مخلَّصة.',
    explanationEn: 'The invoice was issued in simulation mode and never filed with production Fatoora — its data reads, its clearance is not claimed.',
    tone: 'note',
  },
  failed: {
    labelAr: 'فشل الإرسال',
    labelEn: 'Filing failed',
    explanationAr: 'آخر محاولة إرسال إلى منصة «فاتورة» لم تنجح — يُراجَع السبب لدى مُصدر الفاتورة.',
    explanationEn: 'The latest filing attempt did not succeed — the issuer should review it.',
    tone: 'danger',
  },
  not_implemented: {
    labelAr: 'لا تكامل معتمد',
    labelEn: 'No approved integration',
    explanationAr:
      'لا تكاملَ معتمداً مع هذه الجهة في هذه البيئة — فاتورةٌ في المنصّة لا فاتورةٌ مُخَلَّصة.',
    explanationEn: 'There is no approved integration with this authority in this environment — an invoice in the platform, not a cleared one.',
    tone: 'note',
  },
  voided: {
    labelAr: 'ملغاة في المنصّة',
    labelEn: 'Voided in the platform',
    explanationAr: 'أُلغيت هذه الفاتورة في المنصّة بعد إصدارها — لا يُعتمد عليها في مطالبةٍ ولا إقرار.',
    explanationEn: 'This invoice was voided in the platform after issue — it stands in no claim or return.',
    tone: 'danger',
  },
  unknown: {
    labelAr: 'حالة غير معروفة',
    labelEn: 'Unknown state',
    explanationAr: 'المنصّة تحمل الفاتورة بحالةٍ لا يعرفها هذا العرض — راجع مُصدر الفاتورة.',
    explanationEn: 'The platform holds this invoice in a state this view does not recognise — check with the issuer.',
    tone: 'muted',
  },
};

/** `prepared` في القاعدة تعني «مُهيّأة» والقيمة الفعلية `prepared`: الجدول أعلاه يحملها كما هي. */
export function publicVerifyStatusOf(zatcaStatus: string | null | undefined): PublicVerifyStatus {
  const value = (zatcaStatus ?? '').trim().toLowerCase();
  if (value.length === 0) return 'unknown';
  if (value.startsWith('voided')) return 'voided';
  return (publicVerifyStatuses as readonly string[]).includes(value) ? (value as PublicVerifyStatus) : 'unknown';
}

/** ما يُقال عن الفاتورة في سجلّ المنصّة — بلا إجمالي ولا رقم فاتورة ولا هوية منشأة. */
export type PublicVerifyRecord = {
  matched: true;
  status: PublicVerifyStatus;
  statusLabelAr: string;
  statusLabelEn: string;
  explanationAr: string;
  explanationEn: string;
  tone: PublicVerifyStatusLabel['tone'];
  /** آخر تحديثٍ سُجِّل على الفاتورة في المنصّة (ISO 8601) — تاريخ الحالة لا تاريخ الفاتورة. */
  recordedAt: string | null;
  /** هل جاء المطابقة من حِمل الرمز أم من رمز الفاتورة. */
  matchedBy: 'payload' | 'uuid';
};

export type PublicVerifyResult = {
  /** حُكم الشكل: هل يُقرأ الحِمل كرمز زاتكا كامل الحقول. */
  valid: boolean;
  /** الرمز صالحٌ ومعه ملاحظة (بلا ختمٍ مثلاً) — تُعرض لكنها لا تُبطل. */
  notes: number;
  /** حقول الرمز كما هي — `null` حين جاء الطلب برمز الفاتورة وحده. */
  fields: ZatcaQrFields | null;
  tags: ZatcaQrTag[] | null;
  checks: ZatcaQrCheck[];
  /** شرحٌ بالفصحى لِما فُحص ولماذا هذا الحُكم — أول ما يُقرأ في الصفحة. */
  verdictAr: string;
  verdictEn: string;
  /** ما تقوله المنصّة عن الفاتورة، أو `null` إن لم يكن لها سجلّ عندنا. */
  record: PublicVerifyRecord | null;
  /** يُذكر دائماً: هذه المنصّة تقرأ سجلّها، والتحقّق الرسمي عبر تطبيق «فاتورة». */
  authorityNoteAr: string;
  authorityNoteEn: string;
};

export type PublicVerifyResponse = { data: PublicVerifyResult };

/** حُملٌ قصير يوضّح الشكل لمن يقرأ العقد: فاتورةٌ مبسّطة بمثال هيئة الزكاة (٣١٠٠٠٠٠٠٠٠٠٠٠٠٣). */
export const PUBLIC_VERIFY_SAMPLE_PAYLOAD =
  'ASTZhdik2LPYs9ipINin2YTYo9mB2YIg2YTZhNiq2KzYp9ix2KkCDzMxMDAwMDAwMDAwMDAwMwMUMjAyNi0wMy0wMVQxMDoxNTowMFoEBjE3Mi41MAUFMjIuNTA=';
