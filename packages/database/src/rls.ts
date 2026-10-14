import { sql } from 'drizzle-orm';

import type { DrizzleDb, DrizzleTx } from './client.js';

/**
 * Row-Level Security helpers — MULTI_TENANCY §3.
 *
 * Every tenant-scoped table gets the same policy. The GUC is transaction-local, so it
 * MUST be set inside the same transaction as the queries that rely on it
 * (`withTenantTx`). `nullif(..., '')` hardens the canonical template: an unset
 * `app.tenant_id` yields SQL NULL, so the policy matches zero rows instead of raising
 * `invalid input syntax for type uuid`.
 */
export const TENANT_GUC = 'app.tenant_id';
export const PLATFORM_ADMIN_GUC = 'app.is_platform_admin';

/** The `USING` / `WITH CHECK` predicate of the canonical tenant policy. */
export const tenantIsolationExpression = `tenant_id = nullif(current_setting('${TENANT_GUC}', true), '')::uuid`;

export function enableRowLevelSecuritySql(table: string): string {
  return `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;\nALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`;
}

/**
 * Idempotent by construction: the policy is dropped and recreated, so re-applying the
 * migration never fails with "policy already exists".
 */
export function createTenantIsolationPolicySql(table: string, policyName = 'tenant_isolation'): string {
  return [
    `DROP POLICY IF EXISTS ${policyName} ON ${table};`,
    `CREATE POLICY ${policyName} ON ${table}`,
    `  USING (${tenantIsolationExpression})`,
    `  WITH CHECK (${tenantIsolationExpression});`,
  ].join('\n');
}

/**
 * RLS for a junction table that has no `tenant_id` of its own: isolation is derived
 * through the owning parent row (`roles` / `memberships`).
 */
export function createParentIsolationPolicySql(
  table: string,
  parentTable: string,
  parentKeyColumn: string,
  policyName = 'tenant_isolation',
): string {
  const expression = `EXISTS (SELECT 1 FROM ${parentTable} AS parent WHERE parent.id = ${table}.${parentKeyColumn} AND parent.${tenantIsolationExpression})`;
  return [
    `DROP POLICY IF EXISTS ${policyName} ON ${table};`,
    `CREATE POLICY ${policyName} ON ${table}`,
    `  USING (${expression})`,
    `  WITH CHECK (${expression});`,
  ].join('\n');
}

/**
 * `audit_log` policy (PHASE_04 §5.1). Reads are strictly tenant-scoped, but writes also
 * have to accept the **platform** rows whose `tenant_id` is NULL: a failed login happens
 * before any tenant context exists (DATABASE_DESIGN §4, "tenant_id NULL (platform
 * events)"). `IS NOT DISTINCT FROM` expresses exactly that — with the GUC unset only a
 * NULL-tenant row may be written, with the GUC set only that tenant's rows may be.
 * Platform rows are therefore write-only for the API role: nothing can read them back
 * through a tenant session.
 */
export function createAuditLogPolicySql(table = 'audit_log', policyName = 'tenant_isolation'): string {
  const guc = `nullif(current_setting('${TENANT_GUC}', true), '')::uuid`;
  return [
    `DROP POLICY IF EXISTS ${policyName} ON ${table};`,
    `CREATE POLICY ${policyName} ON ${table}`,
    `  USING (tenant_id = ${guc})`,
    `  WITH CHECK (tenant_id IS NOT DISTINCT FROM ${guc});`,
  ].join('\n');
}

/**
 * Append-only hardening (SECURITY_ARCHITECTURE §9: "audit log … immutable (no update/
 * delete grants)"). Enforced by privileges rather than a trigger so that even a SQL
 * injection through the API role cannot rewrite history.
 */
export function revokeMutationsSql(table: string, role: string): string {
  return `REVOKE UPDATE, DELETE, TRUNCATE ON ${table} FROM ${role};`;
}

/**
 * Binds the tenant to the current transaction (MULTI_TENANCY §3.3).
 * `is_local = true` → the setting disappears at COMMIT/ROLLBACK, so a pooled connection
 * can never leak a tenant into the next request.
 */
export function setTenantContext(tx: DrizzleDb | DrizzleTx, tenantId: string): Promise<unknown> {
  return tx.execute(sql`SELECT set_config(${TENANT_GUC}, ${tenantId}, true)`);
}

/**
 * Binds the platform-admin flag to the current transaction (MULTI_TENANCY §4). Used by
 * `withPlatformAdminTx`; never call it from a tenant request path.
 */
