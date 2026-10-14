/**
 * RBAC role catalogue — 2026-09 architecture/RBAC reorganisation
 * (docs/architecture-rbac/03-roles-permissions-matrix.md).
 *
 * Three independent role families that must never mix:
 *
 *   A. Platform roles — live in `platform_memberships`, grant `console.*`
 *      permissions, have no tenant. Checked by `PlatformAdminGuard` /
 *      `@RequiresPlatformRole`. The legacy `users.is_platform_admin` flag is
 *      equivalent to holding `platform_owner` and is kept only for
 *      compatibility (migration 0032 backfills it into `platform_memberships`).
 *
 *   B. Tenant administration roles — ordinary tenant roles (`roles` table)
 *      whose permission sets cover tenant self-administration (`tenant.*`,
 *      `organization.*`, `settings.*`, …). A `tenant_owner` controls **its own
 *      tenant only**: the `*` wildcard never grants `console.*`, and the
 *      platform console is unreachable without a platform membership.
 *
 *   C. ERP functional roles — ordinary tenant roles for day-to-day ERP work.
 *      A membership may hold several roles; the effective set is their UNION
 *      (DATABASE_DESIGN §2). Per-role scoping (branch / warehouse / cash
 *      location / POS terminal) is stored in `membership_role_scopes` and
 *      published on the request context.
 *
 * This file is the single source of the *default* permission sets. Tenants may
 * customise families B and C freely through the role editor; family A is managed
 * only from the platform console by `console.users.manage` holders.
 */

export type PlatformRoleCode =
  'platform_owner' | 'platform_operations' | 'platform_billing' | 'platform_support' | 'platform_auditor';

export type TenantAdminRoleCode =
  'tenant_owner' | 'tenant_admin' | 'branch_manager' | 'device_manager' | 'security_admin' | 'tenant_auditor';

export type ErpFunctionalRoleCode =
  | 'accountant'
  | 'sales_manager'
  | 'sales_user'
  | 'purchase_manager'
  | 'purchase_user'
  | 'inventory_manager'
  | 'warehouse_user'
  | 'cashier'
  | 'treasury_user'
  | 'hr_manager'
  | 'project_manager'
  | 'auditor'
  | 'report_viewer';

export type RoleCatalogEntry = {
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly description: string;
  /** `console.*` for platform roles, tenant codes (or `*`) otherwise. */
  readonly permissions: readonly string[];
};

