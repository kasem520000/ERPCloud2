import { describe, expect, it } from 'vitest';

import {
  createAuditLogPolicySql,
  createParentIsolationPolicySql,
  createTenantIsolationPolicySql,
  enableRowLevelSecuritySql,
  quoteIdent,
  revokeMutationsSql,
  rlsProtectedTables,
  tenantIsolationExpression,
} from './index.js';

describe('RLS SQL builders (MULTI_TENANCY §3.5)', () => {
  it('emits ENABLE + FORCE so even the table owner is subject to the policy', () => {
    expect(enableRowLevelSecuritySql('memberships')).toContain(
      'ALTER TABLE memberships ENABLE ROW LEVEL SECURITY',
    );
    expect(enableRowLevelSecuritySql('memberships')).toContain(
      'ALTER TABLE memberships FORCE ROW LEVEL SECURITY',
    );
  });

  it('hardens the canonical policy with nullif so an unset GUC hides rows instead of erroring', () => {
    expect(tenantIsolationExpression).toBe(
      "tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid",
    );
    const sql = createTenantIsolationPolicySql('roles');
    expect(sql).toContain('DROP POLICY IF EXISTS tenant_isolation ON roles;');
    expect(sql).toContain('CREATE POLICY tenant_isolation ON roles');
    expect(sql).toContain('USING (tenant_id = nullif(');
    expect(sql).toContain('WITH CHECK (tenant_id = nullif(');
  });

  it('derives isolation for junction tables through the owning parent', () => {
    const sql = createParentIsolationPolicySql('role_permissions', 'roles', 'role_id');
    expect(sql).toContain('FROM roles AS parent');
    expect(sql).toContain('parent.id = role_permissions.role_id');
    expect(sql).toContain('parent.tenant_id = nullif(');
  });

  it('lists exactly the tenant-scoped tables created by PHASE_03 through PHASE_05', () => {
    expect([...rlsProtectedTables]).toEqual([
      'memberships',
      'roles',
      'role_permissions',
      'membership_roles',
      'tenant_settings',
      'audit_log',
      'files',
      'notifications',
      'outbox_jobs',
      'idempotency_keys',
      // Future enhancement 03 — provider-neutral e-commerce surfaces.
      'ecommerce_stores',
      'ecommerce_orders',
      'ecommerce_sync_logs',
      'document_sequences',
      // PHASE_05 — organization structure (DATABASE_DESIGN §5 + §3 currencies).
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
      // Future enhancement 02 — purchase-invoice OCR jobs.
      'ocr_jobs',
      // Future enhancement 04 — approval workflow engine.
      'approval_workflows',
      'approval_steps',
      'approval_requests',
      'approval_decisions',
      'custom_fields',
      'custom_field_values',
      'custom_reports',
      'offline_queue',
      'payroll_compliance_settings',
      'payroll_wps_files',
      'payroll_gosi_files',
      'payment_provider_configs',
      'payment_links',
      'ai_settings',
      'ai_conversations',
      'ai_usage_logs',
      'ai_suggestions',
      'employee_geofences',
      'employee_attendance',
      'employee_requests',
      'employee_push_subscriptions',
      'employee_push_outbox',
      'warehouse_bins',
      'bin_balances',
      'bin_transfers',
      'boms',
      'bom_lines',
      'manufacturing_orders',
      'manufacturing_moves',
      'supplier_portal_users',
      'supplier_portal_sessions',
      'supplier_rfqs',
      'supplier_invoice_uploads',
      'esign_requests',
      'esign_events',
      'dashboards',
      'dashboard_widgets',
      'tenant_apps',
      'tenant_domains',
      'tenant_branding',
      'crm_pipelines',
      'crm_deals',
      'crm_activities',
      'crm_whatsapp_templates',
      'crm_settings',
      'comments',
      'comment_mentions',
      'project_tasks',
      'project_time_logs',
      'project_dependencies',
    ]);
  });

  /**
   * PHASE_04 §5.1: `audit_log.tenant_id` is nullable (platform-plane events), so its
   * policy cannot be the canonical one — a NULL tenant would fail `tenant_id = <guc>`
   * on INSERT and the login trail would silently vanish.
   */
  it('lets audit_log write platform rows while keeping reads tenant-scoped', () => {
    const sql = createAuditLogPolicySql();
    expect(sql).toContain('CREATE POLICY tenant_isolation ON audit_log');
    // Reads: strict equality, so a NULL-tenant row is never readable from a tenant session.
    expect(sql).toContain("USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)");
    // Writes: NULL is allowed when (and only when) the GUC is unset.
    expect(sql).toContain('WITH CHECK (tenant_id IS NOT DISTINCT FROM');
  });

  it('revokes every mutation on the append-only table from the API role', () => {
    expect(revokeMutationsSql('audit_log', 'erp_api')).toBe(
      'REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM erp_api;',
    );
  });
});

describe('quoteIdent', () => {
  it('quotes plain identifiers and refuses anything else', () => {
    expect(quoteIdent('erp_api')).toBe('"erp_api"');
    expect(() => quoteIdent('erp_api"; DROP TABLE users; --')).toThrow(/not a plain SQL identifier/);
  });
});
