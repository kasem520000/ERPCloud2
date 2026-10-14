/* global RequestInit */

/**
 * API client for the admin console.
 *
 * Two things were wrong before and are fixed here:
 *
 *  1. The base URL defaulted to `http://localhost:3000/api/v1`. That is the *server's*
 *     address, not the browser's — the panel broke the moment it was opened from any
 *     other machine. The default is now the same origin (`/api/v1`), which
 *     `next.config.mjs` rewrites to the API. Set NEXT_PUBLIC_API_BASE_URL only for a
 *     split deployment.
 *  2. Nothing carried an access token or refreshed it. Every call now attaches the
 *     session token and transparently retries once after a refresh on 401.
 */

const configuredBase = (process.env.NEXT_PUBLIC_API_BASE_URL ?? '').trim().replace(/\/+$/, '');
export const apiBaseUrl = configuredBase.length > 0 ? configuredBase : '/api/v1';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: string;

  constructor(status: number, code: string, message: string, detail?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }

  get isAuthError(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }
}

// --------------------------------------------------------------------------- session

const ACCESS_KEY = 'erp.admin.access';
const REFRESH_KEY = 'erp.admin.refresh';
const TENANT_KEY = 'erp.admin.tenant';
/**
 * P-C8 — رمز الدخول المؤقّت الذي يسلّمه مكتب الدعم في اللوحة. يُحفظ وحده، ويُقرأ على أنه
 * «جلسة نظر»: **لا رمز تحديث معه** (لا يُجدَّد)، ويُرفض من الخادم فور إنهاء المشغّل للجلسة.
 */
const SUPPORT_KEY = 'erp.admin.imp';

export type StoredSession = {
  accessToken: string;
  refreshToken: string;
  tenantCode: string;
  expiresAt: number;
  /** جلسةُ دعمٍ بعين العميل — بلا تجديد وبلا رمزٍ ثانٍ. */
  impersonation?: boolean;
};

let memory: StoredSession | undefined;
const listeners = new Set<() => void>();

function browser(): boolean {
  return typeof window !== 'undefined';
}

export function readSession(): StoredSession | undefined {
  if (memory) return memory;
  if (!browser()) return undefined;
  try {
    const support = localStorage.getItem(SUPPORT_KEY);
    if (support) {
      memory = { accessToken: support, refreshToken: '', tenantCode: '', expiresAt: 0, impersonation: true };
      return memory;
    }
    const accessToken = localStorage.getItem(ACCESS_KEY);
    const refreshToken = localStorage.getItem(REFRESH_KEY);
    const tenantCode = localStorage.getItem(TENANT_KEY);
    if (!accessToken || !refreshToken || !tenantCode) return undefined;
    memory = { accessToken, refreshToken, tenantCode, expiresAt: 0 };
    return memory;
  } catch {
    return undefined;
  }
}

export function writeSession(session: StoredSession | undefined): void {
  memory = session;
  if (!browser()) return;
  try {
    if (!session) {
      localStorage.removeItem(ACCESS_KEY);
      localStorage.removeItem(REFRESH_KEY);
      localStorage.removeItem(TENANT_KEY);
      localStorage.removeItem(SUPPORT_KEY);
    } else {
      // تسجيل الدخول العادي يُنهي «جلسة النظر»: هويةُ المستخدم لا تجتمع مع رمز الدعم.
      localStorage.removeItem(SUPPORT_KEY);
      localStorage.setItem(ACCESS_KEY, session.accessToken);
      localStorage.setItem(REFRESH_KEY, session.refreshToken);
      localStorage.setItem(TENANT_KEY, session.tenantCode);
    }
  } catch {
    /* private mode — the in-memory copy still works for this tab */
  }
  for (const listener of listeners) listener();
}

export function onSessionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------------------------------------------------- P-C8: الدخول المؤقّت

/**
 * يستقبل الرمز الذي يسلّمه مكتب الدعم. يصل في **جزء العنوان** (`#support=…`) لا في
 * الاستعلام: الجزء لا يُرسل إلى أي خادم ولا يُكتب في سجلّات الوسيط، والرمز نفسه قصير العمر
 * (≤60 دقيقة) ومقيَّد بحارس الخادم.
 */
export function adoptSupportToken(token: string): void {
  if (!browser() || token.length === 0) return;
  try {
    localStorage.setItem(SUPPORT_KEY, token);
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(TENANT_KEY);
  } catch {
    /* private mode — الرمز في الذاكرة يكفي لهذه الجلسة */
  }
  memory = { accessToken: token, refreshToken: '', tenantCode: '', expiresAt: 0, impersonation: true };
  for (const listener of listeners) listener();
}

