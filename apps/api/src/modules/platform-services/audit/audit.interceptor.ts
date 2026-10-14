import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { tap, type Observable } from 'rxjs';
import { auditActions } from '@erp/contracts';

import { getRequestContext, isRequestAudited } from '../../../request-context/request-context.js';

import { AuditService } from './audit.service.js';

/**
 * Audit interceptor — SECURITY_ARCHITECTURE §10: "Mutating endpoint ⇒ audit_log row
 * (entity diff, actor, ip, ua, trace)".
 *
 * Design decisions worth knowing before extending it:
 *
 * - **Only mutating verbs.** `GET`/`HEAD`/`OPTIONS` never produce a row; read access to
 *   sensitive data is a logging concern, not an audit-trail concern.
 * - **`before` is never guessed.** A generic interceptor cannot know the prior state of
 *   an arbitrary resource, so it records `after` only. A service that *can* produce a
 *   real diff calls `AuditService.recordInTx()` and marks the request audited
 *   (`markRequestAudited()`), which suppresses this interceptor's row — one event, one
 *   row, with the better payload winning.
 * - **Auth endpoints are on a skip list** (PHASE_04 §5.2) — their bodies carry
 *   credentials. They are audited as explicit CRITICAL events with no body captured, and
 *   uniquely, also on failure: a rejected login is exactly what a reviewer looks for.
 * - Writing the row never blocks or breaks the response (`AuditService.record` swallows
 *   and logs its own failures).
 */

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Endpoints whose request body must never be captured, mapped to a CRITICAL action. */
const AUTH_AUDIT_ACTIONS: Record<string, string> = {
  'POST auth/login': auditActions.LOGIN,
  'POST supplier-portal/auth': auditActions.LOGIN,
  'POST auth/refresh': auditActions.REFRESH,
  'POST auth/logout': auditActions.LOGOUT,
  'POST auth/change-password': auditActions.PASSWORD_CHANGE,
};

/** Never audited: health probes and the audit log's own (read-only) surface. */
const IGNORED_RESOURCES = new Set(['health', 'audit-log']);

/**
 * **P-M8 — `POST` that is a read.** `POST /public/verify` يستقبل حِمل رمز فاتورة في الجسم
 * لا في الرابط (الرابط يُسجَّل في `Referer` وفي سجلّات الوسائط)، وهو مع ذلك **قراءةٌ محضة**:
 * لا صفَّ يُكتب ولا حالةً تتغيّر. وتدقيقه يكتب عكس المطلوب: `after` يحمل الحِمل الملصوق،
 * أي **بيانات فاتورة زائرٍ مجهول تُحفظ في سجلّ التدقيق** — والوعد المكتوب على الصفحة أن ما
 * يُلصق لا يُحفظ. فالمسار مستثنى هنا، في المكان الذي تُقرأ فيه القاعدة، لا في الخدمة.
 *
 * والاستثناء بالاسم الكامل (`METHOD resource/entity`) لا بالمصدر: مسارٌ عامٌّ آخر لا يُعفى
 * لأنه جاء من الوحدة نفسها.
 */
const READ_ONLY_POSTS = new Set(['POST public/verify']);

/**
 * **P-M9 — فعلٌ عامّ لا يُنسب إلى فاعل.** `POST public/help/:slug/feedback` هو الكتابة
 * العامة الوحيدة في الموقع التسويقي: زائرٌ مجهول يقول «أفادني هذا» أو «لم يفدني».
 *
 * **ولماذا لا يُدقَّق وهو فعلٌ لا قراءة؟** لأن صفّ التدقيق في هذا المستودع يحمل **عنوان
 * الزائر ووسيط متصفّحه** (`meta.ip` · `meta.userAgent`) بجانب الفعل — أي أن تدقيق صوتٍ
 * مجهول يحوّل «رأيٌ مجموع» إلى «ملفٍّ عن قارئ» مقابل فائدةٍ صفر: لا فاعلَ يُسأل، ولا قرارَ
 * تشغيليّ يُبنى على الصف. والمكتوب الفعلي (الحكم وصاحبه المجهول) محفوظٌ في `content_feedback`
 * للعدّ، والصفحة تقول للزائر عن حقّ: لا يُحفظ ما لصقت. فالمسار مستثنى **بالاسم الكامل**
 * (`METHOD resource/entity`) كي لا يُعفى مسارٌ عامٌّ آخر جاء من الوحدة نفسها.
 *
 * **وP-M10 أضاف الثاني: `POST public/events`** (أحداث الموقع). والسبب هو السبب نفسه بحرفيّته:
 * الحدث مجهولُ الهوية في جدوله (لا عمود لعنوانٍ ولا وسيط)، وتدقيقه كان سيحفظ في `audit_log`
 * ما رفضنا حفظه في مكانه — **وهو أسوأ من عدم القياس**: القيد في الجدول يصير كذبةً يُكذّبها
 * صفُّ التدقيق المجاور.
 */
const ANONYMOUS_POSTS = new Set(['POST public/help', 'POST public/events']);

export type RouteDescriptor = {
  resource: string;
  entityId: string | null;
  subResource: string | null;
};

/**
 * `/api/v1/roles/{id}/permissions` → `{ resource: 'roles', entityId: '{id}',
 * subResource: 'permissions' }`. The version prefix is stripped so the audit trail is
 * stable across API versions.
 */
