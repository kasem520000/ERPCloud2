import { describe, expect, it } from 'vitest';

import { DENY_LIST, MIN_PASSWORD_LENGTH, evaluatePasswordPolicy } from './password-policy.js';

describe('evaluatePasswordPolicy', () => {
  it('accepts a strong password', () => {
    const result = evaluatePasswordPolicy('Tr0ubador&Horse9', { email: 'owner@demo.test' });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it(`rejects anything shorter than ${MIN_PASSWORD_LENGTH} characters (SECURITY_ARCHITECTURE §2)`, () => {
    const result = evaluatePasswordPolicy('Ab1!');
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('TOO_SHORT');
  });

  it('requires three character classes', () => {
    const lowerOnly = evaluatePasswordPolicy('abcdefghijklmno');
    expect(lowerOnly.issues.map((issue) => issue.code)).toContain('NOT_ENOUGH_CHARACTER_CLASSES');

    const threeClasses = evaluatePasswordPolicy('Abcdefghijkl1');
    expect(threeClasses.issues.map((issue) => issue.code)).not.toContain('NOT_ENOUGH_CHARACTER_CLASSES');
  });

  it('rejects breached passwords even when they are long enough', () => {
    for (const entry of DENY_LIST) {
      const candidate = `${entry}#A1`;
      const result = evaluatePasswordPolicy(candidate);
      expect(
        result.issues.map((issue) => issue.code),
        candidate,
      ).toContain('BREACHED');
    }
  });

  it('rejects passwords containing the user e-mail local part or name', () => {
    const result = evaluatePasswordPolicy('Owner1234!Secure', {
      email: 'owner@demo.test',
      fullName: 'Owner',
    });
    expect(result.issues.map((issue) => issue.code)).toContain('CONTAINS_IDENTIFIER');
  });

  it('rejects over-long passwords before hashing (DoS guard)', () => {
    const result = evaluatePasswordPolicy(`Aa1!${'x'.repeat(400)}`);
    expect(result.issues.map((issue) => issue.code)).toContain('TOO_LONG');
  });
});
