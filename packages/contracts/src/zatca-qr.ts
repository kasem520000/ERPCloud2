/**
 * P-M8 — قراءة رمز QR لفاتورة زاتكا، **بدالّةٍ واحدة تحكم المتصفّح والخادم**
 * (`docs/roadmap/MARKETING_SITE_PLAN.md` §5 P-M8).
 *
 * الرمز المطبوع على الفاتورة السعودية نصٌّ base64 يحمل سلسلة TLV: بايتُ وسمٍ، بايتُ طول، ثم
 * القيمة بترميز UTF-8. الوسوم ١–٥ هي المطلوب في المرحلة الأولى (اسم البائع · الرقم الضريبي ·
 * التاريخ · الإجمالي · الضريبة)، والوسوم ٦–٩ تخصّ المرحلة الثانية (بصمة الفاتورة، التوقيع،
 * المفتاح العام، توقيع الشهادة) ووجودها يعني أن الفاتورة **مختومة** لا مجرّد مطبوعة.
 *
 * **ولماذا يسكن الفكّ هنا لا في الواجهة ولا في الخدمة؟** لأن القاعدتين اللتين تُقاس عليهما
 * الواجهة (`/verify`) والخادم (`POST /public/verify`) يجب أن تكونا واحدة: مسحٌ يجده المتصفّح
 * «صالحاً» ثم يقول له الخادم «غير صالح» أسوأ من ألّا يوجد فحصٌ أصلاً. فالفكّ الخالص هنا،
 * والمتصفّح يقرأ به، والخدمة تُصدر به الحُكم — والفرق الوحيد بينهما أن الخادم يضيف إليه
 * حالةَ الفاتورة في سجلّ المنصّة (وهي معلومةٌ لا يملكها المتصفّح).
 *
 * **وبلا `Buffer` وبلا `atob`**: الفكّ مكتوبٌ بجدول base64 صريح، فيعمل في Node وفي المتصفّح
 * وفي أي بيئة بلا مفاتيح، ويُقاس في `zatca-qr.spec.ts` بلا شبكة.
 */

/* eslint-disable no-restricted-syntax */
// الملف يقارن مبالغ **نصّية** وردت داخل رمز QR (تحقّقاً لا حساباً): نقدّم `Number` ثم
// `Decimal` من غير تخزين ولا إسناد. نفس الاستثناء المعلَّل في `invoice-math.ts`.

/** أقصى طولٍ مقبول للرمز — حدٌّ يمنع تحويل النقطة العامّة إلى حِملٍ ثقيل. */
export const ZATCA_QR_PAYLOAD_MAX = 4096;

export type ZatcaQrTag = { tag: number; length: number };

/** الحقول الخمسة القابلة للقراءة — ولا شيء غيرها يخرج من الرمز. */
export type ZatcaQrFields = {
  sellerName: string;
  vatNumber: string;
  /** تاريخ الإصدار ISO 8601 كما هو في الرمز — يُعرض ويُفحص بلا تحويلٍ صامت. */
  timestamp: string;
  /** الإجمالي شامل الضريبة (وسم ٤) — نصّاً لا عدداً: الرمز يقول نصّاً، فلا نُعيد كتابته. */
  total: string;
  /** ضريبة القيمة المضافة (وسم ٥). */
  vatTotal: string;
  /** وجود الوسمين ٦ و٧ معاً: بصمةٌ وتوقيعٌ — أي فاتورة المرحلة الثانية. */
  signed: boolean;
};

export type ZatcaQrProblemCode = 'empty' | 'too_long' | 'not_base64' | 'broken_tlv' | 'missing_required';

export type ZatcaQrDecode =
  | { ok: true; fields: ZatcaQrFields; tags: ZatcaQrTag[] }
  | { ok: false; problem: ZatcaQrProblemCode; detailAr: string; detailEn: string };

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * فكّ base64 — ويقبل صيغة `base64url` أيضاً (`-`/`_`) وحشواً زائداً في الطرف، فبعض قارئات QR
 * تُخرجهما. ويعيد `null` لكل ما ليس base64: الحرف الغريب، والطول المستحيل (`n % 4 === 1`)،
 * و`=` في غير نهاية النصّ. التسامح هنا يعني أن نصّاً عشوائياً قد يُقرأ «رمزاً صالحاً» — وهو
 * أسوأ من رفضه.
 *
 * والبتّات الزائدة في آخر مجموعة تُهمَل بلا رفض: مقصدُنا أن نستخرج الحقول، والتحقّق من
 * شكل TLV بعدها هو الفلتر القويّ — ورفضُ حِملٍ حقيقيّ لأن مُرمِّزه حشا بتّاتٍ زائدة أسوأ.
 */
