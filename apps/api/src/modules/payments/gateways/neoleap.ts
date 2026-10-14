import { randomUUID } from 'node:crypto';

import {
  emptyResult,
  maskPan,
  type GatewayConfig,
  type GatewayResult,
  type GatewaySaleRequest,
  type PaymentGateway,
} from './types.js';

/**
 * 💳 NeoLeap — the port of `Desktop_ERP/SmartAuditERP/Class/NeoleapService.cs` (165 lines).
 *
 * The desktop builds the request in `ProcessSale` (L23-L36) and reads the answer in
 * `ParseResponse` (L85-L163). Both are quoted here because both are visible in the source;
 * what is **not** visible is the transport: the request goes out through
 * `neoleapconnector.ConnectionManagerFactory`, a compiled library that is not in this
 * repository and cannot be read. What `frmSettings.xaml.cs` does show is its address —
 * the «المنفذ» field (`txtportneoleap`, L2577), i.e. a port on the till's own machine.
 *
 * A server cannot open a socket to a shop's LAN, so the address is configuration
 * (`base_url`, defaulting to `http://127.0.0.1:<المنفذ>`) and the request/answer contract
 * is the one the source file spells out:
 *
 *   POST <base_url>
 *   { "requestType": "SALE", "merchantToken": "…", "amount": 12.34,
 *     "ecrRef": "<guid>", "ecrToken": "", "printFlag": "1", "cashBack": 0 }
 *
 *   { "uuid": "…", "ErrorMsg": "", "TransactionResult": {
 *       "StatusCode": "00", "Amount": { "PurchaseAmount": "12.34" },
 *       "ApprovalCode": "…", "RRN": "…", "STAN": "…",
 *       "CardScheme": { "English": "MADA" }, "PAN": "…",
 *       "TransactionType": { "English": "SALE" } } }
 *
 * `StatusCode` is the desktop's own vocabulary and is kept verbatim:
 *   00 → Approved · 01 → Declined · 02 → Cancelled or Error · anything else → Unknown Status.
 */

/**
 * 🧪 Test — `NeoleapService.TestConnection()` (L54-L83) charges 0.50 against this token,
 * which the desktop hard-codes (L61). It is a *test* credential, published in the source
 * file, and printing is off (`printFlag` "0").
 */
export const NEOLEAP_TEST_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJCZXN0R2FzVGVzdCIsImlhdCI6MTc2NzA4Mjk3Mn0.m1RBo7kgOT3J0qFmeW2oevkgukukEklWw6C4njMfMS4';
/** 🧪 Test — `build.amount = 0.5` (L62). */
export const NEOLEAP_TEST_VALUE = '0.5';

const TIMEOUT_MS = 20_000;

type NeoleapTransactionResult = {
  StatusCode?: string;
  Amount?: { PurchaseAmount?: string | number };
  ApprovalCode?: string;
  RRN?: string;
  STAN?: string;
  CardScheme?: { English?: string; Arabic?: string };
  PAN?: string;
  TransactionType?: { English?: string; Arabic?: string };
};

type NeoleapResponse = {
  uuid?: string;
  ErrorMsg?: string;
  StatusCode?: string;
  TransactionResult?: NeoleapTransactionResult;
};

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const asText = String(value);
  return asText.length > 0 ? asText : null;
}

/**
 * `JObject.Parse(response.Substring(response.IndexOf("{")))` — the connector prefixes its
 * frames with bytes that are not JSON (L91); the desktop cut them off at the first brace
 * and so do we.
 */
export function parseNeoleapResponse(body: string): NeoleapResponse {
  const start = body.indexOf('{');
  const json = start >= 0 ? body.slice(start) : body;
  return JSON.parse(json) as NeoleapResponse;
}

/** The desktop's `switch (text2)` (L118-L136), in its own words. */
const STATUS_WORDS: Record<string, { status: GatewayResult['status']; message: string }> = {
  '00': { status: 'approved', message: 'Approved' },
  '01': { status: 'declined', message: 'Declined' },
  '02': { status: 'cancelled', message: 'Cancelled or Error' },
};

