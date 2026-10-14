import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  decodeZatcaQrPayload,
  publicVerifyStatusOf,
  publicVerifyStatusLabels,
  zatcaQrChecks,
  zatcaQrVerdict,
  type PublicVerifyInput,
  type PublicVerifyRecord,
  type PublicVerifyResult,
  type ZatcaQrFields,
} from '@erp/contracts';
import { withPlatformAdminTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';

/**
 * P-M8 — `POST /public/verify`: التحقّق الخادمي الاختياري (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * **الافتراض أن الزائر لا يُرسل شيئاً.** صفحة `/verify` تفكّ الرمز في متصفّحه وتعرض حقوله
 * بلا شبكة؛ ولا يصل إلى هنا إلا من ضغط «تحقّق في الخادم» بنفسه. ولذلك هذه الخدمة **لا تكتب
 * شيئاً ولا تُدقَّق ولا تُسجَّل ولا تحفظ**: لا صفَّ تحقّق، ولا عنوان، ولا حِمل — الطلب يُقرأ
 * ويُجاب ويُنسى.
 *
 * **والقرار الأمني الوحيد الذي يحتاج تبريراً: كيف نقرأ فاتورةً بلا سياق منشأة؟**
 *
 * جدول `sales_invoices` يعمل بـRLS لكل منشأة، وهذا الطلب بلا جلسة. فالمسار هنا **معاملة
 * بسياق المنصّة** (`withPlatformAdminTx`) — وهو النمط نفسه الذي استعملته مسارات الحملة
 * العامّة في P-M7 («الرمز هو التصريح»: رمزٌ لا يُخمَّن يُقابَل بصفٍّ واحد). وثلاثة قيود تجعل
 * الباب ضيّقاً بالفعل لا في الوصف:
 *
 *   1. **مطابقةٌ تامّة على الحِمل نفسه** (`zatca_qr = $1`) أو على رمز الفاتورة (`zatca_uuid`).
 *      لا بحثٌ جزئيّ ولا قائمةٌ ولا تعداد — من لا يملك رمز الفاتورة لا يستطيع السؤال عنها.
 *   2. **الاستعلام لا يقرأ إلا عمودين** (`zatca_status` و`updated_at`)، والمُعاد **حالةٌ
 *      وشرح**: لا إجمالي، ولا رقم فاتورة، ولا اسم مشترٍ، ولا هوية منشأة. فما يتعلّمه الخادم
 *      من الطلب شيء لا يعرفه الزائر أصلاً، وما يتعلّمه الزائر جديدٌ لكنه ليس ملك غيره.
 *   3. **لا سؤال للقاعدة عن حِملٍ لم يُقرأ**: الحُكم على الشكل أولاً، ثم الاستعلام — فرشقُ
 *      نصوصٍ عشوائية لا يلمس القاعدة أصلاً (ومعه محدّد المعدّل على دلو `public-verify`).
 *
 * **والحُكم حُكمان لا حُكم**: (١) هل يُقرأ الحِمل كرمز زاتكا كامل الحقول؟ — قواعدُ صريحة في
 * `@erp/contracts` (`zatcaQrChecks`)، يشترك فيها المتصفّح والخادم فلا يختلفان؛ (٢) ما حال
 * الفاتورة في سجلّ المنصّة؟ — وهذا وحده ما يضيفه الخادم.
 *
 * **وما لا نقوله مهمّ**: لا ندّعي أن المنصّة «تتحقّق من زاتكا». الحالة تُقرأ من سجلّنا،
 * والتحقّق الرسمي عبر تطبيق «فاتورة» — وهذه الجملة تأتي مع كل استجابة (`authorityNote`) لا في
 * حاشية الصفحة وحدها.
 */

/**
 * الجملة التي تُرفق بكل استجابة — الثابت الذي لا يُخفَّف تحت ضغط التسويق: المنصّة تقرأ
 * سجلّها، والجهة الرسمية وحدها تُصدر حُكماً على الفاتورة.
 */
const AUTHORITY_NOTE_AR =
  'هذه المنصّة تقرأ سجلّها هي: حقول الرمز من الرمز نفسه، وحالة الفاتورة من قاعدة المنصّة. ' +
  'وللتحقّق الرسمي استخدم تطبيق «فاتورة» من هيئة الزكاة والضريبة والجمارك. ولا نحفظ ما لصقتَه هنا.';
const AUTHORITY_NOTE_EN =
  'This platform reads its own records: the QR fields come from the code itself and the invoice state ' +
  'comes from the platform database. For official verification use ZATCA’s Fatoora app. What you pasted is not stored.';

type InvoiceRow = { zatca_status: string | null; updated_at: string | Date | null };

@Injectable()
export class VerifyService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  async verify(input: PublicVerifyInput): Promise<PublicVerifyResult> {
    const decoded = input.payload ? decodeZatcaQrPayload(input.payload) : null;

    // حِملٌ لا يُقرأ: يُقال ما فيه وينتهي الأمر بلا استعلام — لا نبحث عن فاتورةٍ في نصٍّ عشوائي.
    if (decoded && !decoded.ok) {
      return {
        valid: false,
        notes: 0,
        fields: null,
        tags: null,
        checks: [],
        verdictAr: `${decoded.detailAr} لم يُتحقّق من أي سجلّ، ولم يُرسل شيء إلى قاعدة المنصّة.`,
        verdictEn: `${decoded.detailEn} No record was consulted and nothing reached the platform database.`,
        record: null,
        authorityNoteAr: AUTHORITY_NOTE_AR,
        authorityNoteEn: AUTHORITY_NOTE_EN,
      };
    }

    const fields: ZatcaQrFields | null = decoded && decoded.ok ? decoded.fields : null;
    const checks = fields ? zatcaQrChecks(fields) : [];
    const verdict = zatcaQrVerdict(checks);
    const matchedBy: PublicVerifyRecord['matchedBy'] = fields ? 'payload' : 'uuid';
    const record = await this.lookup(matchedBy === 'uuid' ? (input.uuid ?? '') : (input.payload ?? ''), matchedBy);

    if (!fields) {
      return {
        valid: record !== null,
        notes: 0,
        fields: null,
        tags: null,
        checks: [],
        verdictAr: record
          ? `عُثر على الفاتورة في سجلّ المنصّة برمز الفاتورة. ${publicVerifyStatusLabels[record.status].explanationAr}`
          : 'لا سجلَّ لهذا الرمز في المنصّة: قد يكون الرمز ناقصاً أو خطأً مطبعياً، أو فاتورةً من نظامٍ آخر. اسأل مُصدر الفاتورة عن رمز QR المطبوع عليها — فهو الأقوى لأنه يشمل الحقول والختم معاً.',
        verdictEn: record
          ? `The invoice was found in the platform records by its invoice code. ${publicVerifyStatusLabels[record.status].explanationEn}`
          : 'No record for this code in the platform: it may be mistyped, or an invoice from another system. Ask the issuer for the printed QR — it is the stronger key because it carries both the fields and the stamp.',
        record,
        authorityNoteAr: AUTHORITY_NOTE_AR,
        authorityNoteEn: AUTHORITY_NOTE_EN,
      };
    }

    return {
      valid: verdict.valid,
      notes: verdict.notes,
      fields,
      tags: decoded && decoded.ok ? decoded.tags : null,
      checks,
      verdictAr: verdictText(fields, verdict.valid, verdict.failures, record),
      verdictEn: verdictTextEn(fields, verdict.valid, verdict.failures, record),
      record,
      authorityNoteAr: AUTHORITY_NOTE_AR,
      authorityNoteEn: AUTHORITY_NOTE_EN,
    };
  }

  /**
   * البحث الوحيد في القاعدة — عمودان، وصفٌّ واحد، ومطابقةٌ تامّة.
   *
   * والمطابقة على الحِمل **تتجاهل حشو `=`** من الطرفين: من ينقل الرمز قد يُسقط الحشو (أو
   * يُضيفه)، والقاعدة تحمل الصيغة كما بُنيت على الفاتورة. ورفضُ حِملٍ سليم لأن حرفَ حشوٍ
   * اختلف خطأٌ يقع على الزائر لا عليه — والتطبيع بـ`rtrim` هو الفرق بين «لم توجد فاتورة» و
   * «وُجدت وحالتها كذا».
   */
  private async lookup(
    value: string,
    matchedBy: PublicVerifyRecord['matchedBy'],
  ): Promise<PublicVerifyRecord | null> {
    if (value.trim().length === 0) return null;
    const raw = value.trim();
    const unpadded = raw.replace(/=+$/, '');

    const row = await withPlatformAdminTx(this.database.db, async (tx) => {
      const result =
        matchedBy === 'uuid'
          ? await tx.execute(sql`
              SELECT zatca_status, updated_at
                FROM sales_invoices
               WHERE zatca_uuid = ${raw}
               LIMIT 1
            `)
          : await tx.execute(sql`
              SELECT zatca_status, updated_at
                FROM sales_invoices
               WHERE zatca_qr = ${raw} OR rtrim(zatca_qr, '=') = ${unpadded}
               LIMIT 1
            `);
      return result.rows[0] as InvoiceRow | undefined;
    });

    if (!row) return null;
    const status = publicVerifyStatusOf(row.zatca_status);
    const label = publicVerifyStatusLabels[status];
    return {
      matched: true,
      status,
      statusLabelAr: label.labelAr,
      statusLabelEn: label.labelEn,
      explanationAr: label.explanationAr,
      explanationEn: label.explanationEn,
      tone: label.tone,
      recordedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      matchedBy,
    };
  }
}

