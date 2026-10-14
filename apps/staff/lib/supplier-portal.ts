/* global RequestInit */

import { apiBaseUrl } from './api';

const KEY = 'erp.supplier.access';

export type SupplierSession = { token: string };

export function readSupplierSession(): SupplierSession | undefined {
  if (typeof window === 'undefined') return undefined;
  const token = window.localStorage.getItem(KEY);
  return token ? { token } : undefined;
}

export function writeSupplierSession(token: string | undefined) {
  if (typeof window === 'undefined') return;
  if (token) window.localStorage.setItem(KEY, token);
  else window.localStorage.removeItem(KEY);
}

type Problem = { title?: string; detail?: string; code?: string; status?: number };

export class SupplierError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'SupplierError';
    this.status = status;
    this.code = code;
  }
}

export async function supplierFetch<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  if (!headers.has('content-type') && init.body !== undefined) headers.set('content-type', 'application/json');
  headers.set('accept', 'application/json');
  const session = token ?? readSupplierSession()?.token;
  if (session) headers.set('authorization', `Bearer ${session}`);
  const response = await fetch(`${apiBaseUrl}${path}`, { ...init, headers });
  if (!response.ok) {
    let problem: Problem = {};
    const text = await response.text();
    if (text) {
      try {
        problem = JSON.parse(text) as Problem;
      } catch {
        problem = { detail: text.slice(0, 400) };
      }
    }
    throw new SupplierError(response.status, problem.code ?? 'HTTP_ERROR', problem.detail ?? problem.title ?? 'تعذّر إكمال الطلب');
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : undefined;
  if (payload && typeof payload === 'object' && 'data' in (payload as Record<string, unknown>)) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}