/** Family A — platform roles (stored in `platform_memberships`, no tenant). */
export const platformRoleCatalog: readonly RoleCatalogEntry[] = [
  {
    code: 'platform_owner',
    nameAr: 'مالك المنصة',
    nameEn: 'Platform owner',
    description: 'Full control of the SaaS platform: tenants, billing, plans, users, support.',
    permissions: [
      'console.tenants.view',
      'console.tenants.manage',
      'console.subscriptions.manage',
      'console.plans.manage',
      'console.activation.review',
      'console.users.view',
      'console.users.manage',
      'console.audit.view',
      'console.health.view',
      'console.jobs.view',
      // P-C9: مالك المنصة يعيد ويُلغي كمثل ما يقرأ.
      'console.jobs.manage',
      'console.billing.manage',
      'console.support.manage',
      // P-C1: the platform's own configuration belongs to the owner of the platform.
      // Operations reads it under `console.tenants.view`; nobody else writes it.
      'console.settings.manage',
      'console.marketplace.manage',
      // P-C6: the mail service is operated daily — the owner holds it like everything else.
      'console.email.view',
      'console.email.manage',
      // P-C7: announcements are the platform speaking to its customers — owner and operations.
      'console.notifications.manage',
      // P-C10: the backups, the retention windows and a data-subject request are the
      // platform's own obligations — the owner answers for them.
      'console.backups.manage',
      // P-C11: an integration credential and an outbound webhook are the platform's
      // standing promises to a customer — the owner answers for both.
      'console.apikeys.manage',
      'console.webhooks.manage',
      // P-C12: أرقام المنصة هي ما يُقرأ قبل أي قرار — والمالك أوّل من يقرؤها.
      'console.analytics.view',
      // P-M5: كلمات الموقع التسويقي قرارُ المنصّة على السوق — للمالك وحده فعلُ نشرها.
      'console.content.view',
      'console.content.manage',
      // P-M6: العميل المتوقَّع مالٌ لم يصل بعد — وتحويله يُنشئ منشأةً كاملة، فالرمزان للمالك.
      'console.leads.view',
      'console.leads.manage',
      // P-M7: الحملة تكتب في بريد أشخاصٍ حقيقيين باسم المنصة — والمالك وحده يحمل رمزها.
      'console.campaigns.manage',
    ],
  },
  {
    code: 'platform_operations',
    nameAr: 'تشغيل المنصة',
    nameEn: 'Platform operations',
    description: 'Day-to-day platform operations and health monitoring. No billing, no user grants.',
    permissions: [
      'console.tenants.view',
      'console.audit.view',
      'console.health.view',
      'console.jobs.view',
      // P-C9: تشغيل الطابور عملُ التشغيل اليومي — يعيد المحاولة ويُلغي بسببه.
      'console.jobs.manage',
      // P-C6: queued mail is production queue health, so operations can act on it.
      'console.email.view',
      'console.email.manage',
      // P-C7: operations owns the maintenance window, so it owns the notice about it.
      'console.notifications.manage',
      // P-C10: running tonight's backup and keeping the retention windows are ops work.
      // The auditor and the billing/support desks do not get it: it erases bytes and identities.
      'console.backups.manage',
      // P-C11: تكاملُ العميل عملُ تشغيلٍ يوميّ (مفتاحٌ تعطّل، أو عنوانٌ توقّف عن الإجابة).
      // ولا يُعطى للدعم: الدعم يتكلّم مع العميل في التذكرة، لا يُنشئ له اعتماداً.
      'console.apikeys.manage',
      'console.webhooks.manage',
      // P-C12: التشغيل يرى القمع والتنبيهات و«من صمت» — وهي عملُه اليوميّ قبل أن تكون تقريراً.
      'console.analytics.view',
      // P-M5: **قراءةٌ لا كتابة**: التشغيل يرى ما سيُنشر ليبلغه في التذكرة، ولا يحرّر هوية
      // المنصّة على السوق — وهذا ما يجعل رمزين لا رمزاً.
      'console.content.view',
      // P-M6: التشغيل يرى ما وصل من الموقع ليوجّهه، ولا يحوّل طلباً إلى منشأة (فعلُ فوترة).
      'console.leads.view',
    ],
  },
  {
    code: 'platform_billing',
    nameAr: 'فوترة المنصة',
    nameEn: 'Platform billing',
    description: 'Subscriptions, plans, activation reviews and dunning. No tenant mutation.',
    permissions: [
      'console.tenants.view',
      'console.subscriptions.manage',
      'console.plans.manage',
      'console.activation.review',
      'console.billing.manage',
      // P-C6: invoices are sent by mail — billing reads the log, never sends.
      'console.email.view',
      // P-C12: التسرّب والتحصيل والقيمة الشهرية أرقامُ فوترةٍ قبل أن تكون رسوماً.
      'console.analytics.view',
      // P-M6: التحويل إلى منشأة قرارُ فوترة (باقةٌ وتجربةٌ وترخيص) — ومعها القراءة.
      'console.leads.view',
      'console.leads.manage',
    ],
  },
  {
    code: 'platform_support',
    nameAr: 'دعم المنصة',
    nameEn: 'Platform support',
    description: 'Customer support with read-only tenant visibility and ticket handling.',
    permissions: [
      'console.tenants.view',
      'console.health.view',
      'console.support.manage',
      // P-C6: support answers «لم يصلني البريد» — needs the log, not the templates.
      'console.email.view',
      // P-M5: الدعم يقرأ مقال المساعدة الذي يرسله للعميل في تذكرته.
      'console.content.view',
      // P-M6: من يجيب على الاستفسار يقرأ الطلب — **قراءةً لا تصرّفاً**.
      'console.leads.view',
    ],
  },
  {
    code: 'platform_auditor',
    nameAr: 'مدقق المنصة',
    nameEn: 'Platform auditor',
    description: 'Read-only oversight across tenants, audit trail, health and queues.',
    permissions: [
      'console.tenants.view',
      'console.audit.view',
      'console.health.view',
      'console.jobs.view',
      // P-C6: reading what the platform sent is oversight.
      'console.email.view',
      // P-C12: الأرقام المجمّعة تقرأها الرقابة بلا صلاحية تغييرٍ واحدة — قراءةٌ خالصة.
      'console.analytics.view',
      // P-M6: بياناتُ أشخاصٍ حقيقيين وصلت من الموقع — الرقابة تقرؤها ولا تُبدّلها.
      'console.leads.view',
    ],
  },
] as const;