/** جملة الحُكم — تُبنى من نتيجة الفحوص ومن السجلّ إن وُجد، فتُقرأ مرةً واحدة بلا استنتاج. */
function verdictText(
  fields: ZatcaQrFields,
  valid: boolean,
  failures: readonly string[],
  record: PublicVerifyRecord | null,
): string {
  const reason = valid
    ? 'يُقرأ الرمز كرمز فاتورة إلكترونية سعودي: الحقول الخمسة موجودة، والرقم الضريبي خمسة عشر رقماً، والتاريخ لحظةٌ معروفة، والإجمالي والضريبة متّسقان.'
    : `الرمز يُقرأ لكنه لا يجتاز الفحص: ${failures
        .map((code) => CHECK_FAILURES_AR[code] ?? code)
        .join(' · ')}. راجع الرمز مع مُصدر الفاتورة.`;
  const stamp = fields.signed
    ? ' ومعه بصمةٌ وتوقيع (وسوم ٦ و٧) — أي فاتورة مرحلةٍ ثانية.'
    : ' ولا توقيع فيه (وسوم ٦–٧ غائبة): فاتورة مبسّطة بمرحلةٍ أولى — تُقرأ حقولها ولا يُثبت ختمها.';
  const recordLine = record
    ? ` وحالتها في سجلّ المنصّة: «${record.statusLabelAr}» — ${record.explanationAr}`
    : ' ولا سجلَّ لهذه الفاتورة في منصّتنا (قد تكون صادرةً من نظام آخر).';
  return `${reason}${valid ? stamp : ''}${recordLine}`;
}

