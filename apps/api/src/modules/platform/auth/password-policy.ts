/**
 * Password policy — SECURITY_ARCHITECTURE §2: "12+ char policy, breach-list check".
 * Pure functions so the rules are unit-testable without Argon2id cost.
 */

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

/**
 * Small offline deny-list. A full breached-password corpus (e.g. HaveIBeenPwned k-anonymity
 * lookup) is an external dependency and is deferred; the port is defined here so the call
 * site does not change. TODO(phase:23): wire the k-anonymity range API behind this port.
 */
export const DENY_LIST: readonly string[] = [
  'password',
  'password123',
  'passw0rd',
  'qwertyuiop',
  '123456789',
  '1234567890',
  'letmein123',
  'welcome123',
  'changeme123',
  'administrator',
  'iloveyou123',
  'abc123456789',
  'saasowner123',
  'erppassword',
];

export type PasswordPolicyIssue = {
  code: 'TOO_SHORT' | 'TOO_LONG' | 'NOT_ENOUGH_CHARACTER_CLASSES' | 'BREACHED' | 'CONTAINS_IDENTIFIER';
  message: string;
};

export type PasswordPolicyResult = {
  ok: boolean;
  issues: PasswordPolicyIssue[];
};

function characterClasses(password: string): number {
  let classes = 0;
  if (/[a-z]/.test(password)) classes += 1;
  if (/[A-Z]/.test(password)) classes += 1;
  if (/[0-9]/.test(password)) classes += 1;
  if (/[^A-Za-z0-9]/.test(password)) classes += 1;
  return classes;
}

export function evaluatePasswordPolicy(
  password: string,
  context: { email?: string; fullName?: string } = {},
): PasswordPolicyResult {
  const issues: PasswordPolicyIssue[] = [];

  if (password.length < MIN_PASSWORD_LENGTH) {
    issues.push({
      code: 'TOO_SHORT',
      message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long`,
    });
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    issues.push({
      code: 'TOO_LONG',
      message: `Password must be at most ${MAX_PASSWORD_LENGTH} characters long`,
    });
  }
  if (characterClasses(password) < 3) {
    issues.push({
      code: 'NOT_ENOUGH_CHARACTER_CLASSES',
      message: 'Password must combine at least three of: lowercase, uppercase, digit, symbol',
    });
  }

  const normalised = password.toLowerCase();
  if (DENY_LIST.some((entry) => normalised.includes(entry))) {
    issues.push({ code: 'BREACHED', message: 'Password appears in a known breached-password list' });
  }

  for (const identifier of [context.email?.split('@')[0], context.fullName]) {
    const token = identifier?.trim().toLowerCase();
    if (token && token.length >= 4 && normalised.includes(token)) {
      issues.push({
        code: 'CONTAINS_IDENTIFIER',
        message: 'Password must not contain your e-mail address or name',
      });
      break;
    }
  }

  return { ok: issues.length === 0, issues };
}
