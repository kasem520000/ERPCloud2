import { createHash } from 'node:crypto';

/**
 * 📱 WhatsApp Cloud API — Meta's own endpoints
 * (https://developers.facebook.com/documentation/business-messaging/whatsapp).
 *
 * `Desktop_ERP` had no API at all: `Class/WhatsAppSender.cs` (267 lines) launches Chrome
 * through `chromedriver-win64`, opens <https://web.whatsapp.com>, waits for
 * `canvas[aria-label='Scan me!']`, types into
 * `div[contenteditable='true'][data-tab='10']`, clicks the 📎 button
 * (`//button[@data-tab='10']`), feeds an `input[type='file']` and finally clicks
 * `//span[contains(@data-icon,'send')]`. Every one of those steps is a person's browser,
 * so nothing survives the move to a server except the *intent* — and the two sentences
 * the desktop actually sent:
 *
 *   🧾 مرحباً {custName}، هذه فاتورتك رقم {invRef} من {foundName}
 *   ❌ الرقم غير مرتبط بحساب WhatsApp أو لم يتم تحميل المحادثة.
 *
 * The calls below are the provider's documented ones:
 *
 *   POST {graph}/{version}/{phone-number-id}/messages   text and document
 *   POST {graph}/{version}/{phone-number-id}/media      upload (multipart, 30-day life)
 *   GET  {graph}/{version}/{phone-number-id}            🧪 اختبار — is this number ours?
 */

/** `https://graph.facebook.com` — the Cloud API host. */
export const GRAPH_BASE = 'https://graph.facebook.com';
/** Graph API version. */
export const GRAPH_VERSION = 'v21.0';

/** How long we wait for Meta before calling it unreachable. */
const TIMEOUT_MS = 20_000;

/**
 * The document types WhatsApp accepts (`Supported Media Types`): PDF and Office files, and
 * **plain text**. The desktop attached a PDF that DevExpress rendered on the cashier's
 * machine; this platform renders invoices as print-ready HTML for the *browser* to turn
 * into a PDF (see `reporting.service.ts`), because a server-side PDF would mean shipping a
 * font with Arabic shaping. So the sheet travels as UTF-8 text — the one type that is both
 * supported and renderable here without a font.
 */
export const DOCUMENT_MIME = 'text/plain';

export type CloudConfig = {
  phoneNumberId: string;
  accessToken: string;
  baseUrl?: string;
  version?: string;
  /** 🧪 Simulation — answer locally instead of dialling. */
  simulation: boolean;
};

export type CloudResult = {
  ok: boolean;
  /** `messages[0].id` — the handle a delivery dispute starts from. */
  messageId: string | null;
  error: string | null;
  raw: Record<string, unknown>;
};

export type UploadResult = { mediaId: string | null; error: string | null; raw: Record<string, unknown> };

export type VerifyResult = {
  ok: boolean;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  error: string | null;
  raw: Record<string, unknown>;
};

type GraphError = { error?: { message?: string; type?: string; code?: number; error_subcode?: number } };

function graphError(payload: GraphError & Record<string, unknown>, status: number): string {
  const detail = payload.error;
  if (detail?.message) {
    const code = detail.code ?? detail.error_subcode;
    return code ? `${detail.message} (${code})` : detail.message;
  }
  return `WhatsApp Cloud API answered ${status}.`;
}

function url(config: CloudConfig, path: string): string {
  const base = (config.baseUrl ?? GRAPH_BASE).replace(/\/+$/, '');
  const version = config.version ?? GRAPH_VERSION;
  return `${base}/${version}/${encodeURIComponent(config.phoneNumberId)}${path}`;
}

/** 🧪 — a stable handle, so the same send twice is recognisable in the log. */
function simulatedId(prefix: string, seed: string): string {
  return `${prefix}${createHash('sha1').update(seed).digest('hex').slice(0, 16)}`;
}

// ── 🧪 Simulation ─────────────────────────────────────────────────────────────────────

/**
 * 🧪 — nothing is dialled. One hook decides the verdict, and it is a *number* rather than a
 * message body because that is what the desktop's own error was about: a phone that is not
 * on WhatsApp (`WhatsAppSender.cs` L142). Any number ending in `0000` is treated as one.
 */
export const SIMULATION_UNDELIVERABLE_SUFFIX = '0000';

export function simulatedUndeliverable(phone: string): boolean {
  return phone.endsWith(SIMULATION_UNDELIVERABLE_SUFFIX);
}

export function simulatedSend(phone: string, body: string): CloudResult {
  if (simulatedUndeliverable(phone)) {
    return {
      ok: false,
      messageId: null,
      error: '❌ الرقم غير مرتبط بحساب WhatsApp أو لم يتم تحميل المحادثة.',
      raw: { simulation: true, phone, code: 131030 },
    };
  }
  return {
    ok: true,
    messageId: simulatedId('wamid.SIM-', `${phone}:${body}`),
    error: null,
    raw: { simulation: true, phone, length: body.length },
  };
}

