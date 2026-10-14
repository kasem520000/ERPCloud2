import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { REDACTED_LOG_PATHS } from '@erp/config';

/**
 * PHASE_03 §8: "no password/refresh value ever logged (redaction test)".
 * The test drives the *real* pino configuration the application uses, not a copy.
 */
function captureLog(payload: unknown): string {
  const lines: string[] = [];
  const logger = pino(
    { redact: { paths: [...REDACTED_LOG_PATHS], censor: '[redacted]' } },
    { write: (chunk: string) => lines.push(chunk) },
  );
  logger.info(payload as object, 'auth event');
  return lines.join('\n');
}

describe('log redaction', () => {
  it('redacts login credentials while keeping non-secret context', () => {
    const output = captureLog({
      email: 'owner@demo.test',
      password: 'Tr0ubador&Horse9',
      tenantCode: 'demo',
    });

    expect(output).not.toContain('Tr0ubador&Horse9');
    expect(output).toContain('[redacted]');
    expect(output).toContain('owner@demo.test');
    expect(output).toContain('demo');
  });

  it('redacts issued tokens in nested payloads', () => {
    const output = captureLog({
      data: {
        accessToken: 'eyJhbGciOiJSUzI1NiJ9.payload.signature',
        refreshToken: 'xk4t-rotating-refresh-value',
        user: { id: 'u1' },
      },
    });

    expect(output).not.toContain('eyJhbGciOiJSUzI1NiJ9');
    expect(output).not.toContain('xk4t-rotating-refresh-value');
    expect(output).toContain('"user"');
  });

  it('redacts the Authorization header and password-change fields', () => {
    const output = captureLog({
      req: { headers: { authorization: 'Bearer super-secret-token' } },
      body: { current: 'OldPassword123!', new: 'NewPassword456!' },
    });

    expect(output).not.toContain('super-secret-token');
    expect(output).not.toContain('OldPassword123!');
    expect(output).not.toContain('NewPassword456!');
  });
});
