import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';

import { ECOMMERCE_TRANSPORT } from './ecommerce.tokens.js';
import type { EcommerceProvider, RemoteOrder } from './ecommerce.types.js';

export type EcommerceTransportRequest = {
  provider: EcommerceProvider;
  operation: 'testConnection' | 'listOrders' | 'updateStock';
  token: string;
  storeUrl?: string | null;
  remoteItemId?: string;
  quantity?: string;
};

export type EcommerceTransportResponse = {
  ok: boolean;
  status: number;
  message?: string;
  remoteStoreId?: string;
  orders?: RemoteOrder[];
};

export interface EcommerceTransport {
  request(input: EcommerceTransportRequest): Promise<EcommerceTransportResponse>;
}

/**
 * The deterministic transport used by tests and by a demo store.
 *
 * A credential beginning with `MOCK-FAIL` deliberately fails, while every other
 * `MOCK-` credential returns five orders. It never receives or stores a real token in
 * queue payloads; it is selected only after a decrypted token has been read in the
 * request/worker process.
 */
@Injectable()
export class MockEcommerceTransport implements EcommerceTransport {
  readonly stockUpdates: Array<{ provider: EcommerceProvider; itemId: string; quantity: string }> = [];

  async request(input: EcommerceTransportRequest): Promise<EcommerceTransportResponse> {
    if (!input.token.startsWith('MOCK-')) {
      return { ok: false, status: 401, message: 'Mock transport accepts MOCK-* credentials only' };
    }
    if (input.token.startsWith('MOCK-FAIL')) {
      return { ok: false, status: 401, message: 'Mock access token rejected' };
    }
    if (input.operation === 'testConnection') {
      return { ok: true, status: 200, remoteStoreId: `${input.provider}-mock-store` };
    }
    if (input.operation === 'updateStock') {
      if (!input.remoteItemId) return { ok: false, status: 422, message: 'remoteItemId is required' };
      this.stockUpdates.push({
        provider: input.provider,
        itemId: input.remoteItemId,
        quantity: input.quantity ?? '0',
      });
      return { ok: true, status: 200, message: 'stock updated' };
    }

    const prefix = input.provider.toUpperCase();
    const orders: RemoteOrder[] = Array.from({ length: 5 }, (_, index) => ({
      id: `MOCK-${prefix}-ORDER-${index + 1}`,
      orderNo: `${prefix}-100${index + 1}`,
      status: index === 0 ? 'pending' : 'processing',
      customerName: `عميل ${index + 1}`,
      customerMobile: `050000000${index + 1}`,
      currency: 'SAR',
      total: (120 + index * 10).toFixed(4),
      lines: [
        {
          id: `MOCK-${prefix}-LINE-${index + 1}`,
          name: `طلب ${index + 1}`,
          sku: `MOCK-SKU-${index + 1}`,
          quantity: '1',
          unitPrice: (120 + index * 10).toFixed(4),
        },
      ],
    }));
    return { ok: true, status: 200, remoteStoreId: `${prefix}-mock-store`, orders };
  }
}

/**
 * Production HTTP transport. Provider adapters own endpoint and header differences; this
 * port owns timeouts and JSON parsing so it can be replaced in tests without mocking
 * global fetch.
 */
@Injectable()
export class HttpEcommerceTransport implements EcommerceTransport, OnModuleDestroy {
  private readonly controllers = new Set<AbortController>();

  async request(input: EcommerceTransportRequest): Promise<EcommerceTransportResponse> {
    const target = endpointFor(input);
    if (!target) return { ok: false, status: 422, message: 'storeUrl is required for this provider' };

    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(target.url, {
        method: target.method,
        headers: {
          accept: 'application/json',
          ...(target.method !== 'GET' ? { 'content-type': 'application/json' } : {}),
          ...target.headers(input.token),
        },
        ...(target.body ? { body: JSON.stringify(target.body) } : {}),
        signal: controller.signal,
      });
      const text = await response.text();
      let body: Record<string, unknown> = {};
      if (text) {
        try {
          body = JSON.parse(text) as Record<string, unknown>;
        } catch {
          body = { message: text.slice(0, 500) };
        }
      }
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          message: stringValue(body.message) ?? `Provider returned HTTP ${response.status}`,
        };
      }
      return {
        ok: true,
        status: response.status,
        remoteStoreId:
          stringValue(body.id) ?? stringValue((body.data as Record<string, unknown> | undefined)?.id),
        orders: input.operation === 'listOrders' ? normaliseOrders(body) : undefined,
        message: stringValue(body.message),
      };
    } catch (error) {
      return {
        ok: false,
        status: 502,
        message: error instanceof Error ? error.message.slice(0, 500) : 'Provider request failed',
      };
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }

  onModuleDestroy(): void {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
}

@Injectable()
export class EcommerceProviderRegistry {
  constructor(
    private readonly mock: MockEcommerceTransport,
    @Inject(ECOMMERCE_TRANSPORT) private readonly http: EcommerceTransport,
  ) {}

  /** Provider abstraction boundary. Every service call goes through this client. */
  client(provider: EcommerceProvider, token: string): EcommerceProviderClient {
    return new EcommerceProviderClient(provider, token, token.startsWith('MOCK-') ? this.mock : this.http);
  }
}