/** يقرأ `#support=<token>` ويُنظّف العنوان بعد قراءته. */
export function consumeSupportFragment(): boolean {
  if (!browser()) return false;
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const token = params.get('support');
  if (!token) return false;
  adoptSupportToken(token);
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  return true;
}

/** يخرج من «جلسة النظر» محلياً. الجلسة نفسها تُنهى من اللوحة (أو تنتهي بوقتها). */
export function leaveSupportSession(): void {
  if (browser()) {
    try {
      localStorage.removeItem(SUPPORT_KEY);
    } catch {
      /* ignore */
    }
  }
  memory = undefined;
  for (const listener of listeners) listener();
}

// --------------------------------------------------------------------------- fetching

type Problem = { title?: string; detail?: string; code?: string; message?: string };

async function toError(response: Response): Promise<ApiError> {
  let problem: Problem = {};
  const text = await response.text();
  if (text.length > 0) {
    try {
      problem = JSON.parse(text) as Problem;
    } catch {
      problem = { detail: text.slice(0, 400) };
    }
  }
  const code =
    problem.code ??
    (response.status === 401 ? 'UNAUTHENTICATED' : response.status === 403 ? 'FORBIDDEN' : 'HTTP_ERROR');
  const message =
    problem.title ?? problem.message ?? problem.detail ?? `${response.status} ${response.statusText}`;
  return new ApiError(response.status, code, message, problem.detail);
}

let refreshInFlight: Promise<StoredSession | undefined> | undefined;

