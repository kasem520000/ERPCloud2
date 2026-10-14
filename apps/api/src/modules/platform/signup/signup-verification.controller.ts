import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { env } from '@erp/config';
import {
  DomainError,
  errorCodes,
  isSignupCodeShaped,
  normalizeSignupEmail,
  signupRequestSchema,
  signupResendRequestSchema,
  signupVerifyRequestSchema,
  type SignupRequest,
  type SignupResendRequest,
  type SignupVerifyRequest,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { Public } from '../decorators/public.decorator.js';
import { RateLimit } from '../decorators/rate-limit.decorator.js';
import { PublicPlansService } from '../billing/public-plans.service.js';

import { SignupService } from './signup.service.js';

/**
 * `/api/v1/signup` — التسجيل الذاتي العام (P-M4).
 *
 * **الأبواب الأربعة، وترتيبها هو ترتيب المعالج في الموقع**:
 *
 *   1. `GET  /signup/plans`    — الباقات المعروضة (نفس مصدر صفحة الأسعار).
 *   2. `POST /signup`          — إنشاء المنشأة والمدير + إرسال رمز التحقّق.
 *   3. `POST /signup/verify`   — تأكيد الرمز.
 *   4. `POST /signup/resend`   — رمزٌ جديد بمهلةٍ وسقف.
 *   5. `GET  /signup/status/:email?token=` — الحالة ومهامّ الإعداد المتبقية.
 *
 * وكلّها عامة (`@Public()`) لأنها تُستدعى بلا حساب — وهذا وحده يستوجب حدًّا على المعدّل:
 * كل نقطة هنا تُنشئ صفّاً أو ترسل بريداً. والحدّ على دلو `signup` (دلو الدخول نفسه: من
 * يستطيع أن يجعلنا نُرسل مئة رسالةٍ إلى عنوانٍ لا يملكه يجعلنا مُرسِلَ إزعاج).
 * والرخصة لا تُمنح من هنا أبداً — يُفتح طلبُ تفعيلٍ يوافق عليه المشغّل.
 */
@ApiTags('signup')
@Controller()
export class SignupVerificationController {
  constructor(
    private readonly signup: SignupService,
    private readonly plans: PublicPlansService,
  ) {}

  @Public()
  @Get('signup/plans')
  @RateLimit({ name: 'signup', limit: env.RATE_LIMIT_DEFAULT_PER_MINUTE, windowMs: 60_000 })
  @ApiOperation({
    summary: 'الباقات التي يختار منها المُلتحق',
    description:
      'نفس ما تعرضه صفحة `/pricing` بالضبط: النشطة وحدها، بحقوقها بلغتين، ومعها نسبة ' +
      'الضريبة في `meta` — فلا تفترق قائمةُ الباقات بين صفحة الأسعار وخطوة الاشتراك.',
  })
  async planChoices() {
    const { plans: rows, vatRatePercent } = await this.plans.publicPricing();
    return { data: rows, meta: { vatRatePercent, count: rows.length } };
  }

  @Public()
  @Post('signup')
  @HttpCode(201)
  @RateLimit({ name: 'signup', limit: env.RATE_LIMIT_LOGIN_PER_MINUTE, windowMs: 60_000 })
  @ApiOperation({
    summary: 'إنشاء منشأة ومدير وطلب تفعيل، ثم إرسال رمز تحقّق إلى بريد المدير',
    description:
      'يُعاد **الرمز المميّز** (`token`) مرّةً واحدة، ولا يُعاد رمز التحقّق أبداً: يُرسل بالبريد ' +
      'وحده. والرخصة لا تُمنح هنا — الطلب في طابور التفعيل.',
  })
  @ApiResponse({ status: 201, description: 'أُنشئت المنشأة، والبريد في الطريق' })
  @ApiResponse({ status: 409, description: 'البريد يملك منشأةً بالفعل (SIGNUP_EMAIL_TAKEN)' })
  @ApiResponse({ status: 422, description: 'بياناتٌ غير صالحة أو باقةٌ غير معروضة' })
  @ApiResponse({ status: 403, description: 'التسجيل الذاتي معطّل على هذا الخادم' })
  async start(@Body(new ZodValidationPipe(signupRequestSchema)) body: SignupRequest) {
    if (env.SIGNUP_ENABLED === false) {
      throw new DomainError(
        errorCodes.FORBIDDEN,
        'التسجيل الذاتي معطّل على هذا الخادم. تواصل مع إدارة المنصة.',
        403,
      );
    }
    return { data: await this.signup.start({ ...body, ownerEmail: normalizeSignupEmail(body.ownerEmail) }) };
  }

  @Public()
  @Post('signup/verify')
  @HttpCode(200)
  @RateLimit({ name: 'signup-verify', limit: env.RATE_LIMIT_LOGIN_PER_MINUTE, windowMs: 60_000 })
  @ApiOperation({ summary: 'تأكيد رمز التحقّق المرسل بالبريد' })
  @ApiResponse({ status: 200, description: 'الحالة ومهامّ الإعداد المتبقية' })
  @ApiResponse({ status: 422, description: 'رمزٌ خاطئ أو منتهٍ أو مستهلَك (SIGNUP_CODE_INVALID)' })
  @ApiResponse({ status: 404, description: 'تسجيلٌ غير موجود (SIGNUP_TOKEN_INVALID)' })
  async verify(
    @Body(new ZodValidationPipe(signupVerifyRequestSchema)) body: SignupVerifyRequest,
  ) {
    // فحص الشكل قبل أي استعلام: رمزٌ من حروفٍ ليس خطأ «قاعدة بيانات»، بل خطأ إدخال.
    if (!isSignupCodeShaped(body.code)) {
      throw new DomainError(errorCodes.SIGNUP_CODE_INVALID, 'الرمز ستة أرقام كما وصلت في البريد.', 422, {
        state: 'pending',
      });
    }
    return { data: await this.signup.verify(body) };
  }

  @Public()
  @Post('signup/resend')
  @HttpCode(200)
  @RateLimit({ name: 'signup-verify', limit: env.RATE_LIMIT_LOGIN_PER_MINUTE, windowMs: 60_000 })
  @ApiOperation({ summary: 'إرسال رمزٍ جديد (مهلة دقيقة، وسقف خمس إرسالات)' })
  @ApiResponse({ status: 429, description: 'قبل انقضاء المهلة أو بعد استهلاك السقف' })
  async resend(
    @Body(new ZodValidationPipe(signupResendRequestSchema)) body: SignupResendRequest,
  ) {
    return { data: await this.signup.resend(body) };
  }

  @Public()
  @Get('signup/status/:email')
  @RateLimit({ name: 'signup', limit: env.RATE_LIMIT_DEFAULT_PER_MINUTE, windowMs: 60_000 })
  @ApiOperation({
    summary: 'حالة التسجيل ومهامّ الإعداد المتبقية',
    description:
      'يُطلب مع `?token=` — وهو ما يجعل الجواب عن عنوانٍ مجهول وعن رمزٍ خاطئ واحداً (404)، ' +
      'فلا يتحوّل المسار العام إلى أداة سردِ عناوين.',
  })
  @ApiResponse({ status: 200, description: 'الحالة + مهامّ الإعداد المقيسة من القاعدة' })
  @ApiResponse({ status: 404, description: 'تسجيلٌ غير موجود أو رمزٌ لا يخصّ هذا البريد' })
  async status(@Param('email') email: string, @Query('token') token = '') {
    return { data: await this.signup.status(email, token) };
  }
}