export class EcommerceProviderClient {
  constructor(
    private readonly provider: EcommerceProvider,
    private readonly token: string,
    private readonly transport: EcommerceTransport,
  ) {}

  async testConnection(storeUrl?: string | null) {
    return this.transport.request({
      provider: this.provider,
      operation: 'testConnection',
      token: this.token,
      storeUrl,
    });
  }

  async listOrders(storeUrl?: string | null) {
    return this.transport.request({
      provider: this.provider,
      operation: 'listOrders',
      token: this.token,
      storeUrl,
    });
  }

  async updateStock(storeUrl: string | null | undefined, remoteItemId: string, quantity: string) {
    return this.transport.request({
      provider: this.provider,
      operation: 'updateStock',
      token: this.token,
      storeUrl,
      remoteItemId,
      quantity,
    });
  }
}

type Endpoint = {
  url: string;
  method: 'GET' | 'PUT';
  headers: (token: string) => Record<string, string>;
  body?: Record<string, unknown>;
};

function endpointFor(input: EcommerceTransportRequest): Endpoint | undefined {
  const base = input.storeUrl?.replace(/\/+$/, '');
  if (input.provider === 'shopify' && !base) return undefined;

  if (input.provider === 'salla') {
    const api = 'https://api.salla.dev/admin/v2';
    if (input.operation === 'testConnection')
      return { url: `${api}/store/info`, method: 'GET', headers: bearer };
    if (input.operation === 'listOrders') return { url: `${api}/orders`, method: 'GET', headers: bearer };
    return {
      url: `${api}/products/${encodeURIComponent(input.remoteItemId ?? '')}/quantity`,
      method: 'PUT',
      headers: bearer,
      body: { quantity: input.quantity ?? '0' },
    };
  }
  if (input.provider === 'zid') {
    const api = 'https://api.zid.sa/v1/managers/store';
    if (input.operation === 'testConnection') return { url: `${api}`, method: 'GET', headers: bearer };
    if (input.operation === 'listOrders') return { url: `${api}/orders`, method: 'GET', headers: bearer };
    return {
      url: `${api}/products/${encodeURIComponent(input.remoteItemId ?? '')}/quantity`,
      method: 'PUT',
      headers: bearer,
      body: { quantity: input.quantity ?? '0' },
    };
  }
  const api = `${base}/admin/api/2024-01`;
  if (input.operation === 'testConnection')
    return { url: `${api}/shop.json`, method: 'GET', headers: shopifyBearer };
  if (input.operation === 'listOrders')
    return { url: `${api}/orders.json?status=any`, method: 'GET', headers: shopifyBearer };
  return {
    url: `${api}/inventory_levels/set.json`,
    method: 'PUT',
    headers: shopifyBearer,
    body: { inventory_item_id: input.remoteItemId, available: Number(input.quantity ?? 0) },
  };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const shopifyBearer = (token: string) => ({ 'x-shopify-access-token': token });

function normaliseOrders(body: Record<string, unknown>): RemoteOrder[] {
  const candidate = Array.isArray(body.data) ? body.data : Array.isArray(body.orders) ? body.orders : [];
  return candidate
    .map((value) => {
      const row = (value ?? {}) as Record<string, unknown>;
      const customer = (row.customer ?? row.billing_address ?? {}) as Record<string, unknown>;
      const lineRows = Array.isArray(row.items)
        ? row.items
        : Array.isArray(row.line_items)
          ? row.line_items
          : [];
      const lines = lineRows.map((line) => {
        const item = (line ?? {}) as Record<string, unknown>;
        return {
          id: stringValue(item.id),
          name: stringValue(item.name) ?? 'Store item',
          sku: stringValue(item.sku),
          quantity: decimalString(item.quantity ?? item.qty ?? 1),
          unitPrice: decimalString(valueOf(item.price) ?? valueOf(item.amount) ?? '0'),
        };
      });
      return {
        id: stringValue(row.id) ?? stringValue(row.order_id) ?? '',
        orderNo:
          stringValue(row.order_number) ??
          stringValue(row.reference_id) ??
          stringValue(row.order_no) ??
          stringValue(row.number),
        status:
          stringValue(row.status) ??
          stringValue(recordValue(row.status, 'slug')) ??
          stringValue(row.financial_status),
        customerName:
          stringValue(customer.name) ??
          ([stringValue(customer.first_name), stringValue(customer.last_name)].filter(Boolean).join(' ') ||
            undefined),
        customerMobile: stringValue(customer.mobile) ?? stringValue(customer.phone),
        currency: stringValue(row.currency) ?? 'SAR',
        total: decimalString(
          valueOf(row.total) ??
            valueOf(row.amount) ??
            valueOf(row.total_price) ??
            valueOf(recordValue(row.totals, 'total')) ??
            '0',
        ),
        lines: lines.length
          ? lines
          : [{ name: 'Store order', quantity: '1', unitPrice: decimalString(valueOf(row.total) ?? '0') }],
        raw: row,
      } satisfies RemoteOrder;
    })
    .filter((order) => Boolean(order.id));
}

function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function valueOf(value: unknown): unknown {
  if (isRecord(value)) return value.amount ?? value.value ?? value.total;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

function decimalString(value: unknown): string {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number.toFixed(4) : '0.0000';
}