export function simulatedUpload(phone: string, filename: string): UploadResult {
  return { mediaId: simulatedId('SIM-MEDIA-', `${phone}:${filename}`), error: null, raw: { simulation: true, filename } };
}

export function simulatedVerify(config: CloudConfig): VerifyResult {
  const ok = config.phoneNumberId.trim().length > 0 && config.accessToken.trim().length > 0;
  return {
    ok,
    displayPhoneNumber: ok ? '+966 5000 0000' : null,
    verifiedName: ok ? '🧪 Simulation' : null,
    error: ok ? null : '❌ لم تُضبط بوابة واتساب: المعرّف أو الرمز فارغ.',
    raw: { simulation: true },
  };
}

// ── the real calls ────────────────────────────────────────────────────────────────────

/** 🧪 اختبار — `GET /{phone-number-id}?fields=id,display_phone_number,verified_name`. */
export async function verifyConnection(config: CloudConfig): Promise<VerifyResult> {
  if (config.simulation) return simulatedVerify(config);
  try {
    const response = await fetch(`${url(config, '')}?fields=id,display_phone_number,verified_name`, {
      headers: { authorization: `Bearer ${config.accessToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown> & GraphError;
    if (!response.ok) {
      return { ok: false, displayPhoneNumber: null, verifiedName: null, error: graphError(payload, response.status), raw: payload };
    }
    return {
      ok: true,
      displayPhoneNumber: (payload.display_phone_number as string | undefined) ?? null,
      verifiedName: (payload.verified_name as string | undefined) ?? null,
      error: null,
      raw: payload,
    };
  } catch (error) {
    return {
      ok: false,
      displayPhoneNumber: null,
      verifiedName: null,
      error: `تعذّر الوصول إلى واتساب: ${(error as Error).message}`,
      raw: { error: String((error as Error).message ?? error) },
    };
  }
}

/** A `text` message — the greeting line of `frmInvSale.xaml.cs` L3177-L3178. */
export async function sendText(config: CloudConfig, phone: string, body: string): Promise<CloudResult> {
  if (config.simulation) return simulatedSend(phone, body);
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'text',
    text: { preview_url: false, body },
  };
  return postMessage(config, payload, phone, body);
}

/** 📎 — `POST /{phone-number-id}/media`, multipart, `messaging_product=whatsapp`. */
export async function uploadMedia(
  config: CloudConfig,
  options: { bytes: Buffer; filename: string; mime?: string },
): Promise<UploadResult> {
  if (config.simulation) return simulatedUpload('', options.filename);
  const form = new FormData();
  form.set('messaging_product', 'whatsapp');
  form.set('file', new Blob([new Uint8Array(options.bytes)], { type: options.mime ?? DOCUMENT_MIME }), options.filename);
  try {
    const response = await fetch(url(config, '/media'), {
      method: 'POST',
      headers: { authorization: `Bearer ${config.accessToken}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const payload = (await response.json().catch(() => ({}))) as { id?: string } & GraphError;
    if (!response.ok || !payload.id) {
      return { mediaId: null, error: graphError(payload, response.status), raw: payload as Record<string, unknown> };
    }
    return { mediaId: payload.id, error: null, raw: payload as Record<string, unknown> };
  } catch (error) {
    return { mediaId: null, error: `تعذّر رفع المرفق: ${(error as Error).message}`, raw: { error: String((error as Error).message ?? error) } };
  }
}

/** 📎 — a `document` message carrying the invoice sheet. */
export async function sendDocument(
  config: CloudConfig,
  input: { phone: string; mediaId: string; filename: string; caption?: string },
): Promise<CloudResult> {
  if (config.simulation) return simulatedSend(input.phone, input.caption ?? input.filename);
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: input.phone,
    type: 'document',
    document: { id: input.mediaId, filename: input.filename, ...(input.caption ? { caption: input.caption } : {}) },
  };
  return postMessage(config, payload, input.phone, input.caption ?? input.filename);
}

async function postMessage(config: CloudConfig, payload: Record<string, unknown>, phone: string, body: string): Promise<CloudResult> {
  try {
    const response = await fetch(url(config, '/messages'), {
      method: 'POST',
      headers: { authorization: `Bearer ${config.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const answer = (await response.json().catch(() => ({}))) as { messages?: Array<{ id?: string }> } & GraphError;
    if (!response.ok) {
      return { ok: false, messageId: null, error: graphError(answer, response.status), raw: answer as Record<string, unknown> };
    }
    const messageId = answer.messages?.[0]?.id ?? null;
    if (!messageId) {
      return { ok: false, messageId: null, error: 'لم يُرجع واتساب معرّفاً للرسالة.', raw: answer as Record<string, unknown> };
    }
    return { ok: true, messageId, error: null, raw: answer as Record<string, unknown> };
  } catch (error) {
    return {
      ok: false,
      messageId: null,
      error: `تعذّر الوصول إلى واتساب: ${(error as Error).message}`,
      raw: { phone, length: body.length, error: String((error as Error).message ?? error) },
    };
  }
}