function neoleapBody(request: GatewaySaleRequest, config: GatewayConfig, token: string) {
  return {
    requestType: 'SALE',
    merchantToken: token,
    amount: Number(request.value),
    ecrRef: request.reference,
    ecrToken: '',
    printFlag: request.printReceipt ? '1' : '0',
    cashBack: 0,
    currency: config.currency,
  };
}

export class NeoleapGateway implements PaymentGateway {
  readonly provider = 'neoleap' as const;
  /**
   * The connector answers a SALE there and then — 00 · 01 · 02 — and keeps nothing to ask
   * about afterwards. There is no status call in the source to port, and this module does
   * not invent one.
   */
  readonly queryable = false;

  async sale(request: GatewaySaleRequest, config: GatewayConfig): Promise<GatewayResult> {
    const body = neoleapBody(request, config, config.merchantSecret);
    const raw: Record<string, unknown> = { request: body };
    try {
      const response = await fetch(config.baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const bodyText = await response.text();
      if (!response.ok) {
        return {
          ...emptyResult(request.reference, 'error', `تعذّر الوصول إلى بوابة NeoLeap (HTTP ${response.status}).`),
          raw: { ...raw, httpStatus: response.status, body: bodyText.slice(0, 1000) },
        };
      }
      let payload: NeoleapResponse = {};
      try {
        payload = parseNeoleapResponse(bodyText);
      } catch {
        return {
          ...emptyResult(request.reference, 'error', 'تعذّر الوصول إلى بوابة NeoLeap: ردّ غير مفهوم.'),
          raw: { ...raw, httpStatus: response.status, body: bodyText.slice(0, 1000) },
        };
      }
      Object.assign(raw, payload, { httpStatus: response.status });

      const error = text(payload.ErrorMsg);
      const result = payload.TransactionResult;
      const code = text(result?.StatusCode);
      const verdict = code ? STATUS_WORDS[code] : undefined;

      if (error) {
        // The connector refused the request itself: no card was ever charged.
        return {
          ...emptyResult(request.reference, verdict?.status ?? 'error', error),
          sessionId: text(payload.uuid),
          responseCode: text(payload.StatusCode) ?? code,
          detailedResponseCode: code,
          raw,
        };
      }
      if (!verdict) {
        return {
          ...emptyResult(request.reference, 'unknown', 'Unknown Status'),
          sessionId: text(payload.uuid),
          responseCode: code,
          detailedResponseCode: code,
          raw,
        };
      }

      return {
        status: verdict.status,
        reference: request.reference,
        sessionId: text(payload.uuid),
        checkoutUrl: null,
        responseCode: code,
        detailedResponseCode: code,
        message: verdict.message,
        approvalCode: text(result?.ApprovalCode),
        rrn: text(result?.RRN),
        stan: text(result?.STAN),
        cardScheme: text(result?.CardScheme?.English),
        panMasked: maskPan(result?.PAN),
        transactionType: text(result?.TransactionType?.English),
        raw,
      };
    } catch (error) {
      return {
        ...emptyResult(request.reference, 'error', `تعذّر الوصول إلى بوابة NeoLeap: ${(error as Error).message}`),
        raw: { ...raw, error: String((error as Error).message ?? error) },
      };
    }
  }

  /**
   * The connector has no status call (see `queryable`). A NeoLeap operation is final the
   * moment it is answered, so there is nothing to refresh — the row is returned as it is.
   */
  async status(input: { reference: string; sessionId: string | null }, _config: GatewayConfig): Promise<GatewayResult> {
    return { ...emptyResult(input.reference, 'unknown', 'بوابة NeoLeap تُجيب فوراً — لا حالة معلّقة للتحديث.'), sessionId: input.sessionId };
  }

  /**
   * 🧪 Test — `TestConnection()` (L54-L83): the test token, 0.5, no receipt. «المبلغ» is
   * not honoured: the desktop reads the field (`SafeDouble(txtAmountneoleap.Text, 0)`,
   * L4055) and throws the value away, because the test charge is fixed.
   */
  async test(config: GatewayConfig): Promise<GatewayResult> {
    return this.sale(
      {
        value: NEOLEAP_TEST_VALUE,
        currency: config.currency,
        reference: `TEST-${randomUUID()}`,
        printReceipt: false,
      },
      { ...config, merchantSecret: NEOLEAP_TEST_TOKEN, printReceipt: false },
    );
  }
}
