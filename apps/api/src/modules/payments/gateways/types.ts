/**
 * 💳 بوابات الدفع — the interface behind «إعدادات جيديا» and GroupBox «NeoLeap» of
 * `Desktop_ERP/SmartAuditERP/Form_WPF/frmSettings.xaml` (L1726-L1831).
 *
 * The desktop has no interface: `frmPOSBill.xaml.cs` L460-L492 calls
 * `Geidea.ConnectGeidea(...)` when `MainSetting.IsGediaActive` is false and
 * `GeideaPament.Pay(...)` when it is true, `frmPOSPay.xaml.cs` L428-L441 calls the first
 * of the two, and `NeoleapService` hides its transport inside the compiled
 * `neoleapconnector` library. Three callers, three shapes, one question each: **did the
 * card pay?** This module names that question once so the service, the tests and the
 * 🧪 simulator can all be written against the same answer.
 *
 * The vocabulary is the desktop's own:
 *   - `approved` · `declined` · `cancelled` are `TransactionResult.StatusCode` 00 · 01 ·
 *     02 of `NeoleapService.ParseResponse` (L118-L136);
 *   - `unknown` is its `default:` branch («Unknown Status»);
 *   - `initiated` is the one state the desktop never had — a hosted page the cardholder
 *     has not finished paying on yet (`Geidea` sessions, `frmSettings.xaml.cs` L2498);
 *   - `error` is «we never reached the gateway», which the desktop hid behind an empty
 *     five-byte `rspCode` and a «العملية مرفوضة، يرجى إعادة الدفع» message box
 *     (`frmPOSBill.xaml.cs` L471-L475).
 */

export type GatewayProvider = 'geidea' | 'neoleap';

/** What one 💳 press needs: the money, the reference that makes it idempotent, the receipt flag. */
export type GatewaySaleRequest = {
  /** Decimal string, two decimals on the wire — the desktop sent `Payment * 100` halalas. */
  value: string;
  currency: string;
  /** `ecrRef` (NeoLeap) · `merchantReferenceId` (Geidea) — our idempotency key. */
  reference: string;
  /** طباعة ايصال / طباعة إيصال NeoLeap → `printFlag` 1/0. */
  printReceipt: boolean;
  /** Geidea `callbackUrl`. */
  callbackUrl?: string;
};

export type GatewayConfig = {
  provider: GatewayProvider;
  /** Where the gateway is dialled. Empty means «not configured». */
  baseUrl: string;
  /** Geidea merchant public key · NeoLeap tranportal id — travels in the request. */
  merchantKey: string;
  /** Geidea API password · NeoLeap merchant token — decrypted, never returned. */
  merchantSecret: string;
  currency: string;
  printReceipt: boolean;
  callbackUrl: string;
  /** المنفذ — kept for the record; the desktop dialled it directly. */
  port: number | null;
  /** 🧪 Simulation — answer locally instead of dialling. */
  simulation: boolean;
};

export type GatewayResult = {
  status: 'initiated' | 'approved' | 'declined' | 'cancelled' | 'unknown' | 'error';
  reference: string;
  /** Geidea `session.id` / `orderId` · NeoLeap `uuid`. */
  sessionId: string | null;
  /** Geidea's hosted page — what the cashier opens to let the cardholder pay. */
  checkoutUrl: string | null;
  /** Geidea `responseCode` · NeoLeap `StatusCode`. */
  responseCode: string | null;
  /** Geidea `detailedResponseCode` / `detailedStatus`. */
  detailedResponseCode: string | null;
  /** `responseMessage` · `detailedResponseMessage` · Approved / Declined / Cancelled or Error. */
  message: string | null;
  approvalCode: string | null;
  rrn: string | null;
  stan: string | null;
  cardScheme: string | null;
  /** Never stored in full — `****` + the last four digits, as the receipt prints it. */
  panMasked: string | null;
  transactionType: string | null;
  /** The gateway's own answer, verbatim: a disputed card is argued about with its words. */
  raw: Record<string, unknown>;
};

export interface PaymentGateway {
  readonly provider: GatewayProvider;
  /** True when the provider keeps a pending operation we can ask about later. */
  readonly queryable: boolean;
  /** 💳 — one sale. */
  sale(request: GatewaySaleRequest, config: GatewayConfig): Promise<GatewayResult>;
  /** 🔄 — ask the gateway again about an operation that is still `initiated`. */
  status(input: { reference: string; sessionId: string | null }, config: GatewayConfig): Promise<GatewayResult>;
  /**
   * 🧪 TEST / 🧪 Test — the desktop's two test buttons. `value` is «المبلغ» on the جيديا
   * card (0.01 by default); NeoLeap ignores it because `TestConnection()` hard-codes 0.50.
   */
  test(config: GatewayConfig, value?: string): Promise<GatewayResult>;
}

/** `****1234` — the only form in which a card number ever leaves this module. */
export function maskPan(pan?: string | null): string | null {
  const digits = String(pan ?? '').replace(/\D+/g, '');
  if (digits.length === 0) return null;
  return `****${digits.slice(-4)}`;
}

/** `**` + the last four characters of a secret, as «إعدادات الربط الضريبي» shows a CSID. */
export function maskSecret(plain?: string | null): string | null {
  if (!plain) return null;
  return `****${plain.slice(-4)}`;
}

export function emptyResult(reference: string, status: GatewayResult['status'], message: string): GatewayResult {
  return {
    status,
    reference,
    sessionId: null,
    checkoutUrl: null,
    responseCode: null,
    detailedResponseCode: null,
    message,
    approvalCode: null,
    rrn: null,
    stan: null,
    cardScheme: null,
    panMasked: null,
    transactionType: null,
    raw: {},
  };
}
