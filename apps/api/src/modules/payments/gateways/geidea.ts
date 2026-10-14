import { createHmac, randomUUID } from 'node:crypto';

import {
  emptyResult,
  maskPan,
  type GatewayConfig,
  type GatewayResult,
  type GatewaySaleRequest,
  type PaymentGateway,
} from './types.js';

/**
 * 💳 جيديا — the Geidea gateway, as published in its own documentation
 * (https://docs.geidea.net — «Geidea HPP Checkout» and «Fetch Transaction or Order
 * Details by Merchant Reference»).
 *
 * `Desktop_ERP` reaches Geidea the way a till does: `Geidea.ConnectGeidea(Payment)`
 * (`Class/Geidea.cs` L16-L56) writes `"<halalas>;1;1!"` to **COM1 at 38400 baud** through
 * `madaapi.dll` and reads five bytes back; `frmPOSBill.xaml.cs` L465-L470 then accepts the
 * sale only if the first three characters are one of
 * `000 · 001 · 003 · 007 · 087 · 089`, and otherwise stops the save with
 * «العملية مرفوضة، يرجى إعادة الدفع». A server has no COM1, so the calls below are the
 * provider's own HTTP ones — same money, same vocabulary, different wire:
 *
 *   POST {base}/payment-intent/api/v2/direct/session   ← open the payment session
 *   GET  {base}/pgw/api/v1/direct/order?MerchantReferenceId=… ← ask how it ended
 *   {checkout}/hpp/checkout/?<sessionId>               ← the page the cardholder pays on
 *
 * The response codes are Geidea's (`responseCode` · `detailedResponseCode`, 000 = success),
 * which is the same family the desktop's six accepted codes come from.
 */

/** KSA environment — `https://api.ksamerchant.geidea.net` (docs: «Usage of the API environment endpoints»). */
export const GEIDEA_KSA_API = 'https://api.ksamerchant.geidea.net';
/** The hosted page the cashier opens — `https://www.ksamerchant.geidea.net/hpp/checkout/?<sessionId>`. */
export const GEIDEA_KSA_CHECKOUT = 'https://www.ksamerchant.geidea.net/hpp/checkout/';

export const GEIDEA_SESSION_PATH = '/payment-intent/api/v2/direct/session';
export const GEIDEA_ORDER_PATH = '/pgw/api/v1/direct/order';

/** The desktop's 💳 test amount — «المبلغ» defaults to 0.01 (`frmSettings.xaml` L1753). */
export const GEIDEA_TEST_VALUE = '0.01';

/** How long we wait for the gateway before calling it unreachable. */
const TIMEOUT_MS = 20_000;

/**
 * `base64(HMAC-SHA256(apiPassword, merchantPublicKey ‖ amount(F2) ‖ currency ‖
 * merchantReferenceId ‖ timestamp))` — the provider's own recipe, field for field.
 */
export function geideaSignature(input: {
  merchantKey: string;
  apiPassword: string;
  value: string;
  currency: string;
  reference: string;
  timestamp: string;
}): string {
  const payload = `${input.merchantKey}${Number(input.value).toFixed(2)}${input.currency}${input.reference}${input.timestamp}`;
  return createHmac('sha256', input.apiPassword).update(payload).digest('base64');
}

/** `api.ksamerchant.geidea.net` → `www.ksamerchant.geidea.net/hpp/checkout/`. */
export function geideaCheckoutBase(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.startsWith('https://api.')) return `https://www.${trimmed.slice('https://api.'.length)}/hpp/checkout/`;
  if (trimmed.startsWith('http://api.')) return `http://www.${trimmed.slice('http://api.'.length)}/hpp/checkout/`;
  return `${trimmed}/hpp/checkout/`;
}

type GeideaSessionResponse = {
  session?: { id?: string; status?: string; amount?: number; currency?: string; expiryDate?: string };
  responseCode?: string;
  responseMessage?: string;
  detailedResponseCode?: string;
  detailedResponseMessage?: string;
};

type GeideaOrder = {
  orderId?: string;
  status?: string;
  detailedStatus?: string;
  detailedResponseMessage?: string;
  amount?: number;
  currency?: string;
  transactions?: Array<Record<string, unknown>>;
};

/** `Success` · `Failed` · `Cancelled` are the order `status` values the docs list. */
function mapOrderStatus(status?: string, detailed?: string): GatewayResult['status'] {
  const word = String(status ?? '').toLowerCase();
  if (word === 'success' || word === 'paid') return 'approved';
  if (word === 'failed' || word === 'declined') return 'declined';
  if (word === 'cancelled' || word === 'canceled') return 'cancelled';
  if (word === 'initiated' || word === 'pending' || word === 'created') return 'initiated';
  if (detailed && detailed.length > 0) return 'unknown';
  return 'unknown';
}

function firstTransaction(order: GeideaOrder): Record<string, unknown> {
  return order.transactions?.[0] ?? {};
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const asText = String(value);
  return asText.length > 0 ? asText : null;
}

function basicAuth(config: GatewayConfig): string {
  return `Basic ${Buffer.from(`${config.merchantKey}:${config.merchantSecret}`).toString('base64')}`;
}

