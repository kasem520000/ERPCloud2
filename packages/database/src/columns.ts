import { boolean, char, customType, integer, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Shared column building blocks — DATABASE_DESIGN §0 global conventions.
 *
 * Primary keys are UUID **v7** generated application-side (PROJECT_CONTRACT §2); the
 * columns therefore carry no DB default. `gen_random_uuid()` is deliberately never used.
 */

/** PostgreSQL `citext` — used for case-insensitive unique emails (DATABASE_DESIGN §1). */
export const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

/** PostgreSQL `bytea` — encrypted-at-rest columns (SECURITY_ARCHITECTURE §9). */
export const bytea = customType<{ data: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/** PostgreSQL `inet` — client address captured on auth events. */
export const inet = customType<{ data: string }>({
  dataType() {
    return 'inet';
  },
});

export function primaryKeyColumn() {
  return uuid('id').primaryKey();
}

/**
 * Audit columns (PROJECT_CONTRACT §7). Present on every table; `version` carries
 * optimistic concurrency (API_ARCHITECTURE §3 → 409 `VERSION_CONFLICT`).
 * Retains the Phase-02 export name.
 */
export function baseAuditColumns() {
  return {
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    updatedBy: uuid('updated_by'),
    version: integer('version').notNull().default(1),
  };
}

/** Soft delete pair — master data only (PROJECT_CONTRACT §5). Retains intent of Phase 02. */
export function baseSoftDeleteColumns() {
  return {
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by'),
  };
}

/**
 * `tenant_id` for tenant-scoped tables. The foreign key to `tenants.id` is declared in
 * each table definition to keep this helper free of schema imports.
 * Retains the Phase-02 export name.
 */
export function baseTenantIdColumn() {
  return {
    tenantId: uuid('tenant_id').notNull(),
  };
}

/** Legacy provenance pair (PROJECT_CONTRACT §1). */
export function baseLegacyColumns() {
  return {
    legacySource: text('legacy_source'),
    legacyId: text('legacy_id'),
  };
}

/** ISO-4217 currency code column, `char(3)`. */
export function currencyCodeColumn(name = 'currency_code') {
  return char(name, { length: 3 });
}

/** Money / quantity column: `numeric(20,4)` serialised as a decimal string (never a JS number). */
export const moneyMode = { mode: 'text' } as const;

/** Convenience flags reused by master-data tables. */
export function booleanFlag(name: string, defaultValue = false) {
  return boolean(name).notNull().default(defaultValue);
}