/** Family B — tenant administration roles (per-tenant, `roles` table). */
export const tenantAdminRoleCatalog: readonly RoleCatalogEntry[] = [
  {
    code: 'tenant_owner',
    nameAr: 'مالك المنشأة',
    nameEn: 'Tenant owner',
    description:
      'Full control of ONE tenant (branches, users, roles, settings). Has no platform access: `*` never grants `console.*`.',
    permissions: ['*'],
  },
  {
    code: 'tenant_admin',
    nameAr: 'مدير المنشأة',
    nameEn: 'Tenant administrator',
    description: 'Tenant configuration and user management without file-level operations.',
    permissions: [
      'tenant.view',
      'tenant.manage',
      'tenant.membership.manage',
      'tenant.settings.manage',
      'tenant.apps.manage',
      'crm.deals.view',
      'crm.deals.manage',
      'crm.activities.manage',
      'comment.view',
      'comment.manage',
      'tenant.audit.view',
      'tenant.file.upload',
      'tenant.file.manage',
      'tenant.notification.view',
      'tenant.notification.manage',
      'tenant.job.view',
      'organization.branch.view',
      'organization.branch.manage',
      'organization.warehouse.view',
      'organization.warehouse.manage',
      'organization.cashlocation.view',
      'organization.cashlocation.manage',
      'organization.currency.view',
      'organization.currency.manage',
      'organization.priceList.view',
      'organization.priceList.manage',
      'organization.postingprofile.view',
      'organization.postingprofile.manage',
      'ecommerce.manage',
      'approval.manage',
      'organization.companyprofile.view',
      'organization.companyprofile.manage',
      'einvoice.view',
      'einvoice.manage',
      'einvoice.credentials.manage',
      'reporting.view',
      'dashboards.view',
      'dashboards.manage',
      // P-C6: the tenant administrator owns the wording of its own mail and reads its log.
      'tenant.email.template.manage',
      'tenant.email.log.view',
      'ai.assistant.use',
      'ai.settings.manage',
      'employee.self.view',
      'employee.self.manage',
      'employee.team.approve',
    ],
  },
  {
    code: 'branch_manager',
    nameAr: 'مدير فرع',
    nameEn: 'Branch manager',
    description: 'Manages one branch (scoped via membership branch_scope).',
    permissions: [
      'tenant.view',
      'organization.branch.view',
      'organization.warehouse.view',
      'organization.cashlocation.view',
      'catalog.item.view',
      'parties.view',
      'inventory.view',
      'manufacturing.view',
      'inventory.transfer',
      'inventory.bins.manage',
      'inventory.transfer.receive',
      'sales.view',
      'treasury.view',
      'treasury.shift.close',
      'treasury.shift.post',
      'reporting.view',
      'dashboards.view',
      'dashboards.manage',
      'pos.view',
      'ai.assistant.use',
      'employee.self.view',
      'employee.self.manage',
      'employee.team.approve',
    ],
  },
  {
    code: 'device_manager',
    nameAr: 'مدير الأجهزة',
    nameEn: 'Device manager',
    description: 'Registers and maintains tenant devices and desktop-compat endpoints.',
    permissions: [
      'tenant.view',
      'tenant.device.view',
      'tenant.device.manage',
      'compat.manage',
      'compat.sync',
      'organization.branch.view',
      'ai.assistant.use',
      'employee.self.view',
      'employee.self.manage',
    ],
  },
  {
    code: 'security_admin',
    nameAr: 'مسؤول الأمن',
    nameEn: 'Security administrator',
    description: 'Roles, memberships and audit review. Cannot touch billing or file operations.',
    permissions: [
      'tenant.view',
      'tenant.membership.manage',
      'tenant.role.manage',
      'tenant.audit.view',
      'tenant.settings.manage',
      'tenant.apps.manage',
      'ai.assistant.use',
      'employee.self.view',
      'employee.self.manage',
    ],
  },
  {
    code: 'tenant_auditor',
    nameAr: 'مدقق المنشأة',
    nameEn: 'Tenant auditor',
    description: 'Read-only access to the tenant audit trail, reports and master data.',
    permissions: [
      'tenant.view',
      'tenant.audit.view',
      'tenant.job.view',
      'organization.branch.view',
      'organization.warehouse.view',
      'organization.cashlocation.view',
      'accounting.account.view',
      'accounting.period.view',
      'accounting.reports.view',
      'sales.view',
      'purchase.view',
      'treasury.view',
      'reporting.view',
      'dashboards.view',
      'dashboards.manage',
      // P-C6: an auditor may see what left the tenant in its name.
      'tenant.email.log.view',
      'ai.assistant.use',
      'employee.self.view',
      'employee.self.manage',
    ],
  },
] as const;

