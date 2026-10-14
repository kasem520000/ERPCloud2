import { createHmac, timingSafeEqual } from 'node:crypto';

import { Decimal } from 'decimal.js';

/**
 * Online payment-link providers. Moyasar invoices are the primary path
 * (`POST /v1/invoices`, amount in halalas, HTTP Basic). Tap and HyperPay use the
 * same staff/portal contract; their request bodies stay provider-specific.
 *
 * Moyasar does not HMAC the webhook body. It echoes the shared secret the merchant
 * configured (`secret_token`). A match proves the sender knows the secret; the
 * stored link amount and currency are still checked before a receipt is created.
 */

export const ONLINE_PROVIDERS = ['moyasar', 'hyperpay', 'tap'] as const;
export type OnlineProvider = (typeof ONLINE_PROVIDERS)[number];

export const PROVIDER_LABELS: Record<OnlineProvider, string> = {
  moyasar: 'ميسر',
  hyperpay: 'HyperPay',
  tap: 'Tap',
};

const DEFAULT_BASES: Record<OnlineProvider, string> = {
  moyasar: 'https://api.moyasar.com/v1',
  hyperpay: 'https://eu-prod.oppwa.com',
  tap: 'https://api.tap.company/v2',
};

export function isOnlineProvider(value: string): value is OnlineProvider {
  return (ONLINE_PROVIDERS as readonly string[]).includes(value);
}

export function providerBase(provider: OnlineProvider, override?: string): string {
  const fromEnv =
    override ||
    (provider === 'moyasar'
      ? process.env.MOYASAR_API_BASE
      : provider === 'tap'
        ? process.env.TAP_API_BASE
        : process.env.HYPERPAY_API_BASE);
  return (fromEnv || DEFAULT_BASES[provider]).replace(/\/+$/, '');
}

export function toMinorUnits(valueText: string | Decimal): number {
  const minor = new Decimal(valueText).mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  if (!minor.isFinite() || minor.lte(0) || !minor.isInteger()) {
    throw new Error('Payment amount must convert to a positive number of halalas');
  }
  return minor.toNumber();
}

export function fromMinorUnits(minorUnits: number | string): string {
  return new Decimal(minorUnits).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

export function money2(valueText: string | Decimal): string {
  return new Decimal(valueText).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

export function amountsMatch(left: string, right: string): boolean {
  return new Decimal(money2(left)).eq(money2(right));
}

export function verifySharedSecret(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function verifyHmacHex(payload: string, signature: string | undefined, secret: string | undefined): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  return verifySharedSecret(signature.replace(/^sha256=/i, ''), expected);
}

export type InvoiceLinkRequest = {
  provider: OnlineProvider;
  amount: string;
  currency: string;
  description: string;
  paymentLinkId: string;
  invoiceId: string;
  tenantId: string;
  callbackUrl?: string;
  successUrl?: string;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  entityId?: string;
};

export type ProviderCall = {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
};

export function basicAuth(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
}

export function buildProviderCall(input: InvoiceLinkRequest, apiKey: string, base = providerBase(input.provider)): ProviderCall {
  const metadata = {
    tenant_id: input.tenantId,
    payment_link_id: input.paymentLinkId,
    invoice_id: input.invoiceId,
  };
  if (input.provider === 'moyasar') {
    return {
      url: `${base}/invoices`,
      method: 'POST',
      headers: { authorization: basicAuth(apiKey), 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        amount: toMinorUnits(input.amount),
        currency: input.currency || 'SAR',
        description: input.description.slice(0, 255),
        callback_url: input.callbackUrl,
        success_url: input.successUrl,
        metadata,
      }),
    };
  }
  if (input.provider === 'tap') {
    return {
      url: `${base}/invoices`,
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        draft: false,
        description: input.description.slice(0, 255),
        currencies: [input.currency || 'SAR'],
        amount: Number(money2(input.amount)),
        customer: {
          first_name: input.customerName || 'Customer',
          email: input.customerEmail || undefined,
          phone: input.customerPhone ? { country_code: '966', number: input.customerPhone.replace(/^966/, '') } : undefined,
        },
        redirect: input.successUrl ? { url: input.successUrl } : undefined,
        metadata,
      }),
    };
  }
  const params = new URLSearchParams({
    entityId: input.entityId || '',
    amount: money2(input.amount),
    currency: input.currency || 'SAR',
    paymentType: 'DB',
    merchantTransactionId: input.paymentLinkId,
    'customParameters[tenant_id]': input.tenantId,
    'customParameters[payment_link_id]': input.paymentLinkId,
    'customParameters[invoice_id]': input.invoiceId,
  });
  if (input.successUrl) params.set('shopperResultUrl', input.successUrl);
  return {
    url: `${base}/v1/checkouts`,
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: params.toString(),
  };
}

export type CreatedProviderLink = {
  externalId: string;
  url: string;
  status: string;
  raw: Record<string, unknown>;
};

