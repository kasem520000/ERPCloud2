import { describe, expect, it } from 'vitest';

import { DomainError } from './problem.js';
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  buildMeta,
  listEnvelope,
  paginationQuerySchema,
  parseFilters,
  parseSort,
} from './pagination.js';

describe('pagination', () => {
  it('defaults to limit 50 / offset 0 and caps the page size at 200 (API_ARCHITECTURE §3)', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: DEFAULT_PAGE_LIMIT, offset: 0 });
    expect(DEFAULT_PAGE_LIMIT).toBe(50);
    expect(MAX_PAGE_LIMIT).toBe(200);
    expect(() => paginationQuerySchema.parse({ limit: 201 })).toThrow();
    expect(() => paginationQuerySchema.parse({ limit: 0 })).toThrow();
    expect(() => paginationQuerySchema.parse({ offset: -1 })).toThrow();
    expect(paginationQuerySchema.parse({ limit: '25', offset: '10' })).toEqual({ limit: 25, offset: 10 });
  });

  it('builds the frozen list envelope { data, meta: { total, limit, offset } }', () => {
    const envelope = listEnvelope([{ id: 1 }], buildMeta(120, { limit: 50, offset: 0 }));
    expect(envelope).toEqual({ data: [{ id: 1 }], meta: { total: 120, limit: 50, offset: 0 } });
  });
});

describe('parseFilters', () => {
  const allowed = ['status', 'kind'] as const;

  it('keeps allow-listed filters and drops empty ones', () => {
    expect(parseFilters({ status: 'posted', kind: '' }, allowed)).toEqual({ status: 'posted' });
  });

  it('rejects an unknown filter with FILTER_NOT_ALLOWED (not a silent ignore)', () => {
    try {
      parseFilters({ secretColumn: 'x' }, allowed);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('FILTER_NOT_ALLOWED');
      expect((error as DomainError).status).toBe(400);
    }
  });
});

describe('parseSort', () => {
  const allowed = ['date', 'number'];

  it('parses the -column syntax into ordered clauses', () => {
    expect(parseSort('-date,number', allowed)).toEqual([
      { column: 'date', direction: 'desc' },
      { column: 'number', direction: 'asc' },
    ]);
    expect(parseSort(undefined, allowed)).toEqual([]);
  });

  it('rejects a column outside the allow-list', () => {
    expect(() => parseSort('-password', allowed)).toThrowError(DomainError);
  });
});
