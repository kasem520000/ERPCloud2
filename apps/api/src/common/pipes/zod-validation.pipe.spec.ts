import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loginRequestSchema } from '@erp/contracts';

import { ZodValidationException, ZodValidationPipe } from './zod-validation.pipe.js';

describe('ZodValidationPipe', () => {
  it('returns the parsed value when the schema matches', () => {
    const pipe = new ZodValidationPipe(loginRequestSchema);
    const parsed = pipe.transform({
      email: 'Owner@Demo.test',
      password: 'x'.repeat(16),
      tenantCode: 'demo',
    });

    // The pipe trims but does not case-fold; matching is case-insensitive at the
    // database layer because users.email is citext (DATABASE_DESIGN §1).
    expect(parsed.email).toBe('Owner@Demo.test');
    expect(parsed.tenantCode).toBe('demo');
    expect(parsed.mfaCode).toBeUndefined();
  });

  it('rejects unknown keys on writes (mass-assignment defence)', () => {
    const schema = z.object({ name: z.string() }).strict();
    const pipe = new ZodValidationPipe(schema);

    expect(() => pipe.transform({ name: 'ok', tenantId: 'attacker' })).toThrow(ZodValidationException);
  });

  it('carries the zod error so the filter can build the field list', () => {
    const pipe = new ZodValidationPipe(loginRequestSchema);
    try {
      pipe.transform({ email: 'not-an-email', password: 'x', tenantCode: '' });
      throw new Error('expected a validation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ZodValidationException);
      const validationError = error as ZodValidationException;
      expect(validationError.zodError.issues.length).toBeGreaterThan(0);
      expect(validationError.zodError.issues.map((issue) => issue.path[0])).toEqual(
        expect.arrayContaining(['email', 'tenantCode']),
      );
    }
  });
});
