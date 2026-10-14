import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { DomainError, errorCodes, isUuid } from '@erp/contracts';

/**
 * 🔑 معرّفات المسار — R6 (`INCOMPLETE_INVENTORY.md` §7-1: «معالج UUID عام (500 → 400)»).
 *
 * كانت `GET /api/v1/sales/invoices/not-a-uuid` تصل إلى
 * `where id = 'not-a-uuid'` فيردّ Postgres `invalid input syntax for type uuid` ويخرج
 * **500** `INTERNAL` — وبنفس الطريقة كل مسارٍ في الـAPI يقبل معرّفاً في الرابط:
 * ٣٠٦ معاملاً في ٣٦ وحدة. والخادم هنا بريء: الطلب هو المعطوب، والجواب الصحيح **400** لا
 * أن تُخفى العلّة تحت «خطأ غير متوقّع» ويُسجَّل تتبّعُها في السجلّ وكأنّها عيبُنا.
 *
 * وهذا الحارس يعمل **حيث تُقرأ المعرّفات**: `type === 'param'` واسمٌ هو `id` أو ينتهي بـ
 * `Id` — وهي القاعدة التي تطابق كل مسارات المشروع إلا اثنين (§EXTERNAL). فيرفض قبل قاعدة
 * البيانات: بلا رحلةٍ إلى Postgres، وبلا سطرٍ في سجلّ الأخطاء، وبحقلٍ يسمّي المعامل
 * (`errors[0].field = 'id'`) لتقرأه الشاشة كما تقرأ أخطاء النماذج.
 *
 * وما لا يمرّ من هنا (معرّفٌ في **جسم** الطلب أو في مرشّح استعلام) يُلتقط في مرشّح
 * الاستثناءات العام: خطأ Postgres `22P02` يُترجَم `INVALID_ID` **400** بدل 500. فالطبقتان
 * معاً تغطّيان المنافذ الثلاثة، والأولى هي الدقيقة.
 */
@Injectable()
export class UuidParamPipe implements PipeTransform {
  /**
   * معرّفات من **خارج** النظام لا من صفوفه: معرّف المنتج في متجر سلة ومعرّف المتجر نفسه
   * (`SallaController`) — تُكتب كما يعطيها الطرف الآخر ولا تكون UUID، ولا يستعملها الخادم
   * في `where id = …`. فاستثناؤها بالقائمة لا بالقاعدة، ومكتوب صراحةً لئلا يُنسى سببه.
   */
  private static readonly EXTERNAL_ID_PARAMS = new Set(['remoteId', 'storeId']);

  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'param') return value;

    // النموذج الأول: معاملٌ باسمه — `@Param('id') id: string` (٣٠٦ موضعاً).
    if (typeof metadata.data === 'string') {
      if (!isIdentifierParam(metadata.data)) return value;
      return this.assertUuid(metadata.data, value);
    }

    // النموذج الثاني: **كائن المعاملات كاملاً** — `@Param(new ZodValidationPipe(idParamSchema))
    // params: IdParam` (٦١ مساراً). و`metadata.data` هنا `undefined`، فكان الحارس يمرّ
    // ويسقط الفحص إلى zod الذي يردّ `VALIDATION_FAILED`: الرفض نفسه بالحرف (400) لكن
    // **برمزٍ آخر** لنفس الخطأ — أي أن شاشةً تفرّق بين رمزَي المعرّف كانت تضطر للحالتين.
    // فالقاعدة تُطبَّق على مفاتيح الكائن نفسها، ويبقى المعرّف الخارجي (`remoteId`/`storeId`)
    // مستثنى كما هو.
    if (metadata.data === undefined && isPlainObject(value)) {
      for (const [name, entry] of Object.entries(value)) {
        if (!isIdentifierParam(name)) continue;
        this.assertUuid(name, entry);
      }
      return value;
    }

    return value;
  }

  /**
   * معاملٌ غائب (لا يصل إلى هنا إلا بحالةٍ شاذّة) يُترك كما هو: الحارس يفحص **الشكل** لا
   * الوجود، ووجودُ المعرّف شرطُ المسار نفسه. وغيرُ النصّ (عدديّ من زمن تحويل المسار) يُمرَّر
   * كما كان: قرارُ رفضه يخصّ الأنبوب الذي يعرف نوعه، لا حارس الشكل.
   */
  private assertUuid(name: string, value: unknown): unknown {
    if (typeof value !== 'string') return value;
    if (isUuid(value)) return value;

    // الرمز `INVALID_ID` لا `VALIDATION_FAILED`: الشاشة تفرّق بين «أرسلتَ معرّفاً لا
    // وجود له» و«ينقصك حقل»، والردّ يحمل اسم المعامل في `errors[0].field` كما تحمله
    // أخطاء النماذج — فيُعرض بجانب الحقل لا كخطأ خادم.
    throw new DomainError(errorCodes.INVALID_ID, `The identifier "${name}" is not a valid UUID`, 400, {
      field: name,
      message: 'Expected a UUID',
    });
  }
}

/** كائن معاملاتٍ عادي (لا مصفوفةً ولا نصّاً ولا `null`) — كما يسلّمه Nest لـ`@Param()`. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `id` أو أيّ اسم ينتهي بـ`Id` — عدا معرّفات الطرف الخارجي. */
export function isIdentifierParam(name: string): boolean {
  if (UuidParamPipe['EXTERNAL_ID_PARAMS'].has(name)) return false;
  return name === 'id' || name.endsWith('Id');
}
