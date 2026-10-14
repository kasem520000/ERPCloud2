/**
 * 🛒 عميل سلة — `Class/SallaAPI.cs` و`Class/ProductsManager.cs` و`Class/OrdersManager.cs`
 * و`Class/CustomersManager.cs`.
 *
 * The desktop's client is four methods over one `HttpClient`:
 *
 *   SallaAPI.cs        `https://api.salla.dev/admin/v2` · Bearer · GET/POST/PUT/DELETE ·
 *                      `throw new Exception($"خطأ في الطلب: {status} - {text}")`
 *   ProductsManager    products · products/{id} · POST products · PUT products/{id} · DELETE products/{id}
 *   OrdersManager      orders · orders/{id} · PUT orders/{id}/status بـ`{ status }`
 *   CustomersManager   customers · customers/{id}
 *   SallaAuth          POST https://accounts.salla.sa/oauth2/token
 *
 * The transport is injected, not hard-wired, for one reason: **the desktop cannot be
 * tested** — `FrmSallah` builds its client with a token written into the source
 * (`new SallaAPI("2adcaba8-c5a8-426c-8fc9-3281fa4b056d")`) and every button talks to the
 * live internet. Here the transport is a function, so tests and the verification script
 * run against an in-memory Salla that behaves like the real one, and production runs
 * against `api.salla.dev` without a single branch in the service above.
 */

/** `SallaAPI._baseUrl` — the admin API, not the merchant site. */
export const SALLA_BASE_URL = 'https://api.salla.dev/admin/v2';
/** `SallaAuth.AuthUrl` — where the code becomes a token. */
export const SALLA_TOKEN_URL = 'https://accounts.salla.sa/oauth2/token';

export type SallaMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
export type SallaRequest = { method: SallaMethod; path: string; body?: unknown; token: string };
export type SallaResponse = { status: number; body: unknown };
export type SallaTransport = (request: SallaRequest) => Promise<SallaResponse>;

/** `SallaAPI` throws `خطأ في الطلب: {status} - {body}` — the sentence is kept verbatim. */
export class SallaRequestError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
  ) {
    const detail = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');
    super(`خطأ في الطلب: ${status} - ${detail}`);
    this.name = 'SallaRequestError';
  }
}

export class SallaClient {
  constructor(
    private readonly token: string,
    private readonly transport: SallaTransport,
  ) {}

  private async call<T = unknown>(method: SallaMethod, path: string, body?: unknown): Promise<T> {
    const response = await this.transport({ method, path, body, token: this.token });
    if (response.status < 200 || response.status >= 300) throw new SallaRequestError(response.status, response.body);
    return response.body as T;
  }

  /** 📦 المنتجات — `ProductsManager`. */
  get products() {
    return {
      list: (query?: string) => this.call<unknown>('GET', query ? `products?${query}` : 'products'),
      get: (remoteId: string) => this.call<unknown>('GET', `products/${remoteId}`),
      create: (data: unknown) => this.call<unknown>('POST', 'products', data),
      update: (remoteId: string, data: unknown) => this.call<unknown>('PUT', `products/${remoteId}`, data),
      remove: (remoteId: string) => this.call<unknown>('DELETE', `products/${remoteId}`),
    };
  }

  /** 📋 الطلبات — `OrdersManager`. */
  get orders() {
    return {
      list: (query?: string) => this.call<unknown>('GET', query ? `orders?${query}` : 'orders'),
      get: (remoteId: string) => this.call<unknown>('GET', `orders/${remoteId}`),
      /** `UpdateOrderStatus` — `PUT orders/{id}/status` بـ`{ status }`. */
      updateStatus: (remoteId: string, status: string) => this.call<unknown>('PUT', `orders/${remoteId}/status`, { status }),
    };
  }

  /** 👥 العملاء — `CustomersManager`. */
  get customers() {
    return {
      list: (query?: string) => this.call<unknown>('GET', query ? `customers?${query}` : 'customers'),
      get: (remoteId: string) => this.call<unknown>('GET', `customers/${remoteId}`),
    };
  }
}

