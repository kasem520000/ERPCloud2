/* global RequestInit */

/**
 * Portal API client.
 *
 * The browser talks to the API through this app's own origin: `next.config.mjs` rewrites
 * `/api/v1/*` to the API service. That matters more than it looks — a client that pointed at
 * `http://localhost:3000` worked only on the developer's laptop and broke behind every proxy,
 * container and preview URL.
 */
const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || '/api/v1';

const TOKEN_COOKIE = 'erp_access_token';

export function readToken(): string | undefined {
  if (typeof globalThis.document === 'undefined') return undefined;
  const found = globalThis.document.cookie.split('; ').find((part) => part.startsWith(`${TOKEN_COOKIE}=`));
  return found ? decodeURIComponent(found.split('=')[1] ?? '') : undefined;
}

export function storeToken(token: string): void {
  globalThis.document.cookie = `${TOKEN_COOKIE}=${encodeURIComponent(token)}; path=/; SameSite=Lax`;
}

export function clearToken(): void {
  globalThis.document.cookie = `${TOKEN_COOKIE}=; path=/; Max-Age=0; SameSite=Lax`;
}

export class PortalError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'PortalError';
  }
}

const MESSAGES: Record<string, string> = {
  PORTAL_ACCESS_REQUIRED: 'هذا الحساب غير مرتبط ببوابة العملاء. راجع الجهة التي أصدرت الفواتير.',
  PORTAL_ACCESS_SUSPENDED: 'تم إيقاف وصولك إلى البوابة مؤقتاً. تواصل مع المورد.',
  NOT_FOUND: 'المستند غير موجود أو لا يخص حسابك.',
  RATE_LIMITED: 'محاولات كثيرة خلال وقت قصير. انتظر قليلاً ثم أعد المحاولة.',
};

export async function portalFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = readToken();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    const code = typeof payload.code === 'string' ? payload.code : undefined;
    // An expired or foreign token must land the visitor back on the login screen, not on a
    // page full of empty tables that look like "you have no invoices".
    if (response.status === 401 && typeof globalThis.location !== 'undefined') {
      clearToken();
      globalThis.location.assign('/login');
    }
    throw new PortalError(MESSAGES[code ?? ''] ?? (typeof payload.detail === 'string' ? payload.detail : 'تعذّر تنفيذ الطلب'), response.status, code);
  }
  return (payload.data !== undefined ? payload.data : payload) as T;
}

export type Session = { accessToken: string; refreshToken: string; mustChangePassword: boolean; fullName: string; email: string };

export async function login(input: { tenantCode: string; email: string; password: string }): Promise<Session> {
  const response = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  if (!response.ok) {
    const failure = (await response.json().catch(() => ({}))) as { code?: string };
    if (failure.code === 'MFA_REQUIRED') throw new PortalError('MFA_REQUIRED', response.status, 'MFA_REQUIRED');
    throw new PortalError(response.status === 401 ? 'بيانات الدخول غير صحيحة' : response.status === 429 ? 'محاولات كثيرة، انتظر قليلاً' : 'تعذّر تسجيل الدخول', response.status);
  }
  const body = (await response.json()) as { data?: Record<string, unknown> } & Record<string, unknown>;
  const payload = (body.data ?? body) as { accessToken?: string; refreshToken?: string; user?: { mustChangePassword?: boolean; fullName?: string; email?: string } };
  if (!payload.accessToken) throw new PortalError('لم يصل رمز الدخول من الخادم', 500);
  storeToken(payload.accessToken);
  return { accessToken: payload.accessToken, refreshToken: payload.refreshToken ?? '', mustChangePassword: Boolean(payload.user?.mustChangePassword), fullName: payload.user?.fullName ?? '', email: payload.user?.email ?? input.email };
}

/** Changes the caller's own password; the API revokes every session afterwards. */
export async function changePassword(current: string, next: string): Promise<void> {
  await portalFetch<void>('/auth/change-password', { method: 'POST', body: JSON.stringify({ current, new: next }) });
  clearToken();
}

export function logout(): void {
  clearToken();
  globalThis.location.assign('/login');
}

// ---------------------------------------------------------------- portal resources

export type PortalParty = { id: string; code: string; name: string; taxNo: string | null; phone: string | null; email: string | null; creditLimit: string };
export type PortalCompany = { nameAr: string; nameEn: string; taxNo: string; email: string; phones: string[] };
export type PortalProfile = { party: PortalParty | null; company: PortalCompany; balance: string };

export type PortalInvoice = {
  id: string;
  number: string | null;
  kind: string;
  status: string;
  payment_status: string;
  currency: string;
  subtotal: string;
  tax_total: string;
  total: string;
  paid_total: string;
  posted_at: string | null;
  created_at: string;
  zatca_status: string | null;
};

export type PortalInvoiceLine = { line_no: number; name: string; unit: string | null; quantity: string; unit_price: string; discount_amount: string; net: string; tax: string; total: string };
export type PortalPayment = { id: string; number: string | null; day: string; kind: string; method: string; amount: string; status: string; notes: string | null };
export type StatementLine = { day: string; doc_type: string; number: string; description: string; debit: string; credit: string; running: string; document_id: string };

export const fetchProfile = () => portalFetch<PortalProfile>('/portal/me');
export const fetchInvoices = (range: { from?: string; to?: string } = {}) => {
  const query = new URLSearchParams(Object.entries(range).filter(([, value]) => value)).toString();
  return portalFetch<PortalInvoice[]>(`/portal/invoices${query ? `?${query}` : ''}`);
};
export const fetchInvoice = (id: string) => portalFetch<{ invoice: PortalInvoice; lines: PortalInvoiceLine[]; payments: Array<Record<string, string>> }>(`/portal/invoices/${id}`);
export const fetchInvoiceHtml = (id: string) => portalFetch<{ html: string }>(`/portal/invoices/${id}/print`).then((result) => result.html);
export const fetchStatement = (range: { from?: string; to?: string } = {}) => {
  const query = new URLSearchParams(Object.entries(range).filter(([, value]) => value)).toString();
  return portalFetch<{ lines: StatementLine[]; closing: string }>(`/portal/statement${query ? `?${query}` : ''}`);
};
export const fetchPayments = () => portalFetch<PortalPayment[]>('/portal/payments');

/** Opens a printed document in its own window and hands it to the printer. */
export function openPrintWindow(html: string): boolean {
  const printWindow = globalThis.open('', '_blank', 'width=900,height=1000');
  if (!printWindow) return false;
  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
  return true;
}