function verdictTextEn(
  fields: ZatcaQrFields,
  valid: boolean,
  failures: readonly string[],
  record: PublicVerifyRecord | null,
): string {
  const reason = valid
    ? 'The payload reads as a Saudi e-invoice QR: all five fields are present, the VAT number is 15 digits, the timestamp is a real instant, and the total and VAT are consistent.'
    : `The payload reads but fails inspection: ${failures.join(' · ')}. Check it with the issuer.`;
  const stamp = fields.signed
    ? ' It carries a hash and a signature (tags 6 and 7) — a phase-two invoice.'
    : ' It carries no signature (tags 6–7 are absent): a phase-one simplified invoice — readable fields, unprovable stamp.';
  const recordLine = record
    ? ` In the platform records its state is “${record.statusLabelEn}” — ${record.explanationEn}`
    : ' The platform holds no record of this invoice (it may come from another system).';
  return `${reason}${valid ? stamp : ''}${recordLine}`;
}

/** شرح الفحوص القاطعة بالعربية — يُستعمل في جملة الحُكم وحدها (والتفصيل في `checks`). */
const CHECK_FAILURES_AR: Record<string, string> = {
  vat_number: 'الرقم الضريبي ليس ١٥ رقماً',
  timestamp: 'التاريخ ليس لحظةً بصيغة ISO 8601',
  totals: 'الإجمالي والضريبة غير متّسقين',
};
