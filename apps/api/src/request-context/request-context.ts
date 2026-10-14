import { AsyncLocalStorage } from 'node:async_hooks';

import { DomainError, errorCodes } from '@erp/contracts';

/**
 * Per-request context propagated with `AsyncLocalStorage` (API_ARCHITECTURE §2 first
 * pipeline stage, PROJECT_CONTRACT §10 `traceId` propagation).
 *
 * The store object is created once by `RequestIdMiddleware` and then *mutated* by the
 * guards further down the pipeline, which is why `AuthGuard`/`TenantGuard` can publish
 * their results without owning the ALS scope themselves.
 */

export type AuthContextValue = {
  /** `sub` — user id. */
  userId: string;
  /** `tid` — tenant id claimed by the token (verified by TenantGuard). */
  claimedTenantId: string;
  /** `mid` — membership id. */
  membershipId: string;
  /** `scope` — token scopes. */
  scope: string[];
  /** `jti` — token id, used for logout. */
  tokenId: string;
  /**
   * Effective platform access: the legacy `users.is_platform_admin` flag OR any
   * `platform_memberships` row (2026-09: the flag is deprecated, kept for compat).
   */
  isPlatformAdmin: boolean;
  /** Platform role codes carried by the token (`proles` claim, may be stale ≤ TTL). */
  platformRoles: string[];
  /**
   * P-C8 — معرّف جلسة الدعم إن كان الرمز رمزَ دخولٍ مؤقّت (`imp` claim). الحارس يستعمله
   * ليرفض ما لا يُفعل بعين العميل، والتدقيق ليسمّي من كان خلف الشاشة فعلاً.
   */
  impersonationId?: string;
};

export type MembershipKind = 'staff' | 'portal';

export type RoleScopeValue = {
  roleId: string;
  scopeType: 'branch' | 'warehouse' | 'cash_location' | 'pos_terminal';
  scopeId: string;
};

export type TenantContextValue = {
  tenantId: string;
  tenantCode: string;
  tenantStatus: string;
  membershipId: string;
  userId: string;
  /** Active role ids held by the membership (optional in unit test stubs). */
  roleIds?: string[];
  /** Effective permission set = UNION(roles) (DATABASE_DESIGN §2). `*` = owner. */
  permissions: string[];
  /** NULL = all branches (MULTI_TENANCY §2). */
  branchScope: string[] | null;
  isOwner: boolean;
  /**
   * Audience of the membership (2026-09). `portal` memberships belong to external
   * customers and are denied on every `@RequiresPermission` route.
   */
  kind: MembershipKind;
  /** Per-role scope restrictions from `membership_role_scopes` (empty = tenant-wide). */
  scopes: RoleScopeValue[];
  /**
   * R1 — حدّ الخصم على العضوية (بديل `OperMaxDiscount` في الديسكتوب). `null` = بلا حدّ.
   * يُحمَّل مع العضوية في `TenantGuard` فلا يُقرأ من القاعدة عند كل فاتورة، ويُفحص في
   * `assertDiscountWithinLimit` عند كتابة أي خصم.
   */
  maxDiscountPct: string | null;
  maxDiscountAmount: string | null;
};

/**
 * سياق «النظام» — عملٌ خلفيّ لا إنسان خلفه (نبضة مجدول، ومعالج طابور).
 *
 * بعض الخدمات تشترط سياق مصادقة لأنها تُنادى من شاشة (قراءة الإيراد مثلاً)، والمهمّة
 * الخلفية لا طلبَ لها. ولا يُرتجل لها مستخدمٌ ولا جلسة: `system` وسمٌ صريح يقول «هذا ليس
 * طلباً»، وما يُبنى عليه قرارٌ أمنيّ واحد مُعلَن — `mustBePlatformAdmin` تقبله، لأن الذي
 * يقود المهمّة هو المنصّة نفسها. ولا مسار HTTP يضعه: `runAsSystem` وحدها تكتبه.
 */
export type SystemContextValue = {
  /** اسم المهمّة — يُكتب في `traceId` فيُقرأ في السجلّات من أين جاء النداء. */
  job: string;
};

