import type { Server } from 'node:http';

import request from 'supertest';
import type { IsolationHttp, IsolationHttpResponse, TenantActor } from '@erp/testing';

/**
 * supertest adapter for the isolation harness (TESTING_STRATEGY §6). Keeping the harness
 * free of supertest is what lets every later phase reuse it unchanged.
 */
export function createIsolationHttp(server: Server): IsolationHttp {
  const call = async (
    token: string | undefined,
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
    body?: unknown,
  ): Promise<IsolationHttpResponse> => {
    let builder = request(server)[method](path);
    if (token) builder = builder.set('Authorization', `Bearer ${token}`);
    if (body !== undefined) builder = builder.send(body as object);
    const response = await builder;
    return { status: response.status, body: (response.body ?? {}) as unknown };
  };

  return {
    get: (actor: TenantActor, path: string) => call(actor.token, 'get', path),
    post: (actor: TenantActor, path: string, body: unknown) => call(actor.token, 'post', path, body),
    patch: (actor: TenantActor, path: string, body: unknown) => call(actor.token, 'patch', path, body),
    put: (actor: TenantActor, path: string, body: unknown) => call(actor.token, 'put', path, body),
    remove: (actor: TenantActor, path: string) => call(actor.token, 'delete', path),
  };
}

export type ApiCall = {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  /** الرد كما هو نصّاً — يُقرأ به ملف CSV (P-C12) بلا تحويلٍ في الاختبار. */
  text: string;
};

/** Plain supertest helper for the non-isolation suites. */
export async function api(
  server: Server,
  method: 'get' | 'post' | 'patch' | 'put' | 'delete',
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiCall> {
  let builder = request(server)[method](path);
  if (options.token) builder = builder.set('Authorization', `Bearer ${options.token}`);
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    builder = builder.set(name, value);
  }
  if (options.body !== undefined) builder = builder.send(options.body as object);

  const response = await builder;
  return {
    status: response.status,
    body: (response.body ?? {}) as Record<string, unknown>,
    headers: response.headers as Record<string, string>,
    text: response.text ?? '',
  };
}