function decodeBase64(input: string): Uint8Array | null {
  const clean = input.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const stripped = clean.replace(/=+$/, '');
  const padding = clean.length - stripped.length;
  // `=` لا يظهر إلا في النهاية، ولا يزيد على حرفين، ولا يفصل بين بياناتٍ وبيانات.
  if (padding > 2 || (padding > 0 && clean.length % 4 !== 0)) return null;
  if (stripped.length === 0 || stripped.length % 4 === 1) return null;
  if (stripped.includes('=')) return null;

  const bytes = new Uint8Array(Math.ceil((stripped.length * 3) / 4));
  let out = 0;

  for (let index = 0; index < stripped.length; index += 4) {
    const chunk = stripped.slice(index, index + 4);
    const values: number[] = [];
    for (const char of chunk) {
      const value = ALPHABET.indexOf(char);
      if (value < 0) return null;
      values.push(value);
    }
    const a = values[0] ?? 0;
    const b = values[1] ?? 0;
    const c = values[2];
    const d = values[3];
    bytes[out] = (a << 2) | (b >> 4);
    out += 1;
    if (c !== undefined) {
      bytes[out] = ((b & 0x0f) << 4) | (c >> 2);
      out += 1;
    }
    if (d !== undefined && c !== undefined) {
      bytes[out] = ((c & 0x03) << 6) | d;
      out += 1;
    }
  }

  return bytes.subarray(0, out);
}

const UTF8 = new TextDecoder('utf-8');

/**
 * فكّ حِمل الرمز إلى حقوله الخمسة + قائمة وسومه.
 *
 * والشروط: الوسوم ١–٥ **موجودة وغير فارغة** (فاتورةٌ بلا إجمالي ليست فاتورة)، والوسوم في
 * المدى ١–٩ (وسمٌ خارج المدى يعني أن هذا ليس حِمل زاتكا)، والمجموع لا يتجاوز الطول المتاح
 * (رمزٌ مقطوع لا يُقرأ بصفته صالحاً).
 */