export class GeideaGateway implements PaymentGateway {
  readonly provider = 'geidea' as const;
  /** A session is opened and paid later — the state is worth asking about. */
  readonly queryable = true;

  async sale(request: GatewaySaleRequest, config: GatewayConfig): Promise<GatewayResult> {
    const timestamp = new Date().toISOString();
    const body = {
      amount: Number(request.value),
      currency: request.currency,
      timestamp,
      merchantReferenceId: request.reference,
      signature: geideaSignature({
        merchantKey: config.merchantKey,
        apiPassword: config.merchantSecret,
        value: request.value,
        currency: request.currency,
        reference: request.reference,
        timestamp,
      }),
      paymentOperation: 'Pay',
      language: 'ar',
      ...(request.callbackUrl ?? config.callbackUrl ? { callbackUrl: request.callbackUrl ?? config.callbackUrl } : {}),
    };

    const raw: Record<string, unknown> = { request: body };
    try {
      const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}${GEIDEA_SESSION_PATH}`, {
        method: 'POST',
        headers: { authorization: basicAuth(config), 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const payload = (await response.json().catch(() => ({}))) as GeideaSessionResponse & Record<string, unknown>;
      Object.assign(raw, payload, { httpStatus: response.status });

      if (!response.ok || String(payload.responseCode ?? '') !== '000' || String(payload.detailedResponseCode ?? '') !== '000') {
        return {
          ...emptyResult(request.reference, 'error', text(payload.detailedResponseMessage) ?? text(payload.responseMessage) ?? 'تعذّر فتح جلسة الدفع.'),
          responseCode: text(payload.responseCode),
          detailedResponseCode: text(payload.detailedResponseCode),
          raw,
        };
      }

      const sessionId = text(payload.session?.id);
      return {
        status: 'initiated',
        reference: request.reference,
        sessionId,
        checkoutUrl: sessionId ? `${geideaCheckoutBase(config.baseUrl)}${sessionId}` : null,
        responseCode: text(payload.responseCode),
        detailedResponseCode: text(payload.detailedResponseCode),
        message: text(payload.detailedResponseMessage) ?? text(payload.responseMessage),
        approvalCode: null,
        rrn: null,
        stan: null,
        cardScheme: null,
        panMasked: null,
        transactionType: 'Pay',
        raw,
      };
    } catch (error) {
      return {
        ...emptyResult(request.reference, 'error', `تعذّر الوصول إلى بوابة جيديا: ${(error as Error).message}`),
        raw: { ...raw, error: String((error as Error).message ?? error) },
      };
    }
  }

  async status(input: { reference: string; sessionId: string | null }, config: GatewayConfig): Promise<GatewayResult> {
    const raw: Record<string, unknown> = { merchantReferenceId: input.reference, sessionId: input.sessionId };
    try {
      const url = `${config.baseUrl.replace(/\/+$/, '')}${GEIDEA_ORDER_PATH}?MerchantReferenceId=${encodeURIComponent(input.reference)}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: { authorization: basicAuth(config), accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const payload = (await response.json().catch(() => ({}))) as { orders?: GeideaOrder[] } & Record<string, unknown>;
      Object.assign(raw, payload, { httpStatus: response.status });
      const orders = Array.isArray(payload.orders) ? payload.orders : [];
      const order = orders[orders.length - 1];
      if (!order) {
        return { ...emptyResult(input.reference, 'initiated', 'لا يزال الدفع معلّقاً لدى جيديا.'), sessionId: input.sessionId, raw };
      }
      const status = mapOrderStatus(order.status, order.detailedStatus);
      const transaction = firstTransaction(order);
      return {
        status,
        reference: input.reference,
        sessionId: text(order.orderId) ?? input.sessionId,
        checkoutUrl: input.sessionId ? `${geideaCheckoutBase(config.baseUrl)}${input.sessionId}` : null,
        responseCode: status === 'approved' ? '000' : null,
        detailedResponseCode: text(order.detailedStatus),
        message: text(order.detailedResponseMessage) ?? text(order.detailedStatus),
        approvalCode: text(transaction.approvalCode ?? transaction.approvalNumber),
        rrn: text(transaction.rrn ?? transaction.retrievalReferenceNumber),
        stan: text(transaction.stan ?? transaction.systemTraceAuditNumber),
        cardScheme: text(transaction.cardScheme ?? transaction.paymentBrand ?? transaction.cardBrand),
        panMasked: maskPan(text(transaction.pan ?? transaction.maskedPan ?? transaction.cardNumber)),
        transactionType: text(transaction.transactionType) ?? 'Pay',
        raw,
      };
    } catch (error) {
      return {
        ...emptyResult(input.reference, 'error', `تعذّر الوصول إلى بوابة جيديا: ${(error as Error).message}`),
        sessionId: input.sessionId,
        raw: { ...raw, error: String((error as Error).message ?? error) },
      };
    }
  }

  /** 🧪 TEST — the desktop charged «المبلغ» (0.01 by default) to prove the link works. */
  async test(config: GatewayConfig, value = GEIDEA_TEST_VALUE): Promise<GatewayResult> {
    return this.sale(
      {
        value,
        currency: config.currency,
        reference: `TEST-${randomUUID()}`,
        printReceipt: config.printReceipt,
      },
      config,
    );
  }
}
