import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Request } from 'express';
import {
  DomainError,
  errorCodes,
  impersonationBlockedPaths,
  impersonationBlocksDeletes,
} from '@erp/contracts';
import { withPlatformAdminTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.tokens.js';
import { tryGetAuthContext } from '../../request-context/request-context.js';

/**
 * P-C8 — فرض حدود الدخول المؤقّت **على الـAPI لا على الشاشة**.
 *
 * الرمز الذي يحمل `imp` رمزٌ يقرأ ويكتب في العمل اليومي باسم العميل، لكنه **ليس هوية
 * العميل**: يُمنع به كل `DELETE`، ويُمنع به كل مسار `/auth/` غير القراءة، ولا يعمل بعد أن
 * تُنهى جلسته أو تنتهي مدّتها — يُقرأ الصفّ في القاعدة في كل طلب، فلا انتظارَ لانتهاء
 * صلاحية الرمز.
 *
 * يُركَّب عالمياً مع `AuthGuard` على وحدات المنصة والوحدات التي تخدم الدخول المؤقّت؛
 * وترتيبُه **بعد** `AuthGuard` لأنه يقرأ سياق الطلب الذي ينشره ذلك الحارس.
 */
@Injectable()
export class ImpersonationGuard implements CanActivate {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // **بلا سياق = مسارٌ عام** (`@Public`، مثل `POST /auth/login`): لا رمزَ ولا جلسة،
    // ولا شيء يمنعه. الحارس لا يُشترط أن يسبقه `AuthGuard` على كل مسار، فيسأل سؤالاً
    // واحداً: هل هذا الطلب يحمل `imp`؟ وإن لم يكن هناك سياق أصلاً فالجواب: لا.
    const auth = tryGetAuthContext();
    if (!auth?.impersonationId) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const method = request.method.toUpperCase();

    if (impersonationBlocksDeletes && method === 'DELETE') {
      throw new DomainError(
        errorCodes.FORBIDDEN,
        'الدخول المؤقّت لا يحذف: أنشئ التغيير أو اطلبه من العميل بدل محو سجلّه',
        403,
        { reason: 'IMPERSONATION_NO_DELETE' },
      );
    }

    // المسارات في العقد مكتوبةٌ كما تُعلَن (`/auth/change-password`)، والطلب يصل موسوماً
    // ببادئة النسخة (`/api/v1/auth/change-password`). تُقرأ الثلاثة معاً — مسارُ الطلب
    // ومسارُ القاعدة (`route.path` بلا بادئة) والمسار بعد تجريد البادئة — فلا يفلت مسارٌ
    // بسبب شكل البادئة.
    const path = request.path || request.url.split('?')[0] || '';
    const declared = (request.route as { path?: string } | undefined)?.path ?? '';
    const stripped = path.replace(/^\/api(\/v\d+)?/, '');
    const candidates = [path, declared, stripped].filter((entry) => entry.length > 0);
    const blocked = impersonationBlockedPaths.find((prefix) =>
      candidates.some((candidate) => candidate.startsWith(prefix)),
    );
    if (blocked && method !== 'GET') {
      throw new DomainError(
        errorCodes.FORBIDDEN,
        'الدخول المؤقّت لا يمسّ المصادقة: لا تغيير كلمة مرور ولا رمز جديد باسم العميل',
        403,
        { reason: 'IMPERSONATION_AUTH_BLOCKED', path: blocked },
      );
    }

    // الصفّ الوحيد الذي يهم: جلسةٌ مفتوحة ولم تنتهِ بعد. وقراءةٌ بمفتاحٍ أساسي — لا تُدفع
    // إلا على طلبٍ يحمل `imp`، فلا كلفة على المسار العادي.
    //
    // **وبمعاملة المنصة**: `support_sessions` عليها عزلٌ مفروض (FORCE RLS)، فقراءةٌ بلا
    // سياقٍ لا ترى صفّاً — ولو كانت الجلسة مفتوحة. ولذلك يُقرأ بصيغة المنصة الصريحة، كما
    // يقرأ المشغّل نفسه.
    const active = await withPlatformAdminTx(this.database.db, (tx) =>
      tx.execute(sql`
        SELECT 1 AS ok FROM support_sessions
         WHERE id = ${auth.impersonationId} AND ended_at IS NULL AND expires_at > now()
         LIMIT 1
      `),
    );
    if (active.rows.length === 0) {
      throw new DomainError(
        errorCodes.UNAUTHENTICATED,
        'انتهت جلسة الدخول المؤقّت أو أُنهيت — الرمز لم يبقَ صالحاً',
        401,
        { reason: 'IMPERSONATION_ENDED' },
      );
    }
    return true;
  }
}