export function readProviderLink(provider: OnlineProvider, payload: Record<string, unknown>, base = providerBase(provider)): CreatedProviderLink {
  const id = stringValue(payload.id) || stringValue(payload.checkoutId);
  if (!id) throw new Error('Provider response did not include an id');
  const url =
    stringValue(payload.url) ||
    stringValue(nested(payload, 'redirect', 'url')) ||
    (provider === 'hyperpay' ? `${base}/v1/checkouts/${id}/payment` : '');
  if (!url) throw new Error('Provider response did not include a payment URL');
  return { externalId: id, url, status: (stringValue(payload.status) || 'initiated').toLowerCase(), raw: payload };
}

export function simulatedLink(provider: OnlineProvider, paymentLinkId: string): CreatedProviderLink {
  const externalId = `sim_${provider}_${paymentLinkId.replace(/-/g, '').slice(0, 16)}`;
  return {
    externalId,
    url: `https://pay.simulation.local/${provider}/${externalId}`,
    status: 'initiated',
    raw: { simulation: true, id: externalId },
  };
}

export type NormalizedWebhook = {
  provider: OnlineProvider;
  eventType: string;
  secretToken?: string;
  externalId?: string;
  paymentId?: string;
  amount?: string;
  currency?: string;
  outcome: 'paid' | 'failed' | 'expired' | 'ignored';
  tenantId?: string;
  paymentLinkId?: string;
  invoiceId?: string;
};

export function interpretWebhook(provider: OnlineProvider, body: Record<string, unknown>): NormalizedWebhook {
  const data = isRecord(body.data) ? body.data : body;
  const metadata = isRecord(data.metadata) ? data.metadata : isRecord(body.metadata) ? body.metadata : {};
  const custom = isRecord(data.customParameters) ? data.customParameters : {};
  const eventType = stringValue(body.type) || stringValue(data.status) || 'unknown';
  const outcome = outcomeOf(eventType, stringValue(data.status) || stringValue(body.status));
  const minor = provider === 'moyasar' && (typeof data.amount === 'number' || typeof body.amount === 'number');
  const rawAmount = data.amount ?? body.amount;
  return {
    provider,
    eventType,
    secretToken: stringValue(body.secret_token) || stringValue(body.secretToken) || stringValue(data.secret_token),
    externalId: stringValue(data.invoice_id) || stringValue(body.invoice_id) || stringValue(data.id) || stringValue(body.id),
    paymentId: stringValue(data.id) || stringValue(body.id) || stringValue(body.event_id),
    amount: rawAmount === undefined || rawAmount === null ? undefined : minor ? fromMinorUnits(Number(rawAmount)) : money2(String(rawAmount)),
    currency: (stringValue(data.currency) || stringValue(body.currency) || 'SAR').toUpperCase(),
    outcome,
    tenantId: stringValue(metadata.tenant_id) || stringValue(custom.tenant_id) || stringValue(body.tenant_id),
    paymentLinkId: stringValue(metadata.payment_link_id) || stringValue(custom.payment_link_id) || stringValue(body.payment_link_id),
    invoiceId: stringValue(metadata.invoice_id) || stringValue(custom.invoice_id),
  };
}

export type SettlementDecision =
  | { action: 'settle'; amount: string; currency: string; paymentId: string }
  | { action: 'expire' }
  | { action: 'fail' }
  | { action: 'ignore'; reason: string }
  | { action: 'reject'; reason: string };

export function settlementDecision(
  link: { amount: string; currency: string; status: string },
  event: NormalizedWebhook,
): SettlementDecision {
  if (link.status === 'paid') return { action: 'ignore', reason: 'already-paid' };
  if (link.status === 'expired') return { action: 'reject', reason: 'link-expired' };
  if (event.outcome === 'expired') return { action: 'expire' };
  if (event.outcome === 'failed') return { action: 'fail' };
  if (event.outcome !== 'paid') return { action: 'ignore', reason: event.eventType };
  if (!event.paymentId) return { action: 'reject', reason: 'payment-id-missing' };
  if (!event.amount) return { action: 'reject', reason: 'amount-missing' };
  if (!amountsMatch(link.amount, event.amount)) return { action: 'reject', reason: 'amount-mismatch' };
  if (event.currency && event.currency !== (link.currency || 'SAR').toUpperCase()) {
    return { action: 'reject', reason: 'currency-mismatch' };
  }
  return { action: 'settle', amount: money2(link.amount), currency: link.currency || 'SAR', paymentId: event.paymentId };
}

export function redactWebhook(body: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...body };
  delete clone.secret_token;
  delete clone.secretToken;
  if (isRecord(clone.data)) {
    const data = { ...clone.data };
    delete data.secret_token;
    delete data.secretToken;
    clone.data = data;
  }
  return clone;
}

function outcomeOf(eventType: string, status: string | undefined): NormalizedWebhook['outcome'] {
  const token = `${eventType} ${status ?? ''}`.toLowerCase();
  if (/payment_paid|\bpaid\b|captured|success/.test(token)) return 'paid';
  if (/expired/.test(token)) return 'expired';
  if (/fail|void|cancel|declin/.test(token)) return 'failed';
  return 'ignored';
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nested(record: Record<string, unknown>, key: string, child: string): unknown {
  const value = record[key];
  return isRecord(value) ? value[child] : undefined;
}