/** Family C — ERP functional roles (per-tenant, `roles` table). */
export const erpFunctionalRoleCatalog: readonly RoleCatalogEntry[] = [
  {
    code: 'accountant',
    nameAr: 'محاسب',
    nameEn: 'Accountant',
    description: 'Accounting, parties, inventory and document review without tenant administration.',
    permissions: [
      'tenant.view',
      'organization.branch.view',
      'organization.warehouse.view',
      'organization.cashlocation.view',
      'organization.currency.view',
      'catalog.item.view',
      'catalog.category.view',
      'catalog.unit.view',
      'catalog.taxgroup.view',
      'accounting.account.view',
      'accounting.account.manage',
      'accounting.costcenter.manage',
      'accounting.journal.create',
      'accounting.journal.post',
      'accounting.journal.reverse',
      'comment.view',
      'comment.manage',
      'accounting.period.view',
      'accounting.period.close',
      'accounting.period.reopen',
      'accounting.opening.manage',
      'accounting.reports.view',
      'parties.view',
      'parties.manage',
      'parties.allocate',
      'inventory.view',
      'manufacturing.view',
      'inventory.adjust',
      'inventory.bins.manage',
      'inventory.adjust.approve',
      'inventory.transfer',
      'inventory.transfer.receive',
      'inventory.request.manage',
      'inventory.request.approve',
      'inventory.delivery.manage',
      'inventory.negative.override',
      'sales.view',
      'sales.invoice.create',
      'esign.manage',
      'sales.invoice.post',
      'sales.invoice.void',
      'sales.adjustment.create',
      'approval.approve',
      'purchase.view',
      'purchase.invoice.create',
      'supplier_portal.access',
      'purchase.invoice.post',
      'purchase.invoice.void',
      'purchase.adjustment.create',
      'treasury.view',
      'treasury.voucher.create',
      'treasury.voucher.post',
      'treasury.voucher.void',
      'treasury.cheque.clear',
      'treasury.shift.close',
      'treasury.shift.post',
      'einvoice.view',
      'einvoice.submit',
      'reporting.view',
      'dashboards.view',
      'dashboards.manage',
      'payroll.wps.export',
      'payments.links.manage',
      'ai.assistant.use',
      'employee.self.view',
      'employee.self.manage',
    ],
  },
  {
    code: 'sales_manager',
    nameAr: 'مدير مبيعات',
    nameEn: 'Sales manager',
    description: 'Full sales cycle including offers, salesmen and discount overrides.',
    permissions: [
      'tenant.view',
      'catalog.item.view',
      'catalog.category.view',
      'catalog.taxgroup.view',
      'catalog.price.manage',
      'parties.view',
      'parties.manage',
      'parties.allocate',
      'parties.creditlimit.override',
      'inventory.view',
      'manufacturing.view',
      'sales.view',
      'crm.deals.view',
      'crm.deals.manage',
      'crm.activities.manage',
      'comment.view',
      'comment.manage',
      'sales.invoice.create',
      'esign.manage',
      'supplier_portal.access',
      'sales.invoice.post',
      'sales.invoice.void',
      'sales.invoice.pay',
      'sales.discount.override',
      'sales.return.create',
      'sales.adjustment.create',
      'approval.approve',
      'sales.offer.manage',
      'sales.salesman.manage',
      'ecommerce.manage',
      'payments.links.manage',
      'reporting.view',
      'dashboards.view',
      'dashboards.manage',
      'ai.assistant.use',
      'employee.self.view',
      'employee.self.manage',
    ],
  },
  {
    code: 'sales_user',
    nameAr: 'موظف مبيعات',
    nameEn: 'Sales user',
    description: 'Creates draft sales documents; cannot post, void or override.',
    permissions: [
      'tenant.view',
      'catalog.item.view',
      'catalog.taxgroup.view',
      'parties.view',
      'parties.manage',
      'inventory.view',
      'manufacturing.view',
      'sales.view',
      'crm.deals.view',
      'crm.activities.manage',
      'comment.view',
      'comment.manage',
      'sales.invoice.create',
      'esign.manage',
      'supplier_portal.access',
      'reporting.view',
      'dashboards.view',
      'dashboards.manage',
      'ai.assistant.use',
      'employee.self.view',
      'employee.self.manage',
    ],
  },
  {
    code: 'purchase_manager',
    nameAr: 'مدير مشتريات',
    nameEn: 'Purchase manager',
    description: 'Full purchase cycle including landed costs and adjustments.',
    permissions: [
      'tenant.view',
      'catalog.item.view',
      'catalog.category.view',
      'catalog.taxgroup.view',
      'parties.view',
      'parties.manage',
      'inventory.view',
      'manufacturing.view',
      'purchase.view',
      'purchase.invoice.create',
      'supplier_portal.access',
      'purchase.ocr.use',
      'purchase.invoice.post',
      'purchase.invoice.void',
      'purchase.invoice.pay',
      'purchase.cost.manage',
      'purchase.adjustment.create',
      'approval.approve',
      'reporting.view',
      'dashboards.view',
      'dashboards.manage',
      'ai.assistant.use',
      'employee.self.view',
      'employee.self.manage',
    ],
  },
  {
    code: 'purchase_user',
    nameAr: 'موظف مشتريات',
    nameEn: 'Purchase user',
    description: 'Creates draft purchase documents; cannot post or void.',
    permissions: [
      'tenant.view',
      'catalog.item.view',
      'parties.view',
      'inventory.view',
      'manufacturing.view',
      'purchase.view',
      'purchase.invoice.create',
      'supplier_portal.access',
      'purchase.ocr.use',
      'reporting.view',
      'dashboards.view',
      'dashboards.manage',
      'ai.assistant.use',
      'employee.self.view',
      'employee.self.manage',
    ],
  },
  {
    code: 'inventory_manager',
    nameAr: 'مدير مخزون',
    nameEn: 'Inventory manager',
    description: 'Warehouses, adjustments, transfers, production and approvals.',
    permissions: [
      'tenant.view',
      'organization.warehouse.view',
      'catalog.item.view',
      'catalog.item.manage',
      'catalog.category.view',
      'catalog.unit.view',
      'inventory.view',
      'manufacturing.view',
      'inventory.adjust',
      'inventory.bins.manage',
      'inventory.adjust.approve',
      'inventory.transfer',
      'inventory.transfer.receive',
      'inventory.request.manage',
      'inventory.request.approve',
      'inventory.delivery.manage',
      'inventory.production.manage',
      'manufacturing.manage',
      'inventory.production.complete',
      'manufacturing.produce',
      'inventory.negative.override',
      'reporting.view',
      'dashboards.view',
      'dashboards.manage',
      'ai.assistant.use',
      'employee.self.view',
      'employee.self.manage',
    ],
  },
  {
    code: 'warehouse_user',
    nameAr: 'موظف مستودع',
    nameEn: 'Warehouse user',
    description: 'Day-to-day warehouse moves without approvals or negative overrides.',
    permissions: [
      'tenant.view',
      'organization.warehouse.view',
      'catalog.item.view',
      'inventory.view',
      'manufacturing.view',
      'inventory.transfer',
      'inventory.bins.manage',
      'inventory.transfer.receive',
      'inventory.request.manage',
      'inventory.delivery.manage',
      'reporting.view',
      'dashboards.view',
      'dashboards.manage',
      'ai.assistant.use',
      'employee.self.view',
      'employee.self.manage',
    ],
  },
  {
    code: 'cashier',
    nameAr: 'كاشير',
    nameEn: 'Cashier',
    description:
      'Human cashier: point-of-sale and treasury operations. The till hardware itself is a `devices` row, not this role.',
    permissions: [
      'tenant.view',
      'organization.branch.view',
      'organization.cashlocation.view',
      'catalog.item.view',
      'catalog.taxgroup.view',
      'parties.view',
      'parties.manage',
      'inventory.view',
      'manufacturing.view',
      'sales.view',
      'sales.invoice.create',
      'esign.manage',
      'supplier_portal.access',
      'sales.invoice.pay',
      'treasury.view',
      'treasury.voucher.create',
      'treasury.shift.close',
      'payments.links.manage',
      'pos.view',
      'pos.operate',
      'ai.assistant.use',
      'employee.self.view',
      'employee.self.manage',
    ],
  },
  {
    code: 'treasury_user',
    nameAr: 'موظف خزينة',
    nameEn: 'Treasury user',
    description: 'Vouchers, cheques and cash transfers.',
    permissions: [
      'tenant.view',
      'organization.cashlocation.view',
      'parties.view',
      'treasury.view',
      'treasury.voucher.create',
      'treasury.voucher.post',
      'treasury.voucher.void',
      'treasury.cheque.clear',
      'treasury.transfer.manage',
      'treasury.shift.post',
      'treasury.expensetype.manage',
      'payments.links.manage',
      'reporting.view',
      'dashboards.view',
      'dashboards.manage',
      'ai.assistant.use',
      'employee.self.view',
      'employee.self.manage',
    ],
  },
  {
    code: 'hr_manager',
    nameAr: 'مدير موارد بشرية',
    nameEn: 'HR manager',
    description: 'HR directories, attendance, adjustments and payroll.',
    permissions: [
      'tenant.view',
      'hrm.view',
      'hrm.manage',
      'comment.view',
      'comment.manage',
      'hrm.payroll.post',
      'hrm.adjust.approve',
      'payroll.wps.export',
      'reporting.view',
      'dashboards.view',
      'dashboards.manage',
      'ai.assistant.use',
      'employee.self.view',
      'employee.self.manage',
      'employee.team.approve',
    ],
  },
  {
    code: 'project_manager',
    nameAr: 'مدير مشاريع',
    nameEn: 'Project manager',
    description: 'Projects, contracting, progress bills and contractor payments.',
    permissions: [
      'tenant.view',
      'projects.view',
      'projects.manage',
      'projects.tasks.view',
      'projects.tasks.manage',
      'projects.time_logs.manage',
      'comment.view',
      'comment.manage',
      'projects.bill.post',
      'projects.contractor.pay',
      'projects.stage.accredit',
      'reporting.view',
      'dashboards.view',
      'dashboards.manage',
      'ai.assistant.use',
      'employee.self.view',
      'employee.self.manage',
    ],
  },
  {
    code: 'auditor',
    nameAr: 'مراجع',
    nameEn: 'Auditor',
    description: 'Read-only ERP access for external review.',
    permissions: [
      'tenant.view',
      'tenant.audit.view',
      'organization.branch.view',
      'organization.warehouse.view',
      'organization.cashlocation.view',
      'catalog.item.view',
      'accounting.account.view',
      'accounting.period.view',
      'accounting.reports.view',
      'parties.view',
      'inventory.view',
      'manufacturing.view',
      'sales.view',
      'purchase.view',
      'treasury.view',
      'einvoice.view',
      'reporting.view',
      'dashboards.view',
      'dashboards.manage',
      'hrm.view',
      'projects.view',
      'projects.tasks.view',
      'comment.view',
      'ai.assistant.use',
      'employee.self.view',
      'employee.self.manage',
    ],
  },
  {
    code: 'report_viewer',
    nameAr: 'مشاهد تقارير',
    nameEn: 'Report viewer',
    description: 'Runs and exports reports; reads the documents behind them.',
    permissions: [
      'tenant.view',
      'sales.view',
      'purchase.view',
      'inventory.view',
      'manufacturing.view',
      'treasury.view',
      'accounting.reports.view',
      'reporting.view',
      'dashboards.view',
      'dashboards.manage',
      'reporting.export.execute',
      'comment.view',
      'ai.assistant.use',
      'employee.self.view',
      'employee.self.manage',
    ],
  },
] as const;