export function decodeZatcaQrPayload(payload: string): ZatcaQrDecode {
  const raw = (payload ?? '').trim();
  if (raw.length === 0) {
    return { ok: false, problem: 'empty', detailAr: 'لم تُدخل شيئاً.', detailEn: 'Nothing was entered.' };
  }
  if (raw.length > ZATCA_QR_PAYLOAD_MAX) {
    return {
      ok: false,
      problem: 'too_long',
      detailAr: `النصّ أطول من ${ZATCA_QR_PAYLOAD_MAX} حرفاً — ليس رمزَ فاتورة.`,
      detailEn: `The text is longer than ${ZATCA_QR_PAYLOAD_MAX} characters — not an invoice QR.`,
    };
  }

  const bytes = decodeBase64(raw.replace(/^["']|["']$/g, ''));
  if (!bytes || bytes.length < 4) {
    return {
      ok: false,
      problem: 'not_base64',
      detailAr: 'القيمة المدخلة ليست نصّ base64 صالحاً — انسخ محتوى الرمز كاملاً.',
      detailEn: 'The value is not valid base64 — copy the whole QR payload.',
    };
  }

  const values = new Map<number, string>();
  const tags: ZatcaQrTag[] = [];
  let cursor = 0;
  while (cursor + 2 <= bytes.length) {
    const tag = bytes[cursor] ?? 0;
    const length = bytes[cursor + 1] ?? 0;
    const start = cursor + 2;
    if (tag < 1 || tag > 9) {
      return {
        ok: false,
        problem: 'broken_tlv',
        detailAr: `وسمٌ خارج نطاق زاتكا (${tag}) — النصّ ليس رمزَ فاتورة إلكترونية.`,
        detailEn: `A tag outside ZATCA's range (${tag}) — this is not an e-invoice QR.`,
      };
    }
    if (start + length > bytes.length) {
      return {
        ok: false,
        problem: 'broken_tlv',
        detailAr: 'الرمز مقطوع أو ناقص — القيمة تُقرأ كاملة لا مجزّأة.',
        detailEn: 'The payload is truncated — it must be read whole.',
      };
    }
    if (!values.has(tag)) values.set(tag, UTF8.decode(bytes.subarray(start, start + length)));
    tags.push({ tag, length });
    cursor = start + length;
  }

  if (tags.length === 0) {
    return {
      ok: false,
      problem: 'broken_tlv',
      detailAr: 'لم يُعثر على حقولٍ داخل الرمز.',
      detailEn: 'No fields were found inside the payload.',
    };
  }

  const text = (tag: number) => (values.get(tag) ?? '').trim();
  const fields: ZatcaQrFields = {
    sellerName: text(1),
    vatNumber: text(2),
    timestamp: text(3),
    total: text(4),
    vatTotal: text(5),
    signed: values.has(6) && values.has(7),
  };

  const missing = (['sellerName', 'vatNumber', 'timestamp', 'total', 'vatTotal'] as const).filter(
    (key) => fields[key].length === 0,
  );
  if (missing.length > 0) {
    return {
      ok: false,
      problem: 'missing_required',
      detailAr: `ينقص الرمز حقولٌ تطلبها هيئة الزكاة والضريبة والجمارك: ${missing
        .map((key) => ZATCA_FIELD_LABELS[key].labelAr)
        .join(' · ')}.`,
      detailEn: `The payload is missing required ZATCA fields: ${missing
        .map((key) => ZATCA_FIELD_LABELS[key].labelEn)
        .join(' · ')}.`,
    };
  }

  return { ok: true, fields, tags };
}

/** صيغة اللحظة المقبولة في الرمز: تاريخ + وقت + `Z` أو إزاحة صريحة. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** تسميات الحقول الخمسة — تُعرض في النتيجة وفي الفحوص، فتتفق الواجهة والخادم على الاسم. */
export const ZATCA_FIELD_LABELS: Record<keyof Omit<ZatcaQrFields, 'signed'>, { labelAr: string; labelEn: string }> = {
  sellerName: { labelAr: 'اسم البائع', labelEn: 'Seller' },
  vatNumber: { labelAr: 'الرقم الضريبي', labelEn: 'VAT number' },
  timestamp: { labelAr: 'تاريخ الفاتورة', labelEn: 'Invoice date' },
  total: { labelAr: 'الإجمالي شامل الضريبة', labelEn: 'Total including VAT' },
  vatTotal: { labelAr: 'ضريبة القيمة المضافة', labelEn: 'VAT amount' },
};

export type ZatcaQrCheckCode = 'vat_number' | 'timestamp' | 'totals' | 'vat_rate' | 'signature';
export type ZatcaQrCheckSeverity = 'error' | 'note';

export type ZatcaQrCheck = {
  code: ZatcaQrCheckCode;
  ok: boolean;
  /** `error` يعني «الرمز لا يصلح للتحقّق»، و`note` يعني «صالحٌ ومعه ملاحظة تُقال». */
  severity: ZatcaQrCheckSeverity;
  labelAr: string;
  labelEn: string;
  detailAr: string;
  detailEn: string;
};

const VAT_NUMBER_DIGITS = 15;

/**
 * فحوص الحقول الخمسة — القواعد التي يستطيع أي قارئ تطبيقها بلا سجلٍّ ولا شهادة:
 *
 *   * **الرقم الضريبي**: ١٥ رقماً — وهي القاعدة المكتوبة في هذا المستودع نفسه
 *     (`packages/contracts/src/platform/console.ts:499`)، فلا تُخترع قاعدةٌ سعودية هنا.
 *   * **التاريخ**: يُقرأ كتاريخٍ فعلي (ISO 8601)، فتاريخٌ مبهم لا يُقبل.
 *   * **الأرقام**: الإجمالي والضريبة أرقامٌ غير سالبة، والإجمالي لا يقلّ عن الضريبة.
 *   * **النسبة**: ١٥٪ ليست فحصاً قاطعاً (فالثابتة والصفرية والمعفاة مشروعة) — فحيث تختلف
 *     تُقال ملاحظةٌ لا رفض.
 *   * **الختم**: غياب الوسمين ٦–٧ يعني فاتورة مبسّطة بمرحلةٍ أولى — صالحة، وتُقال الحقيقة.
 */
export function zatcaQrChecks(fields: ZatcaQrFields): ZatcaQrCheck[] {
  const checks: ZatcaQrCheck[] = [];

  const vatOk = new RegExp(`^\\d{${VAT_NUMBER_DIGITS}}$`).test(fields.vatNumber);
  checks.push({
    code: 'vat_number',
    ok: vatOk,
    severity: 'error',
    labelAr: 'الرقم الضريبي',
    labelEn: 'VAT number',
    detailAr: vatOk
      ? `${fields.vatNumber} (${VAT_NUMBER_DIGITS} رقماً)`
      : 'الرقم الضريبي في الرمز ليس ١٥ رقماً — راجع الرمز أو اطلب من المُصدر إعادة إصداره.',
    detailEn: vatOk
      ? `${fields.vatNumber} (${VAT_NUMBER_DIGITS} digits)`
      : 'The VAT number in the payload is not 15 digits — check the code or ask the issuer to reissue.',
  });

  const timestamp = Date.parse(fields.timestamp);
  // التاريخ في الرمز ISO 8601 بلحظةٍ ومنطقةٍ زمنية (مواصفة زاتكا)، و`Date.parse` وحدها تقبل
  // `03/01/2026` على أنها تاريخٌ أمريكيّ — فتلك ليست لحظةً يمكن تأكيدها.
  const timestampOk = Number.isFinite(timestamp) && ISO_INSTANT.test(fields.timestamp);
  checks.push({
    code: 'timestamp',
    ok: timestampOk,
    severity: 'error',
    labelAr: 'تاريخ الفاتورة',
    labelEn: 'Invoice date',
    detailAr: timestampOk
      ? fields.timestamp
      : 'التاريخ داخل الرمز ليس لحظةً بصيغة ISO 8601 (تاريخ + وقت + منطقة) — لا يمكن تأكيد لحظة الإصدار.',
    detailEn: timestampOk
      ? fields.timestamp
      : 'The timestamp inside the payload is not an ISO 8601 instant — the issue moment cannot be confirmed.',
  });

  const total = toAmount(fields.total);
  const vatTotal = toAmount(fields.vatTotal);
  const totalsOk = total !== null && vatTotal !== null && total > 0 && vatTotal >= 0 && total >= vatTotal;
  checks.push({
    code: 'totals',
    ok: totalsOk,
    severity: 'error',
    labelAr: 'الإجمالي والضريبة',
    labelEn: 'Total and VAT',
    detailAr: totalsOk
      ? `${fields.total} شامل الضريبة، ومنها ${fields.vatTotal} ضريبة.`
      : 'الإجمالي والضريبة ليسا رقمين متّسقين — الرمز لا يُقرأ كفاتورة.',
    detailEn: totalsOk
      ? `${fields.total} including ${fields.vatTotal} VAT.`
      : 'The total and VAT are not consistent numbers — the payload does not read as an invoice.',
  });

  if (totalsOk && total !== null && vatTotal !== null) {
    const base = total - vatTotal;
    const rate = base > 0 ? vatTotal / base : 0;
    const standard = Math.abs(rate - 0.15) <= 0.01;
    checks.push({
      code: 'vat_rate',
      ok: standard,
      severity: 'note',
      labelAr: 'النسبة',
      labelEn: 'VAT rate',
      detailAr: standard
        ? 'النسبة ١٥٪ — النسبة القياسية في السعودية.'
        : base <= 0
          ? 'الفاتورة كلها ضريبة بلا وعاء — راجع بنودها.'
          : `النسبة ${(rate * 100).toFixed(2)}٪ لا ١٥٪ — مشروعة إن كانت الفاتورة معفاة أو صفرية أو مختلطة.`,
      detailEn: standard
        ? 'The rate is 15% — the Saudi standard rate.'
        : base <= 0
          ? 'The invoice is all VAT with no base.'
          : `The rate is ${(rate * 100).toFixed(2)}%, not 15% — legitimate for exempt, zero-rated or mixed invoices.`,
    });
  }

  checks.push({
    code: 'signature',
    ok: fields.signed,
    severity: 'note',
    labelAr: 'الختم الإلكتروني',
    labelEn: 'Cryptographic stamp',
    detailAr: fields.signed
      ? 'الرمز يحمل بصمة الفاتورة وتوقيعها (وسوم ٦ و٧) — أي فاتورةٌ مختومة بمرحلةٍ ثانية.'
      : 'لا بصمة ولا توقيع في الرمز: فاتورة مبسّطة بمرحلةٍ أولى — تُقرأ حقولها ولا يُتحقّق من ختمها.',
    detailEn: fields.signed
      ? 'The payload carries the invoice hash and signature (tags 6 and 7) — a phase-two stamped invoice.'
      : 'No hash and no signature: a phase-one simplified invoice — its fields read, its stamp is not provable.',
  });

  return checks;
}

export type ZatcaQrVerdict = {
  valid: boolean;
  /** عدد الفحوص التي لم تنجح — القاطعة والملاحظات معاً (للعرض). */
  notes: number;
  /** ما فشل من الفحوص القاطعة (رموزها) — وعليه يُبنى «غير صالح». */
  failures: ZatcaQrCheckCode[];
};

export function zatcaQrVerdict(checks: readonly ZatcaQrCheck[]): ZatcaQrVerdict {
  const failures = checks.filter((check) => !check.ok && check.severity === 'error').map((check) => check.code);
  return {
    valid: failures.length === 0,
    notes: checks.filter((check) => !check.ok && check.severity === 'note').length,
    failures,
  };
}

/** رقمٌ من نصّ الرمز: يُقبل الفاصلة العربية أيضاً، ويُرفض ما ليس رقماً. */
export function toAmount(value: string): number | null {
  const normalized = value.replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit))).replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
