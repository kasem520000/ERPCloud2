import { createHash } from 'node:crypto';

import { GeideaGateway, GEIDEA_KSA_API } from './geidea.js';
import { NeoleapGateway } from './neoleap.js';
import { emptyResult, type GatewayProvider, type GatewayResult, type PaymentGateway } from './types.js';

export * from './types.js';
export { GeideaGateway, GEIDEA_KSA_API, GEIDEA_KSA_CHECKOUT, geideaSignature, geideaCheckoutBase, GEIDEA_TEST_VALUE } from './geidea.js';
export { NeoleapGateway, NEOLEAP_TEST_TOKEN, NEOLEAP_TEST_VALUE, parseNeoleapResponse } from './neoleap.js';

const geidea = new GeideaGateway();
const neoleap = new NeoleapGateway();

export const GATEWAY_PROVIDERS: GatewayProvider[] = ['geidea', 'neoleap'];

export function gatewayFor(provider: GatewayProvider): PaymentGateway {
  return provider === 'geidea' ? geidea : neoleap;
}

/** المنفذ → the address the connector listens on, when the tenant configured nothing else. */
export function defaultBaseUrl(provider: GatewayProvider, port?: number | null): string {
  if (provider === 'geidea') return GEIDEA_KSA_API;
  return port ? `http://127.0.0.1:${port}` : '';
}

/**
 * 🧪 Simulation — the answer the gateway would have given, computed here instead.
 *
 * Both providers are answered locally, exactly as `einvoice_settings.simulation` answers
 * ZATCA locally: no acquirer is dialled, no card is charged, and the numbers are derived
 * from the reference so the same call twice returns the same verdict.
 *
 * The cardholder's decision is taken from the `ecrRef` prefix, which is the only way a
 * test can ask for a refusal without a real card:
 *
 *   `DECLINE-…` → مرفوضة · `CANCEL-…` → ملغاة · `ERROR-…` → تعذّر الوصول · `UNKNOWN-…` →
 *   ردٌّ لا نقرؤه · `PENDING-…` → تبقى معلّقة (جيديا وحدها، لأن صفحتها تُفتح قبل أن يدفع
 *   العميل) · أي مرجع آخر → مقبولة.
 */
const SIMULATION_PREFIXES: Record<string, GatewayResult['status']> = {
  'DECLINE-': 'declined',
  'CANCEL-': 'cancelled',
  'ERROR-': 'error',
  'UNKNOWN-': 'unknown',
  'PENDING-': 'initiated',
};

function simulatedVerdict(reference: string): GatewayResult['status'] {
  for (const [prefix, status] of Object.entries(SIMULATION_PREFIXES)) {
    if (reference.startsWith(prefix)) return status;
  }
  return 'approved';
}

/** A stable pseudo-random tail, so the same reference always yields the same receipt. */
function seedOf(reference: string): string {
  return createHash('sha1').update(reference).digest('hex');
}

function receiptFields(reference: string, provider: GatewayProvider) {
  const seed = seedOf(reference);
  return {
    approvalCode: seed.slice(0, 6).replace(/[a-f]/g, '0'),
    rrn: seed.slice(6, 18).replace(/[a-f]/g, '1'),
    stan: seed.slice(18, 24).replace(/[a-f]/g, '2'),
    cardScheme: 'MADA',
    panMasked: '****4242',
    transactionType: provider === 'geidea' ? 'Pay' : 'SALE',
  };
}

/**
 * جيديا answers in `responseCode` / `detailedResponseCode`, where **000** means «the call
 * was accepted» — a session that has only just been opened is a 000 too, and says
 * `Success`, because the cardholder has not failed anything yet.
 */