const platformByCode = new Map(platformRoleCatalog.map((role) => [role.code, role]));
const tenantAdminByCode = new Map(tenantAdminRoleCatalog.map((role) => [role.code, role]));
const erpByCode = new Map(erpFunctionalRoleCatalog.map((role) => [role.code, role]));

export function findPlatformRole(code: string): RoleCatalogEntry | undefined {
  return platformByCode.get(code);
}

export function findTenantAdminRole(code: string): RoleCatalogEntry | undefined {
  return tenantAdminByCode.get(code);
}

export function findErpFunctionalRole(code: string): RoleCatalogEntry | undefined {
  return erpByCode.get(code);
}

export function isPlatformRoleCode(code: string): boolean {
  return platformByCode.has(code);
}

/**
 * Effective platform permissions of a set of platform roles (UNION semantics,
 * mirroring tenant roles in DATABASE_DESIGN §2).
 *
 * P-C3 added the second argument: `overrides` maps a role code to the exact set of
 * `console.*` codes it carries **instead of** the catalogue. A role absent from the map
 * follows the catalogue, so an empty map reproduces the pre-P-C3 behaviour exactly —
 * which is what every existing caller gets when it omits the argument. The platform guard
 * and `/me` both pass the stored overrides, so the console and the API answer with one
 * voice (see `platformRolePermissionOverridesSchema`).
 */
export function platformPermissionsForRoles(
  codes: readonly string[],
  overrides?: Readonly<Record<string, readonly string[]>>,
): string[] {
  const out = new Set<string>();
  for (const code of codes) {
    const override =
      overrides && Object.prototype.hasOwnProperty.call(overrides, code) ? overrides[code] : undefined;
    const granted = override ?? platformByCode.get(code)?.permissions ?? [];
    for (const permission of granted) out.add(permission);
  }
  return [...out];
}
