import { apiFetch } from './api';

/**
 * 📱 واتساب — the client behind the desktop's «💬 واتساب» menu item
 * (`Form_WPF/frmInvSale.xaml` L1190, handled in `frmInvSale.xaml.cs` L3130-L3195), which
 * drove `Class/WhatsAppSender.cs` (267) through a Chrome window opened by
 * `Class/Session.cs` (L12-L31).
 *
 * The desktop window offered exactly one thing — «💬 واتساب» — and hid everything else in
 * the code: the number was a Chrome profile on that machine, the country code was the
 * literal «966» (`WhatsAppSender.cs` L113-L116), the attachment was always the invoice,
 * and the result was a message box that vanished on the next click.
 *
 * A server cannot hide those things, so they are on the screen:
 *
 *   تفعيل · عنوان الواتساب · الرمز · رمز الدولة · 📎 إرفاق الفاتورة · 🧪 محاكاة
 *   🧪 اختبار · 💾 حفظ · Logging — then 💬 واتساب on the invoice, with its own 📜 سجل.
 */

export type WhatsappSettingsView = {
  active: boolean;
  /** «عنوان الواتساب» — Meta's phone-number-id, the thing the desktop got from a QR scan. */
  phoneNumberId: string;
  hasToken: boolean;
  tokenMasked: string | null;
  /** «رمز الدولة» — 966 by default, the one the desktop hard-coded. */
  defaultCountryCode: string;
  /** «📎 إرفاق الفاتورة» — always on in the desktop; a tenant may want words only. */
  attachDocument: boolean;
  simulation: boolean;
  baseUrl: string;
  lastTest: { at?: string; ok?: boolean; status?: string; message?: string | null; displayPhoneNumber?: string | null; verifiedName?: string | null; lines?: string[] } | null;
  updatedAt: string | null;
};

export type WhatsappSettingsInput = {
  active?: boolean;
  phoneNumberId?: string;
  accessToken?: string;
  defaultCountryCode?: string;
  attachDocument?: boolean;
  simulation?: boolean;
};

export type WhatsappTestResult = {
  simulation: boolean;
  at: string;
  ok: boolean;
  status: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  message: string | null;
  /** Written into «Logging» on the settings row; the HTTP answer carries none. */
  lines?: string[];
};

export type WhatsappMessageRow = {
  id: string;
  invoiceId: string | null;
  partyId: string | null;
  phone: string;
  message: string;
  attachmentName: string | null;
  attachmentStatus: 'none' | 'sent' | 'failed';
  status: 'sent' | 'failed' | 'skipped';
  providerMessageId: string | null;
  attachmentMessageId: string | null;
  error: string | null;
  simulation: boolean;
  createdAt: string | null;
};

export type WhatsappSendInput = {
  invoiceId: string;
  to?: string;
  message?: string;
  attach?: boolean;
  simulation?: boolean;
};

/** «💬 واتساب» — the desktop's own words for the three ways a send can end. */
export const WHATSAPP_STATUS_LABELS: Record<string, string> = {
  sent: '✅ أُرسلت',
  failed: '❌ لم تُرسل',
  skipped: '⏭️ تُركت',
  none: '—',
};

export const ATTACHMENT_STATUS_LABELS: Record<string, string> = {
  none: 'بلا مُرفق',
  sent: '📎 أُرفقت',
  failed: '⚠️ تعذّر الإرفاق',
};

/** ⚙️ الإعدادات — the number, the token (masked) and the two switches. */
export const whatsappSettings = () => apiFetch<{ settings: WhatsappSettingsView }>('/whatsapp/settings');

/** 💾 حفظ. */
export const saveWhatsappSettings = (input: WhatsappSettingsInput) =>
  apiFetch<{ settings: WhatsappSettingsView }>('/whatsapp/settings', { method: 'PUT', body: JSON.stringify(input) });

/** 🧪 اختبار — is this number ours, and is this token good for it? */
export const testWhatsapp = () => apiFetch<WhatsappTestResult>('/whatsapp/test', { method: 'POST', body: '{}' });

/** 💬 واتساب — the menu item on the sale invoice window. */
export const sendWhatsapp = (input: WhatsappSendInput) =>
  apiFetch<{ message: WhatsappMessageRow; attachment: 'none' | 'sent' | 'failed'; attachmentError?: string | null }>(
    '/whatsapp/send',
    { method: 'POST', body: JSON.stringify(input) },
  );

/** 📜 السجل — what the desktop never kept: «هل وصلت؟» answered from a table. */
export const whatsappMessages = (query: { status?: string; invoiceId?: string; limit?: number } = {}) => {
  const search = new URLSearchParams();
  if (query.status) search.set('status', query.status);
  if (query.invoiceId) search.set('invoiceId', query.invoiceId);
  if (query.limit) search.set('limit', String(query.limit));
  const suffix = search.toString();
  return apiFetch<{ messages: WhatsappMessageRow[] }>(`/whatsapp/messages${suffix ? `?${suffix}` : ''}`);
};