export function describeRoute(rawPath: string): RouteDescriptor {
  const path = rawPath.split('?')[0] ?? '';
  const segments = path
    .replace(/^\/+/, '')
    .split('/')
    .filter((segment) => segment.length > 0);

  if (segments[0] === 'api') segments.shift();
  if (segments[0]?.match(/^v\d+$/)) segments.shift();

  return {
    resource: segments[0] ?? 'unknown',
    entityId: segments[1] ?? null,
    subResource: segments[2] ?? null,
  };
}

export function actionForMethod(method: string, route: RouteDescriptor): string {
  const base =
    method === 'POST'
      ? route.entityId
        ? auditActions.UPDATE
        : auditActions.CREATE
      : method === 'DELETE'
        ? auditActions.DELETE
        : auditActions.UPDATE;
  return route.subResource ? `${base}.${route.subResource}` : base;
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const method = request.method.toUpperCase();
    if (!MUTATING_METHODS.has(method)) return next.handle();

    const route = describeRoute(request.originalUrl ?? request.url ?? '');
    if (IGNORED_RESOURCES.has(route.resource)) return next.handle();
    if (READ_ONLY_POSTS.has(`${method} ${route.resource}/${route.entityId ?? ''}`)) return next.handle();
    if (ANONYMOUS_POSTS.has(`${method} ${route.resource}/${route.entityId ?? ''}`)) return next.handle();

    // The public sign path carries the secret in the URL and the one-time code in the body.
    // `esign_events` is the trail; the audit row would keep both.
    if (route.resource === 'esign' && route.subResource === 'sign') return next.handle();

    const authAction = AUTH_AUDIT_ACTIONS[`${method} ${route.resource}/${route.entityId ?? ''}`];

    return next.handle().pipe(
      tap({
        next: (body) => {
          void this.onSettled(method, route, authAction, response.statusCode, body, undefined);
        },
        error: (error: unknown) => {
          // Only auth events are audited on failure; everything else would turn a
          // validation typo into audit-log noise.
          if (authAction) {
            void this.onSettled(method, route, authAction, statusOf(error), undefined, error);
          }
        },
      }),
    );
  }

  private async onSettled(
    method: string,
    route: RouteDescriptor,
    authAction: string | undefined,
    status: number,
    body: unknown,
    error: unknown,
  ): Promise<void> {
    // A service already wrote a richer row for this request (with a real `before`).
    if (isRequestAudited()) return;

    const context = getRequestContext();
    const meta: Record<string, unknown> = {
      method,
      path: `${route.resource}${route.entityId ? `/${route.entityId}` : ''}${
        route.subResource ? `/${route.subResource}` : ''
      }`,
      status,
      traceId: context.traceId,
      ip: context.clientIp ?? null,
      userAgent: context.userAgent ?? null,
    };
    if (error) {
      meta.outcome = 'failure';
      meta.errorCode = codeOf(error);
    }

    if (authAction) {
      const identity = identityFromAuthResponse(body);
      await this.audit.record({
        // AUD-14 — مسارٌ عامّ (webhook) يستخرج المستأجر من سرّه قبل الكتابة؛
        // `auditTenantId` هو ما يُعلنه لذلك، فيُنسب السجلّ لصاحبه لا لـnull.
        tenantId: context.tenant?.tenantId ?? context.auditTenantId ?? identity.tenantId ?? null,
        actorUserId: context.auth?.userId ?? identity.userId ?? null,
        actorLabel: identity.label ?? null,
        membershipId: context.auth?.membershipId ?? null,
        action: authAction,
        entity: 'auth',
        entityId: context.auth?.userId ?? identity.userId ?? null,
        meta,
      });
      return;
    }

    // A mutation that did not succeed changed nothing; there is nothing to audit.
    if (status >= 400) return;

    const after = extractData(body);
    await this.audit.record({
      tenantId: context.tenant?.tenantId ?? context.auditTenantId ?? null,
      actorUserId: context.auth?.userId ?? null,
      membershipId: context.auth?.membershipId ?? null,
      action: actionForMethod(method, route),
      entity: route.resource,
      entityId: route.entityId ?? idOf(after),
      after: after ?? null,
      meta,
    });
  }
}

function extractData(body: unknown): unknown {
  if (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)) {
    return (body as { data: unknown }).data;
  }
  return body ?? null;
}

function idOf(data: unknown): string | null {
  if (data && typeof data === 'object' && 'id' in (data as Record<string, unknown>)) {
    const id = (data as { id: unknown }).id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}

/**
 * Login and refresh run *before* any guard has published a context, so the only place
 * the actor can be recovered from is the response envelope. Tokens are never touched.
 */
function identityFromAuthResponse(body: unknown): {
  userId: string | null;
  tenantId: string | null;
  label: string | null;
} {
  const data = extractData(body);
  if (!data || typeof data !== 'object') return { userId: null, tenantId: null, label: null };

  const user = (data as { user?: { id?: unknown; email?: unknown; fullName?: unknown } }).user;
  const memberships = (data as { memberships?: Array<{ tenantId?: unknown }> }).memberships;

  return {
    userId: typeof user?.id === 'string' ? user.id : null,
    tenantId: typeof memberships?.[0]?.tenantId === 'string' ? memberships[0].tenantId : null,
    label: typeof user?.email === 'string' ? user.email : null,
  };
}

function statusOf(error: unknown): number {
  const status = (error as { status?: unknown })?.status;
  return typeof status === 'number' ? status : 500;
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' ? code : 'INTERNAL';
}
