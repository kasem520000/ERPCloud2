import { describe, expect, it } from 'vitest';

import { DomainError, createProblemDetails } from './index.js';

describe('DomainError', () => {
  it('creates a stable problem payload', () => {
    const error = new DomainError('VALIDATION_FAILED', 'bad payload', 400, { field: 'email' });
    const payload = createProblemDetails(error, 'trace-123');

    expect(payload.code).toBe('VALIDATION_FAILED');
    expect(payload.status).toBe(400);
    expect(payload.traceId).toBe('trace-123');
    expect(payload.errors).toEqual([{ field: 'email' }]);
  });
});