// ─────────────────────────────── the real transport ───────────────────────────────

/** `SallaAPI.GetAsync/PostAsync/PutAsync/DeleteAsync`, over `fetch` instead of `HttpClient`. */
export function createFetchTransport(fetchImpl: typeof fetch = fetch): SallaTransport {
  return async ({ method, path, body, token }) => {
    const response = await fetchImpl(`${SALLA_BASE_URL}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      // A non-JSON body (an HTML error page, a proxy) is reported as text, as SallaAPI does.
    }
    return { status: response.status, body: parsed };
  };
}

// ─────────────────────────────── the in-memory Salla ───────────────────────────────

export type MockProduct = { id: string; name: string; sku: string; price: { amount: number }; quantity: number; status: string; description?: string };
export type MockOrderItem = { name: string; quantity: number; price: { amount: number } };
export type MockOrder = {
  id: string;
  reference_id: number;
  status: { slug: string; name: string };
  date: { date: string };
  totals: { total: { amount: number } };
  customer: { first_name: string; last_name: string; mobile: string };
  items: MockOrderItem[];
};
export type MockCustomer = { id: string; first_name: string; last_name: string; mobile: string; email: string };
export type MockStore = { products: MockProduct[]; orders: MockOrder[]; customers: MockCustomer[] };

/** Two products, two orders, two customers — enough to prove the round trip. */
export function seedMockStore(): MockStore {
  return {
    products: [
      { id: 'MOCK-P-1', name: 'قميص قطني', sku: 'SKU-1', price: { amount: 120 }, quantity: 30, status: 'sale' },
      { id: 'MOCK-P-2', name: 'عباية صيفية', sku: 'SKU-2', price: { amount: 340 }, quantity: 12, status: 'sale' },
    ],
    orders: [
      {
        id: 'MOCK-O-1',
        reference_id: 1001,
        status: { slug: 'pending', name: 'قيد المراجعة' },
        date: { date: '2026-09-01 10:15:00' },
        totals: { total: { amount: 240 } },
        customer: { first_name: 'محمد', last_name: 'الأحمد', mobile: '0551000001' },
        items: [{ name: 'قميص قطني', quantity: 2, price: { amount: 120 } }],
      },
      {
        id: 'MOCK-O-2',
        reference_id: 1002,
        status: { slug: 'pending', name: 'قيد المراجعة' },
        date: { date: '2026-09-02 12:00:00' },
        totals: { total: { amount: 340 } },
        customer: { first_name: 'سارة', last_name: 'العلي', mobile: '0551000002' },
        items: [{ name: 'عباية صيفية', quantity: 1, price: { amount: 340 } }],
      },
    ],
    customers: [
      { id: 'MOCK-C-1', first_name: 'محمد', last_name: 'الأحمد', mobile: '0551000001', email: 'mohammed@example.test' },
      { id: 'MOCK-C-2', first_name: 'سارة', last_name: 'العلي', mobile: '0551000002', email: 'sara@example.test' },
    ],
  };
}

/**
 * A Salla that never leaves the process.
 *
 * Why it exists: `FrmSallah`'s token is a literal in the XAML's code-behind, so the
 * desktop's Salla path can be exercised only against a real store. This transport answers
 * the same paths with the same envelopes (`{ data: … }`), keeps its state between calls (a
 * created product shows up in the next «📦 جلب المنتجات»), and is what the tests and
 * `scripts/verify-salla.mjs` run against.
 */
export function createMockTransport(store: MockStore = seedMockStore()): SallaTransport & { store: MockStore } {
  const ok = (data: unknown) => ({ status: 200, body: { status: 200, success: true, data } });
  const notFound = (what: string) => ({ status: 404, body: { status: 404, success: false, error: { message: `not found: ${what}` } } });

  const transport = async ({ method, path, body }: SallaRequest): Promise<SallaResponse> => {
    const [route, query] = path.split('?');
    const parts = route!.split('/');

    // 📦 المنتجات — `ProductsManager`
    if (parts[0] === 'products') {
      const id = parts[1];
      if (!id) {
        if (method === 'GET') return ok(store.products);
        if (method === 'POST') {
          const input = (body ?? {}) as Partial<MockProduct> & { name?: string; price?: number | { amount: number } };
          const sequence = store.products.length + 1;
          const created: MockProduct = {
            id: `MOCK-P-${sequence}`,
            name: String(input.name ?? `منتج ${sequence}`),
            sku: String(input.sku ?? `SKU-${sequence}`),
            price: { amount: Number(typeof input.price === 'object' ? input.price?.amount : input.price ?? 0) },
            quantity: Number((body as { quantity?: number })?.quantity ?? 0),
            status: 'sale',
            description: (body as { description?: string })?.description,
          };
          store.products.push(created);
          return ok(created);
        }
      } else if (parts[2] === undefined) {
        const found = store.products.find((row) => row.id === id);
        if (!found) return notFound(id);
        if (method === 'GET') return ok(found);
        if (method === 'PUT') {
          const input = (body ?? {}) as Partial<MockProduct>;
          if (input.name !== undefined) found.name = input.name;
          if (input.sku !== undefined) found.sku = input.sku;
          if (input.quantity !== undefined) found.quantity = Number(input.quantity);
          if (input.price !== undefined) found.price = { amount: Number(input.price) };
          return ok(found);
        }
        if (method === 'DELETE') {
          store.products = store.products.filter((row) => row.id !== id);
          return ok({ deleted: true });
        }
      }
    }

    // 📋 الطلبات — `OrdersManager`
    if (parts[0] === 'orders') {
      const id = parts[1];
      if (!id) {
        if (method === 'GET') return ok(store.orders);
      } else if (parts[2] === 'status') {
        const found = store.orders.find((row) => row.id === id);
        if (!found) return notFound(id);
        if (method === 'PUT') {
          const status = String((body as { status?: string })?.status ?? '');
          found.status = { slug: status, name: status };
          return ok(found);
        }
      } else if (parts[2] === undefined) {
        const found = store.orders.find((row) => row.id === id);
        if (!found) return notFound(id);
        return ok(found);
      }
    }

    // 👥 العملاء — `CustomersManager`
    if (parts[0] === 'customers') {
      const id = parts[1];
      if (!id) {
        if (method === 'GET') return ok(store.customers);
      } else {
        const found = store.customers.find((row) => row.id === id);
        if (!found) return notFound(id);
        return ok(found);
      }
    }

    void query;
    return notFound(route!);
  };

  return Object.assign(transport, { store });
}

/**
 * Which transport a connection uses.
 *
 * `SALLA_TRANSPORT=mock` mocks the whole deployment; a **store id that starts with
 * `MOCK-`** mocks that one store. The second is what `scripts/verify-salla.mjs` uses: it
 * connects a store it owns, runs every operation against the in-memory Salla, and deletes
 * the store when it is done — with no credential and no network.
 */
export function isMockStore(storeId: string): boolean {
  return storeId.toUpperCase().startsWith('MOCK-');
}

/**
 * One in-memory store per store id: a product created by «➕ إضافة منتج» must still be
 * there when the next «📦 جلب المنتجات» asks for it.
 */
const mockStores = new Map<string, SallaTransport & { store: MockStore }>();

export function defaultTransport(storeId: string, fetchImpl: typeof fetch = fetch): SallaTransport {
  if (process.env.SALLA_TRANSPORT === 'mock' || isMockStore(storeId)) {
    const key = storeId.toUpperCase();
    const existing = mockStores.get(key);
    if (existing) return existing;
    const created = createMockTransport();
    mockStores.set(key, created);
    return created;
  }
  return createFetchTransport(fetchImpl);
}

/** Tests and teardown: forget a mocked store, so the next run starts from the seed. */
export function resetMockStores(): void {
  mockStores.clear();
}
