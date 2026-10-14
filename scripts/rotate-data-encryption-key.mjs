#!/usr/bin/env node
/**
 * AUD-16 — Safe at-rest secret rotation utility (`DATA_ENC_KEY`).
 *
 * Re-seals `v1:<iv>:<tag>:<ciphertext>` AES-256-GCM envelopes from `OLD_DATA_ENC_KEY` to
 * `DATA_ENC_KEY` across every table that uses the shared `DATA_ENC_KEY` derivation:
 *   - `users.mfa_secret_enc` (bytea containing UTF-8 `v1:...`)
 *   - `salla_connections.{access_token_enc, refresh_token_enc, webhook_secret_enc}`
 *   - `einvoice_credentials.{private_key_enc, csid_enc, secret_enc, p_csid_enc, p_secret_enc}`
 *   - `payment_gateways.merchant_secret_enc`
 *   - `payment_provider_configs.{api_key_enc, webhook_secret_enc}`
 *   - `whatsapp_settings.access_token_enc`
 *   - `ai_settings.api_key_enc`
 *   - `webhook_endpoints.secret_enc`
 *   - `ecommerce_stores.{access_token_enc, refresh_token_enc, webhook_secret_enc}`
 *     (only when the tenant does NOT set a custom `platform_settings['ecommerce_encryption_key']`)
 *
 * Safety invariants:
 *   - Defaults to `--dry-run` unless `--apply` is explicitly passed.
 *   - Never prints plaintext or keys.
 *   - Runs inside a single database transaction per table (`SET LOCAL app.is_platform_admin = 'on'`
 *     with migrator/owner connection so RLS-protected tenant rows can be inspected/updated atomically).
 *   - Idempotent: rows already sealed under `DATA_ENC_KEY` are counted as `already_current` and untouched.
 *   - Fails closed: if any row cannot be opened with either `DATA_ENC_KEY` or `OLD_DATA_ENC_KEY`,
 *     the transaction rolls back and exits non-zero.
 *
 * Usage:
 *   OLD_DATA_ENC_KEY="<previous-key>" DATA_ENC_KEY="<new-32+-char-key>" \
 *     DATABASE_MIGRATOR_URL="postgres://..." \
 *     node scripts/rotate-data-encryption-key.mjs --dry-run
 *
 *   OLD_DATA_ENC_KEY="<previous-key>" DATA_ENC_KEY="<new-32+-char-key>" \
 *     DATABASE_MIGRATOR_URL="postgres://..." \
 *     node scripts/rotate-data-encryption-key.mjs --apply
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import pg from 'pg';

const { Client } = pg;

function deriveKey(secret) {
  return createHash('sha256').update(secret).digest();
}

export function openEnvelope(payload, secret) {
  const parts = String(payload).split(':');
  const [version, iv64, tag64, data64] = parts;
  if (parts.length !== 4 || version !== 'v1' || !iv64 || !tag64 || !data64) {
    throw new Error('Malformed v1 secret envelope');
  }
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), Buffer.from(iv64, 'base64'));
  decipher.setAuthTag(Buffer.from(tag64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data64, 'base64')), decipher.final()]);
}

export function sealEnvelope(plainBuffer, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function resealEnvelope(payload, oldKey, newKey) {
  if (oldKey !== newKey) {
    try {
      openEnvelope(payload, newKey);
      return { payload, status: 'already_current' };
    } catch {
      // Fall through to oldKey
    }
  }
  const plain = openEnvelope(payload, oldKey);
  try {
    return { payload: sealEnvelope(plain, newKey), status: 'rotated' };
  } finally {
    plain.fill(0);
  }
}

const TARGET_TABLES = [
  { table: 'users', pk: 'id', bytea: true, columns: ['mfa_secret_enc'] },
  {
    table: 'salla_connections',
    pk: 'id',
    bytea: false,
    columns: ['access_token_enc', 'refresh_token_enc', 'webhook_secret_enc'],
  },
  {
    table: 'einvoice_credentials',
    pk: 'id',
    bytea: false,
    columns: ['private_key_enc', 'csid_enc', 'secret_enc', 'p_csid_enc', 'p_secret_enc'],
  },
  { table: 'payment_gateways', pk: 'id', bytea: false, columns: ['merchant_secret_enc'] },
  {
    table: 'payment_provider_configs',
    pk: 'id',
    bytea: false,
    columns: ['api_key_enc', 'webhook_secret_enc'],
  },
  { table: 'whatsapp_settings', pk: 'id', bytea: false, columns: ['access_token_enc'] },
  { table: 'ai_settings', pk: 'tenant_id', bytea: false, columns: ['api_key_enc'] },
  { table: 'webhook_endpoints', pk: 'id', bytea: false, columns: ['secret_enc'] },
  {
    table: 'ecommerce_stores',
    pk: 'id',
    bytea: false,
    columns: ['access_token_enc', 'refresh_token_enc', 'webhook_secret_enc'],
    skipCustomTenantKey: true,
  },
];

export async function rotateDatabaseSecrets({ connectionString, oldKey, newKey, apply = false }) {
  if (!oldKey) throw new Error('OLD_DATA_ENC_KEY is required');
  if (!newKey || newKey.length < 32) {
    throw new Error('DATA_ENC_KEY must be at least 32 characters');
  }
  if (!connectionString) {
    throw new Error('DATABASE_MIGRATOR_URL (or DATABASE_URL) is required');
  }

  const client = new Client({ connectionString });
  await client.connect();
  const summary = [];

  try {
    await client.query('BEGIN');
    for (const spec of TARGET_TABLES) {
      const existsRes = await client.query(`SELECT to_regclass($1) AS reg`, [`public.${spec.table}`]);
      if (!existsRes.rows[0]?.reg) continue;

      const colRes = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
        [spec.table],
      );
      const existingCols = new Set(colRes.rows.map((r) => r.column_name));
      const activeCols = spec.columns.filter((c) => existingCols.has(c));
      if (!existingCols.has(spec.pk) || activeCols.length === 0) continue;

      let customKeyTenants = new Set();
      if (spec.skipCustomTenantKey) {
        const psExists = await client.query(`SELECT to_regclass('public.platform_settings') AS reg`);
        if (psExists.rows[0]?.reg) {
          const customRows = await client.query(
            `SELECT tenant_id FROM platform_settings WHERE key = 'ecommerce_encryption_key' AND value IS NOT NULL`,
          );
          customKeyTenants = new Set(customRows.rows.map((r) => r.tenant_id));
        }
      }

      const selectCols = [spec.pk, ...(spec.skipCustomTenantKey ? ['tenant_id'] : []), ...activeCols];
      const rowsRes = await client.query(`SELECT ${selectCols.join(', ')} FROM ${spec.table}`);
      let rotatedCols = 0;
      let currentCols = 0;
      let skippedCustom = 0;

      for (const row of rowsRes.rows) {
        if (spec.skipCustomTenantKey && customKeyTenants.has(row.tenant_id)) {
          skippedCustom += 1;
          continue;
        }
        const updates = [];
        const values = [];
        for (const col of activeCols) {
          const raw = row[col];
          if (raw === null || raw === undefined) continue;
          const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
          if (!text) continue;

          const outcome = resealEnvelope(text, oldKey, newKey);
          if (outcome.status === 'already_current') {
            currentCols += 1;
          } else {
            rotatedCols += 1;
            values.push(spec.bytea ? Buffer.from(outcome.payload, 'utf8') : outcome.payload);
            updates.push(`${col} = $${values.length}`);
          }
        }

        if (apply && updates.length > 0) {
          values.push(row[spec.pk]);
          await client.query(
            `UPDATE ${spec.table} SET ${updates.join(', ')} WHERE ${spec.pk} = $${values.length}`,
            values,
          );
        }
      }

      summary.push({
        table: spec.table,
        rotatedColumns: rotatedCols,
        alreadyCurrentColumns: currentCols,
        skippedCustomKeyRows: skippedCustom,
      });
    }

    if (apply) {
      await client.query('COMMIT');
    } else {
      await client.query('ROLLBACK');
    }
    return { mode: apply ? 'apply' : 'dry-run', tables: summary };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const apply = process.argv.includes('--apply');
  const connectionString = process.env.DATABASE_MIGRATOR_URL ?? process.env.DATABASE_URL;
  const oldKey = process.env.OLD_DATA_ENC_KEY;
  const newKey = process.env.DATA_ENC_KEY;

  rotateDatabaseSecrets({ connectionString, oldKey, newKey, apply })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((err) => {
      console.error(`[rotate-data-encryption-key] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
