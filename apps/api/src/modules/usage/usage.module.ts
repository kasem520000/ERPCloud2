import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { UsageController } from './usage.controller.js';
import { UsageMeterInterceptor } from './usage-meter.interceptor.js';
import { UsageService } from './usage.service.js';

/**
 * P-C5 — وحدة الاستخدام: المحرّك (`UsageService`) وسطح العميل (`GET /usage`) وعدّاد
 * الطلبات (اعتراضٌ عام).
 *
 * **عالمية عمداً** (`@Global`): القياس والحصص عرضٌ مستعرضٌ لكل الوحدات — الفروع والأصناف
 * والفاتورات والعضويات والملفات وواتساب كلّها تسأل «أيقع هذا الطلب داخل الحدّ؟» — فاستيراد
 * الوحدة في ستّ وحدات أخرى كان سيبني حافةً لا تُقرأ (`PlatformServicesModule` نفسه عالميّ
 * للسبب ذاته). الوحدة **تصدّر** `UsageService` وحده: حرّاس الكتابة في `branches` و`sales` و`catalog` و
 * `memberships` و`files` و`whatsapp` يستدعونه قبل الإنشاء، فيبقى قرار الحدّ في مكانٍ واحد.
 * والاعتراض مسجَّل من هنا بـ`APP_INTERCEPTOR` — رغم إمكان تسجيله في `AppModule` — لأن
 * العدّاد ومحرّكه شيءٌ واحد، فمن قرأ الوحدة عرف أن كل طلبٍ مسنَدٍ إلى منشأة يُحتسب.
 */
@Global()
@Module({
  controllers: [UsageController],
  providers: [UsageService, { provide: APP_INTERCEPTOR, useClass: UsageMeterInterceptor }],
  exports: [UsageService],
})
export class UsageModule {}