export function setPlatformAdminContext(tx: DrizzleDb | DrizzleTx, enabled: boolean): Promise<unknown> {
  return tx.execute(sql`SELECT set_config(${PLATFORM_ADMIN_GUC}, ${enabled ? 'on' : 'off'}, true)`);
}

export function clearTenantContext(tx: DrizzleDb | DrizzleTx): Promise<unknown> {
  return tx.execute(sql`SELECT set_config(${TENANT_GUC}, '', true)`);
}

type QueryRows<T> = { rows: T[] } | T[];

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows: T[] }).rows ?? []);
}

/** Reads the GUC of the current transaction — used by the isolation harness probe. */
export async function readTenantContext(tx: DrizzleDb | DrizzleTx): Promise<string | null> {
  const result = await tx.execute(sql`SELECT nullif(current_setting(${TENANT_GUC}, true), '') AS tenant_id`);
  const rows = rowsOf<{ tenant_id: string | null }>(result);
  return rows[0]?.tenant_id ?? null;
}

/** Tables that carry RLS in this phase (kept next to the schema for review). */
export const rlsProtectedTables = [
  'memberships',
  'roles',
  'role_permissions',
  'membership_roles',
  'tenant_settings',
  // PHASE_04 — platform services (DATABASE_DESIGN §3–§4).
  'audit_log',
  'files',
  'notifications',
  'outbox_jobs',
  'idempotency_keys',
  // Future enhancement 03 — provider-neutral e-commerce connections, orders and logs.
  'ecommerce_stores',
  'ecommerce_orders',
  'ecommerce_sync_logs',
  'document_sequences',
  // PHASE_05 — organization (DATABASE_DESIGN §5 + §3 currencies).
  'company_profiles',
  'branches',
  'warehouses',
  'cash_locations',
  'cash_location_balances',
  'currencies',
  'fx_rates',
  'price_lists',
  'price_list_items',
  'branch_posting_profiles',
  // 2026-09 architecture/RBAC reorganisation (migration 0032).
  'devices',
  'membership_role_scopes',
  // Future enhancement 01 — bank feeds and reconciliation.
  'bank_accounts',
  'bank_statements',
  'bank_statement_lines',
  'bank_reconciliation_rules',
  // R17 — printer/report links.
  'printer_report_links',
  // Future enhancement 02 — purchase-invoice OCR jobs and their extracted fields.
  'ocr_jobs',
  // Future enhancement 04 — approval workflow engine (migration 0100).
  'approval_workflows',
  'approval_steps',
  'approval_requests',
  'approval_decisions',
  // Future enhancement 05 — tenant-defined fields, values and saved report definitions.
  'custom_fields',
  'custom_field_values',
  'custom_reports',
  // Future enhancement 06 — durable idempotency ledger for offline POS invoices.
  'offline_queue',
  // Future enhancement 07 — Mudad/GOSI files and online invoice payment links.
  'payroll_compliance_settings',
  'payroll_wps_files',
  'payroll_gosi_files',
  'payment_provider_configs',
  'payment_links',
  // Future enhancement 08 — assistant conversations, settings, usage and suggestions.
  'ai_settings',
  'ai_conversations',
  'ai_usage_logs',
  'ai_suggestions',
  // Future enhancement 09 — mobile attendance, requests and push notices.
  'employee_geofences',
  'employee_attendance',
  'employee_requests',
  'employee_push_subscriptions',
  'employee_push_outbox',
  // Future enhancement 10 — warehouse bins and light manufacturing.
  'warehouse_bins',
  'bin_balances',
  'bin_transfers',
  'boms',
  'bom_lines',
  'manufacturing_orders',
  'manufacturing_moves',
  // Future enhancement 11 — supplier portal and a drawn signature.
  'supplier_portal_users',
  'supplier_portal_sessions',
  'supplier_rfqs',
  'supplier_invoice_uploads',
  'esign_requests',
  'esign_events',
  // Future enhancement 12 — personal BI dashboards.
  'dashboards',
  'dashboard_widgets',
  // Future enhancement 13 — installed apps, custom domains and branding.
  // `marketplace_apps` is a platform catalog (no tenant_id) and is not in this list.
  'tenant_apps',
  'tenant_domains',
  'tenant_branding',
  // Future enhancement 14 — sales pipeline. `crm_settings` is tenant-scoped too.
  'crm_pipelines',
  'crm_deals',
  'crm_activities',
  'crm_whatsapp_templates',
  'crm_settings',
  // Future enhancement 15 — comments on a document head.
  'comments',
  'comment_mentions',
  // Future enhancement 16 — tasks, time and finish-to-start links.
  'project_tasks',
  'project_time_logs',
  'project_dependencies',
] as const;

export type QueryRowsOf<T> = QueryRows<T>;