function geideaOutcome(reference: string, status: GatewayResult['status'], raw: Record<string, unknown>): GatewayResult {
  const unknown = { responseCode: null, detailed: null, message: 'Unknown Status' };
  const codes: Record<string, { responseCode: string | null; detailed: string | null; message: string | null }> = {
    initiated: { responseCode: '000', detailed: '000', message: 'Success' },
    approved: { responseCode: '000', detailed: '000', message: 'Success' },
    declined: { responseCode: '100', detailed: '100.001', message: 'Declined' },
    cancelled: { responseCode: '102', detailed: '102.001', message: 'Cancelled' },
    unknown,
    error: { responseCode: null, detailed: null, message: 'تعذّر الوصول إلى بوابة جيديا.' },
  };
  const code = codes[status] ?? unknown;
  return {
    status,
    reference,
    sessionId: `SIM-${seedOf(reference).slice(0, 12)}`,
    checkoutUrl: null,
    responseCode: code.responseCode,
    detailedResponseCode: code.detailed,
    message: code.message,
    ...(status === 'approved' ? receiptFields(reference, 'geidea') : { approvalCode: null, rrn: null, stan: null, cardScheme: null, panMasked: null, transactionType: 'Pay' }),
    raw,
  };
}

/** NeoLeap answers in `TransactionResult.StatusCode` — 00 · 01 · 02 — in its own words. */
function neoleapOutcome(reference: string, status: GatewayResult['status'], raw: Record<string, unknown>): GatewayResult {
  const unknown = { responseCode: null, message: 'Unknown Status' };
  const codes: Record<string, { responseCode: string | null; message: string | null }> = {
    approved: { responseCode: '00', message: 'Approved' },
    declined: { responseCode: '01', message: 'Declined' },
    cancelled: { responseCode: '02', message: 'Cancelled or Error' },
    initiated: { responseCode: null, message: null },
    unknown,
    error: { responseCode: null, message: 'تعذّر الوصول إلى بوابة NeoLeap.' },
  };
  const code = codes[status] ?? unknown;
  return {
    status,
    reference,
    sessionId: `SIM-${seedOf(reference).slice(0, 12)}`,
    checkoutUrl: null,
    responseCode: code.responseCode,
    detailedResponseCode: code.responseCode,
    message: code.message,
    ...(status === 'approved' ? receiptFields(reference, 'neoleap') : { approvalCode: null, rrn: null, stan: null, cardScheme: null, panMasked: null, transactionType: 'SALE' }),
    raw,
  };
}

/** 🧪 — what the provider would have answered, without dialling it. */
export function simulatedSale(
  provider: GatewayProvider,
  request: { reference: string; value: string; currency: string },
): GatewayResult {
  const raw: Record<string, unknown> = {
    simulation: true,
    provider,
    request: { merchantReferenceId: request.reference, amount: Number(request.value), currency: request.currency },
  };
  if (simulatedVerdict(request.reference) === 'error') {
    return { ...emptyResult(request.reference, 'error', 'تعذّر الوصول إلى البوابة (🧪 Simulation).'), raw };
  }
  // جيديا opens a page and waits for the cardholder; NeoLeap's terminal answers at once.
  if (provider === 'geidea') return geideaOutcome(request.reference, 'initiated', raw);
  return neoleapOutcome(request.reference, simulatedVerdict(request.reference), raw);
}

/** 🧪 — how a pending جيديا session ended, or «nothing to refresh» for NeoLeap. */
export function simulatedStatus(provider: GatewayProvider, input: { reference: string; sessionId: string | null }): GatewayResult {
  const raw: Record<string, unknown> = { simulation: true, provider, merchantReferenceId: input.reference };
  if (provider !== 'geidea') {
    return { ...emptyResult(input.reference, 'unknown', 'بوابة NeoLeap تُجيب فوراً — لا حالة معلّقة للتحديث.'), sessionId: input.sessionId, raw };
  }
  return { ...geideaOutcome(input.reference, simulatedVerdict(input.reference), raw), sessionId: input.sessionId };
}

/** 🧪 — the two test buttons: a test charge that cannot fail unless the tenant asks it to. */
export function simulatedTest(provider: GatewayProvider, reference: string): GatewayResult {
  const raw: Record<string, unknown> = { simulation: true, provider, test: true, merchantReferenceId: reference };
  if (provider === 'geidea') return geideaOutcome(reference, 'initiated', raw);
  return neoleapOutcome(reference, 'approved', raw);
}
