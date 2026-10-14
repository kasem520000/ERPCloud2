import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { env } from '@erp/config';
import { publicVerifyInputSchema, type PublicVerifyInput, type PublicVerifyResponse } from '@erp/contracts';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { Public } from '../platform/decorators/public.decorator.js';
import { RateLimit } from '../platform/decorators/rate-limit.decorator.js';

import { VerifyService } from './verify.service.js';

/**
 * `/api/v1/public/verify` — التحقّق العام من فاتورة (P-M8).
 *
 * **مسارٌ واحد، وفقراران ظاهران فيه:**
 *
 *   1. **`POST` لا `GET`** — الحِمل يُلصق ولا يُوضع في الرابط: الرابط يُسجَّل في سجلّات
 *      الوسائط وفي `Referer`، وحِملُ فاتورةٍ ليس شيئاً يُكتب في سطر عنوان. والمقابل أن الزائر
 *      هو من يقرّر الإرسال (زرٌّ في الصفحة)، فليس هذا نداءً يقع تلقائياً عند فتح الصفحة.
 *   2. **`200` في كل جوابٍ مفهوم** — «رمزٌ غير صالح» و«لا سجلّ لهذه الفاتورة» نتائجُ لا أخطاء،
 *      و`404` هنا كان يصنع أداةَ استكشاف: من يعرف الفرق بين «غير موجود» و«موجود» يسأل حتى
 *      يجد. وما يبقى `400` هو مدخلٌ لا يصلح للفحص أصلاً (لا حِمل ولا رمز، أو الاثنان معاً، أو
 *      حِملٌ أطول من الحدّ) — و`422` لا يُستعمل هنا لأنّه لحكم قاعدة تجارية لا لمدخلٍ مرفوض.
 *
 * والدلو **`public-verify`** لا `public-form`: التحقّق قراءةٌ بلا كتابة، ولو شارك دلوَ
 * الاستمارات لأغلق سيلُ الاستمارات بابَ التحقّق (والعكس) — والفصل يجعل لكلٍّ سقفه.
 */
@ApiTags('public-verify')
@Controller('public')
export class PublicVerifyController {
  constructor(private readonly verify: VerifyService) {}

  @Public()
  @Post('verify')
  @HttpCode(200)
  @RateLimit({ name: 'public-verify', limit: env.RATE_LIMIT_PUBLIC_VERIFY_PER_MINUTE, windowMs: 60_000 })
  @ApiOperation({
    summary: 'التحقّق من فاتورة بحِمل رمز QR أو برمز الفاتورة (بلا جلسة)',
    description:
      'يفكّ الحِمل بقواعد العقد المشتركة مع المتصفّح، ثم يقرأ **حالة الفاتورة وحدها** من سجلّ ' +
      'المنصّة إن كانت من إصدارها. ولا يُعاد إجماليٌ ولا رقمُ فاتورةٍ ولا هوية منشأة، ولا يُخزَّن ' +
      'الطلب. الافتراض أن الفحص يقع في المتصفّح، وهذا المسار اختياري.',
  })
  @ApiOkResponse({ description: 'الحُكم: حُكمُ شكلٍ على الرمز + حالةُ الفاتورة في المنصّة إن وُجدت' })
  @ApiResponse({ status: 400, description: 'مدخلٌ لا يصلح للفحص (VALIDATION_FAILED)' })
  @ApiResponse({ status: 429, description: 'تجاوز حدّ المعدّل (RATE_LIMITED)' })
  async verifyInvoice(
    @Body(new ZodValidationPipe(publicVerifyInputSchema)) body: PublicVerifyInput,
  ): Promise<PublicVerifyResponse> {
    return { data: await this.verify.verify(body) };
  }
}
