/**
 * Audit redaction — SECURITY_ARCHITECTURE §9 ("never logged", "no PII beyond actor
 * label") applied to the `before`/`after` snapshots of `audit_log`.
 *
 * The same deny-list idea as the pino redaction paths in `@erp/config`, but structural:
 * the audit payload is arbitrary JSON, so every key is matched — at any depth, in
 * objects and in arrays — against the sensitive-name pattern and replaced with a marker
 * instead of being dropped. Keeping the key visible is deliberate: an auditor must be
 * able to see *that* a secret changed without seeing the value.
 */

export const REDACTED_MARKER = '[redacted]';

/**
 * Matches `password`, `passwordHash`, `api_secret`, `mfaSecretEnc`, `token`, … plus any
 * name *ending* in `key` (`DATA_ENC_KEY`, `signingKey`, `privateKey`). The trailing-key
 * rule over-matches by design — a false positive costs one unreadable audit value, a
 * false negative writes a credential into an append-only table. The handful of business
 * columns that legitimately end in `key` are listed below.
 */
const SENSITIVE_KEY =
  /(pass(word)?|secret|token|credential|authorization|hash|mfa|otp|pin|key$)/i;

/** `key` on its own is sensitive, but these business columns merely contain it. */
const SENSITIVE_KEY_ALLOW_LIST = new Set([
  'key', // tenant_settings.key — the setting name, never its value
  'objectkey',
  'object_key',
  'idempotencykey',
  'idempotency_key',
  'foreignkey',
  'sortkey',
]);

const MAX_DEPTH = 8;
const MAX_STRING_LENGTH = 4_000;

export function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_KEY_ALLOW_LIST.has(key.toLowerCase())) return false;
  return SENSITIVE_KEY.test(key);
}

/**
 * Returns a redacted deep copy safe to persist in `audit_log`.
 * `undefined` in, `undefined` out — a missing snapshot must stay SQL NULL.
 */
export function redactAuditPayload(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (depth >= MAX_DEPTH) return REDACTED_MARKER;

  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => redactAuditPayload(entry, depth + 1));

  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
      result[key] = isSensitiveKey(key) ? REDACTED_MARKER : redactAuditPayload(entry, depth + 1);
    }
    return result;
  }

  // functions, symbols, bigint — never part of a DTO; drop rather than guess.
  return null;
}

/**
 * Redacts a single `{ key, value }` pair, which is the shape the typed-settings write
 * path audits (`PUT /settings/{key}`). The *name* is always kept, the value is dropped
 * when the name says it is a secret.
 */
export function redactKeyedValue(key: string, value: unknown): { key: string; value: unknown } {
  return { key, value: isSensitiveKey(key) ? REDACTED_MARKER : redactAuditPayload(value) };
}
