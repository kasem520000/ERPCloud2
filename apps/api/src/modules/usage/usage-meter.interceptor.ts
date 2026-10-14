import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { from, type Observable } from 'rxjs';
import { switchMap } from 'rxjs/operators';

import { tryGetTenantContext } from '../platform/context/tenant-context.js';

import { UsageService } from './usage.service.js';

/**
 * P-C5 — عدّاد استدعاءات الـAPI اليومي.
 *
 * يقيس **الطلبات المسنَدة إلى منشأة** فقط: طلبات اللوحة (مشغّل بلا منشأة)، وتسجيل الدخول
 * (لا سياق منشأة بعد)، والمسارات العامة لا تُحتسب على عميل. والقياس يقع **قبل** تنفيذ
 * الطالب:
 *
 *   1. فالعدّاد يُقرأ بعد الطلب مباشرةً بلا انتظار كتابةٍ متأخّرة (تحقّقٌ حيّ لا يخبط)؛
 *   2. والرفض عند الحدّ يقع قبل أن يلمس الطالب أي جدول — لا كتابة نصفِ عملٍ ثم رفض.
 *
 * والعدّاد يُزاد ثم يُفحص (`recordApiCall`) فلا يفلت طلبان متوازيان عند الحدّ.
 */
@Injectable()
export class UsageMeterInterceptor implements NestInterceptor {
  constructor(private readonly usage: UsageService) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const tenant = tryGetTenantContext();
    if (!tenant?.tenantId) return next.handle();
    const tenantId = tenant.tenantId;
    // `meterApiCall` لا ترمي إلا عند حدٍّ مطبَّق بلغه العميل (409 USAGE_LIMIT_REACHED).
    return from(this.usage.meterApiCall(tenantId)).pipe(switchMap(() => next.handle()));
  }
}
