import { apiFetch } from './api';

/**
 * 💳 بوابات الدفع — the client behind
 * `Desktop_ERP/SmartAuditERP/Form_WPF/frmSettings.xaml` L1726-L1831: the tab
 * «إعدادات جيديا» and the GroupBox «NeoLeap» inside it, plus the two POS save paths that
 * call them (`frmPOSBill.xaml.cs` L460-L492, `frmPOSPay.xaml.cs` L428-L441).
 *
 * Every function here is one button of that window, and the labels are its own:
 *
 *   💳 إعدادات جيديا — تفعيل الدفع عن طريق جيديا · طباعة ايصال · المنفذ · المبلغ ·
 *   🧪 TEST · 💾 حفظ
 *   NeoLeap — تفعيل NeoLeap · طباعة إيصال NeoLeap · المنفذ · المبلغ · Token · Logging ·
 *   🧪 Test · 💾 حفظ
 */

export type GatewayProvider = 'geidea' | 'neoleap';

export type GatewayView = {
  provider: GatewayProvider;
  labelAr: string;
  active: boolean;
  printReceipt: boolean;
  port: number | null;
  baseUrl: string;
  currency: string;
  merchantKey: string;
  hasSecret: boolean;
  secretMasked: string | null;
  callbackUrl: string;
  simulation: boolean;
  lastTest: { at?: string; status?: string; ok?: boolean; message?: string | null; lines?: string[] } | null;
  updatedAt: string | null;
};

export type GatewaySettingsInput = {
  active?: boolean;
  printReceipt?: boolean;
  port?: number | null;
  baseUrl?: string;
  currency?: string;
  merchantKey?: string;
  merchantSecret?: string;
  callbackUrl?: string;
  simulation?: boolean;
};

export type TestResult = {
  provider: GatewayProvider;
  labelAr: string;
  simulation: boolean;
  at: string;
  status: string;
  ok: boolean;
  responseCode: string | null;
  detailedResponseCode: string | null;
  message: string | null;
  reference: string;
  sessionId: string | null;
  lines: string[];
};

export type TransactionRow = {
  id: string;
  provider: GatewayProvider;
  reference: string;
  sessionId: string | null;
  invoiceId: string | null;
  branchId: string | null;
  amount: string;
  currency: string;
  status: string;
  responseCode: string | null;
  detailedResponseCode: string | null;
  message: string | null;
  approvalCode: string | null;
  rrn: string | null;
  stan: string | null;
  cardScheme: string | null;
  panMasked: string | null;
  transactionType: string | null;
  checkoutUrl: string | null;
  simulation: boolean;
  settled: boolean;
  createdAt: string | null;
};

/** The word the window puts under each status — the gateway's own, not ours. */
export const STATUS_LABELS: Record<string, string> = {
  initiated: '⏳ بانتظار الدفع',
  approved: '✅ مقبولة',
  declined: '❌ مرفوضة',
  cancelled: '🚫 ملغاة',
  unknown: '❓ حالة غير معروفة',
  error: '⚠️ تعذّر الوصول إلى البوابة',
};

/** 💳 إعدادات جيديا + NeoLeap — the two cards, each with its own saved row. */
export const paymentGatewaysView = () => apiFetch<{ providers: GatewayView[] }>('/payment-gateways');

/** 💾 حفظ — one provider at a time, exactly as the window saves them. */
export const savePaymentGateway = (provider: GatewayProvider, input: GatewaySettingsInput) =>
  apiFetch<GatewayView>(`/payment-gateways/${provider}`, { method: 'PUT', body: JSON.stringify(input) });

/** 🧪 TEST · 🧪 Test — `BtnTestGedia_Click` (L2513) and `Btntestneoleap_Click` (L4047). */
export const testPaymentGateway = (provider: GatewayProvider) =>
  apiFetch<TestResult>(`/payment-gateways/${provider}/test`, { method: 'POST', body: '{}' });

/** 💳 — the sale the POS used to run inside its own save. */
export const payWithGateway = (
  provider: GatewayProvider,
  input: { amount: string; invoiceId?: string; branchId?: string; reference?: string; currency?: string },
) =>
  apiFetch<{ transaction: TransactionRow; settled: boolean; settlementError?: string }>(`/payment-gateways/${provider}/sale`, {
    method: 'POST',
    body: JSON.stringify(input),
  });

/** The log — what the desktop threw away once the receipt was printed. */
export const gatewayTransactions = (query: { provider?: string; status?: string; limit?: number } = {}) => {
  const search = new URLSearchParams();
  if (query.provider) search.set('provider', query.provider);
  if (query.status) search.set('status', query.status);
  if (query.limit) search.set('limit', String(query.limit));
  const suffix = search.toString();
  return apiFetch<{ transactions: TransactionRow[] }>(`/payment-gateways/transactions${suffix ? `?${suffix}` : ''}`);
};

/** 🔄 — ask جيديا again how a session the cardholder has not finished ended. */
export const refreshGatewayTransaction = (id: string) =>
  apiFetch<{ transaction: TransactionRow; settled: boolean; refreshed: boolean; message?: string }>(
    `/payment-gateways/transactions/${id}/refresh`,
    { method: 'POST', body: '{}' },
  );