export type RequestContextValue = {
  traceId: string;
  startTime: number;
  auth?: AuthContextValue;
  tenant?: TenantContextValue;
  /**
   * AUD-14 — مستأجرٌ استخرجه مسارٌ **عامّ** (webhook) من سرّه/توقيعه بعد أن بدأ الطلب
   * بلا سياق: يُنسب به سجل التدقيق الذي يكتبه `AuditInterceptor`، ولا يُستعمل سياقَ
   * مصادقة (لا صلاحيات ولا عضوية مُختلقة).
   */
  auditTenantId?: string;
  /** مضبوطٌ في المهامّ الخلفية وحدها — انظر `SystemContextValue`. */
  system?: SystemContextValue;
  /** Validated `X-Branch-Id` request scope. */
  branchId?: string;
  /** Client address, captured for `audit_log.meta` (SECURITY_ARCHITECTURE §10). */
  clientIp?: string;
  /** Truncated `User-Agent`, captured for `audit_log.meta`. */
  userAgent?: string;
  /**
   * Set by a service that has already written a richer `audit_log` row (with a real
   * `before`/`after` diff) for this request, so `AuditInterceptor` does not add a
   * second, poorer one.
   */
  audited?: boolean;
};

export const requestContextStorage = new AsyncLocalStorage<RequestContextValue>();

const FALLBACK: RequestContextValue = {
  traceId: 'local-request',
  startTime: 0,
};

export function getRequestContext(): RequestContextValue {
  return requestContextStorage.getStore() ?? FALLBACK;
}

/**
 * يشغّل عملاً خلفياً داخل سياق نظام — بلا جلسةٍ مصطنعة وبلا مستخدمٍ مُخترع.
 * والتدقيق يسمّي الفاعل `null` ← «النظام» (كما تفعل `content.publish` المجدولة).
 */
export function runAsSystem<T>(job: string, work: () => Promise<T>): Promise<T> {
  return requestContextStorage.run({ traceId: `job:${job}`, startTime: Date.now(), system: { job } }, work);
}

/** سياق النظام إن كنّا في مهمّةٍ خلفية — `undefined` في أيّ طلبٍ حقيقيّ. */
export function systemContext(): SystemContextValue | undefined {
  return getRequestContext().system;
}

export function getTraceId(): string {
  return getRequestContext().traceId;
}

export function tryGetAuthContext(): AuthContextValue | undefined {
  return getRequestContext().auth;
}

/** Throws `UNAUTHENTICATED` when AuthGuard did not run (a public route, or a wiring bug). */
export function getAuthContext(): AuthContextValue {
  const auth = getRequestContext().auth;
  if (!auth) {
    throw new DomainError(errorCodes.UNAUTHENTICATED, 'Authentication required', 401);
  }
  return auth;
}

/** Mutates the active store; safe to call from guards running inside the ALS scope. */
export function setAuthContext(value: AuthContextValue): void {
  const store = requestContextStorage.getStore();
  if (store) store.auth = value;
}

export function setTenantContextValue(value: TenantContextValue): void {
  const store = requestContextStorage.getStore();
  if (store) store.tenant = value;
}

/**
 * AUD-14 — يُعلن المستأجر الذي استخرجه webhook عامّ من توقيعه، فيُنسب إليه سجلّ
 * التدقيق. لا يمنح صلاحية ولا يُنشئ عضوية: `context.tenant` يبقى كما هو.
 */
export function setAuditTenantId(tenantId: string): void {
  const store = requestContextStorage.getStore();
  if (store) store.auditTenantId = tenantId;
}

export function getAuditTenantId(): string | undefined {
  return requestContextStorage.getStore()?.auditTenantId;
}

export function setBranchId(branchId: string): void {
  const store = requestContextStorage.getStore();
  if (store) store.branchId = branchId;
}

/** PHASE_04 — `audit_log.meta` provenance, published by `RequestIdMiddleware`. */
export function setClientMetadata(value: { clientIp?: string; userAgent?: string }): void {
  const store = requestContextStorage.getStore();
  if (!store) return;
  if (value.clientIp) store.clientIp = value.clientIp;
  if (value.userAgent) store.userAgent = value.userAgent;
}

/**
 * Marks the current request as already audited by a service that produced a real
 * before/after diff — `AuditInterceptor` then skips its generic row.
 */
export function markRequestAudited(): void {
  const store = requestContextStorage.getStore();
  if (store) store.audited = true;
}

export function isRequestAudited(): boolean {
  return getRequestContext().audited === true;
}