async function refreshSession(): Promise<StoredSession | undefined> {
  const current = readSession();
  if (!current) return undefined;
  // رمز الدعم لا يُجدَّد: انتهاؤه أو إنهاؤه يعني أن الباب أُغلق، والتجديد يُبقيه مفتوحاً.
  if (current.impersonation) {
    writeSession(undefined);
    return undefined;
  }
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const response = await fetch(`${apiBaseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
      if (!response.ok) {
        writeSession(undefined);
        return undefined;
      }
      const payload = (await response.json()) as {
        data: { accessToken: string; refreshToken: string; expiresIn: number };
      };
      const next: StoredSession = {
        accessToken: payload.data.accessToken,
        refreshToken: payload.data.refreshToken,
        tenantCode: current.tenantCode,
        expiresAt: Date.now() + payload.data.expiresIn * 1000,
      };
      writeSession(next);
      return next;
    } catch {
      return undefined;
    } finally {
      refreshInFlight = undefined;
    }
  })();

  return refreshInFlight;
}

export type ApiOptions = RequestInit & {
  /** Skip the bearer token (public endpoints such as /billing/plans). */
  anonymous?: boolean;
  branchId?: string;
  idempotencyKey?: string;
};

/** Authenticated fetch that leaves the body unread so a caller can stream SSE. */
export async function apiOpen(path: string, init: RequestInit = {}): Promise<Response> {
  const session = readSession();
  const call = async (token?: string): Promise<Response> => {
    const headers = new Headers(init.headers ?? {});
    if (!headers.has('content-type') && init.body !== undefined) headers.set('content-type', 'application/json');
    if (token) headers.set('authorization', `Bearer ${token}`);
    return fetch(`${apiBaseUrl}${path}`, { ...init, headers });
  };
  let response = await call(session?.accessToken);
  if (response.status === 401 && session && !session.impersonation) {
    const refreshed = await refreshSession();
    if (refreshed) response = await call(refreshed.accessToken);
  }
  return response;
}

export async function apiFetch<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const { anonymous, branchId, idempotencyKey, ...init } = options;

  const call = async (token?: string): Promise<Response> => {
    const headers = new Headers(init.headers ?? {});
    if (!headers.has('content-type') && init.body !== undefined)
      headers.set('content-type', 'application/json');
    headers.set('accept', 'application/json');
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (branchId) headers.set('x-branch-id', branchId);
    if (idempotencyKey) headers.set('idempotency-key', idempotencyKey);
    return fetch(`${apiBaseUrl}${path}`, { ...init, headers });
  };

  const session = anonymous ? undefined : readSession();
  let response = await call(session?.accessToken);

  if (response.status === 401 && !anonymous && session) {
    const refreshed = await refreshSession();
    if (refreshed) response = await call(refreshed.accessToken);
  }

  if (!response.ok) throw await toError(response);
  if (response.status === 204) return undefined as T;

  const text = await response.text();
  return (text.length > 0 ? JSON.parse(text) : undefined) as T;
}

/**
 * The API is not uniform: some controllers wrap their result in `{ data: … }` and some
 * return the raw row or array. Unwrapping defensively keeps every screen working with
 * one client instead of each page knowing which convention its endpoint follows.
 */
function unwrap<T>(payload: unknown): T {
  if (
    payload !== null &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    'data' in (payload as Record<string, unknown>)
  ) {
    const record = payload as Record<string, unknown>;
    const inner = record.data;
    if (inner !== null && typeof inner === 'object') {
      const target = inner as Record<string, unknown>;
      if (!('data' in target)) {
        Object.defineProperty(target, 'data', {
          value: inner,
          enumerable: false,
          configurable: true,
          writable: true,
        });
      }
      for (const [key, value] of Object.entries(record)) {
        if (key === 'data' || key in target) continue;
        Object.defineProperty(target, key, {
          value,
          enumerable: false,
          configurable: true,
          writable: true,
        });
      }
    }
    return inner as T;
  }
  return payload as T;
}

export async function apiData<T>(path: string, options: ApiOptions = {}): Promise<T> {
  return unwrap<T>(await apiFetch<unknown>(path, options));
}

/** Always resolves to an array, even when the endpoint answers with an object. */
export async function apiList<T>(path: string, options: ApiOptions = {}): Promise<T[]> {
  const payload = unwrap<unknown>(await apiFetch<unknown>(path, options));
  if (Array.isArray(payload)) return payload as T[];
  if (
    payload !== null &&
    typeof payload === 'object' &&
    Array.isArray((payload as { items?: unknown }).items)
  ) {
    return (payload as { items: T[] }).items;
  }
  return [];
}

export function apiPost<T>(path: string, body: unknown, options: ApiOptions = {}): Promise<T> {
  return apiData<T>(path, { ...options, method: 'POST', body: JSON.stringify(body) });
}

export function apiPatch<T>(path: string, body: unknown, options: ApiOptions = {}): Promise<T> {
  return apiData<T>(path, { ...options, method: 'PATCH', body: JSON.stringify(body) });
}

export function apiPut<T>(path: string, body: unknown, options: ApiOptions = {}): Promise<T> {
  return apiData<T>(path, { ...options, method: 'PUT', body: JSON.stringify(body) });
}

export function apiDelete<T>(path: string, options: ApiOptions = {}): Promise<T> {
  return apiData<T>(path, { ...options, method: 'DELETE' });
}

// --------------------------------------------------------------------------- auth

export type LoginPayload = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: {
    id: string;
    email: string;
    fullName: string;
    isPlatformAdmin: boolean;
    platformRoles: string[];
    mustChangePassword: boolean;
  };
  memberships: Array<{
    id: string;
    tenantId: string;
    tenantCode: string;
    tenantName: string;
    isOwner: boolean;
    status: string;
  }>;
};

export async function login(
  email: string,
  password: string,
  tenantCode: string,
  mfaCode?: string,
): Promise<LoginPayload> {
  const data = await apiData<LoginPayload>('/auth/login', {
    anonymous: true,
    method: 'POST',
    body: JSON.stringify({ email, password, tenantCode, ...(mfaCode ? { mfaCode } : {}) }),
  });
  writeSession({
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    tenantCode,
    expiresAt: Date.now() + data.expiresIn * 1000,
  });
  return data;
}

export async function logout(): Promise<void> {
  try {
    await apiFetch('/auth/logout', { method: 'POST', body: JSON.stringify({}) });
  } catch {
    /* the local session is dropped either way */
  }
  writeSession(undefined);
}

export type MePayload = {
  user: {
    id: string;
    email: string;
    fullName: string;
    isPlatformAdmin: boolean;
    platformRoles: string[];
    mustChangePassword: boolean;
  };
  membership: {
    id: string;
    tenantId: string;
    tenantCode: string;
    tenantName: string;
    displayName: string;
    isOwner: boolean;
    /** R1 — حدّ الخصم على العضوية (`null` = بلا حدّ). تقرأه شاشة الكاشير لتُظهره. */
    maxDiscountPct?: string | null;
    maxDiscountAmount?: string | null;
  };
  permissions: string[];
  branchScope: string[] | null;
  /** P-C8 — يُملأ حين يكون الرمز رمزَ دخولٍ مؤقّت: من دخل، ولماذا، وإلى متى. */
  impersonation?: {
    sessionId: string;
    operatorUserId: string;
    operatorLabel: string | null;
    reason: string;
    startedAt: string;
    expiresAt: string;
  } | null;
};

export function fetchMe(): Promise<MePayload> {
  return apiData<MePayload>('/me');
}
