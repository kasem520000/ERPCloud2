import { z } from 'zod';

import { DomainError } from './problem.js';
import { errorCodes } from './errors.js';

/**
 * Pagination, sorting and filtering — API_CONTRACT §0 / API_ARCHITECTURE §3.
 * `limit` is 1..200 (default 50); unknown `filter[...]` keys are rejected with
 * `FILTER_NOT_ALLOWED` rather than silently ignored.
 */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export type ListMeta = {
  total: number;
  limit: number;
  offset: number;
};

export type ListEnvelope<T> = {
  data: T[];
  meta: ListMeta;
};

export function listEnvelope<T>(data: T[], meta: ListMeta): ListEnvelope<T> {
  return { data, meta };
}

export function buildMeta(totalValue: number, query: PaginationQuery): ListMeta {
  return { total: totalValue, limit: query.limit, offset: query.offset };
}

/**
 * Validates `filter[...]` query parameters against a per-resource allow-list.
 * Unknown keys → 400 `FILTER_NOT_ALLOWED` (API_ARCHITECTURE §3).
 */
export function parseFilters<T extends string>(
  raw: Record<string, unknown> | undefined,
  allowed: readonly T[],
): Partial<Record<T, string>> {
  const source = (raw ?? {}) as Record<string, unknown>;
  const parsed: Partial<Record<T, string>> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null || value === '') continue;
    if (!allowed.includes(key as T)) {
      throw new DomainError(
        errorCodes.FILTER_NOT_ALLOWED,
        `filter[${key}] is not allowed on this resource`,
        400,
        { field: `filter[${key}]` },
      );
    }
    parsed[key as T] = String(value);
  }
  return parsed;
}

/**
 * Parses `sort=-date,number` into ordered columns, rejecting anything off the
 * allow-list with `FILTER_NOT_ALLOWED`.
 */
export type SortDirection = 'asc' | 'desc';
export type SortClause = { column: string; direction: SortDirection };

export function parseSort(raw: string | undefined, allowed: readonly string[]): SortClause[] {
  if (!raw) return [];
  const clauses: SortClause[] = [];
  for (const entry of raw.split(',')) {
    const token = entry.trim();
    if (token.length === 0) continue;
    const direction: SortDirection = token.startsWith('-') ? 'desc' : 'asc';
    const column = token.replace(/^[-+]/, '');
    if (!allowed.includes(column)) {
      throw new DomainError(errorCodes.FILTER_NOT_ALLOWED, `sort column '${column}' is not allowed`, 400, {
        field: 'sort',
      });
    }
    clauses.push({ column, direction });
  }
  return clauses;
}
