-- 0031_mfa.sql
-- Two-factor authentication (TOTP, RFC 6238) — SECURITY_ARCHITECTURE §2.
--
-- `users.mfa_secret_enc` already existed (DESIGN §1) but was never used. This migration
-- adds the missing state: whether the secret is *confirmed* (the user typed a valid code,
-- so 2FA is enforced at login) and a store for one-time recovery codes.
--
-- Both are platform tables on purpose: like `users` and `refresh_tokens` they carry no
-- `tenant_id`, because they belong to the person, not to one tenant, and the login flow
-- must consult them *before* a tenant context exists. The TOTP secret itself is stored
-- AES-256-GCM encrypted (see `apps/api/src/modules/platform/auth/secret-box.ts`); recovery
-- codes are stored only as SHA-256 hashes, exactly like refresh tokens.

ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  /** SHA-256 hex of the normalised code. Plaintext exists only at generation time. */
  code_hash text NOT NULL,
  /** Set when the code is consumed at login; a used code can never be replayed. */
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mfa_recovery_codes_user_idx ON mfa_recovery_codes(user_id);
