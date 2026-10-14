import { canonicalizePermissionCode } from '@erp/contracts';

/**
 * Navigation tree — a 1:1 mirror of the desktop product's menu (المحاسبة، المستودعات،
 * المشتريات، المبيعات، الموظفين والرواتب، المراسي، المشاريع، الإعدادات، الدعم الفني)
 * plus the SaaS platform console that the desktop edition never had.
 *
 * `status` is deliberately part of the data model and is rendered in the UI:
 *   'ready'   — the screen is implemented and talks to a real endpoint.
 *   'api'     — the API endpoint exists, the screen is still a scaffold.
 *   'planned' — neither side exists yet.
 * Nothing here pretends to work; a scaffold screen says so and names its endpoint.
 */

export type ScreenStatus = 'ready' | 'api' | 'planned';

export type ScreenItem = {
  key: string;
  labelAr: string;
  labelEn: string;
  href: string;
  /** Permission code from @erp/contracts; when absent the item is always visible. */
  permission?: string;
  status: ScreenStatus;
  /** API path the screen uses (or will use) — shown on scaffold screens. */
  endpoint?: string;
  description?: string;
};

export type ScreenGroup = {
  key: string;
  labelAr: string;
  labelEn: string;
  items: ScreenItem[];
};

export type ModuleNode = {
  key: string;
  icon: string;
  labelAr: string;
  labelEn: string;
  href: string;
  permission?: string;
  /** Only rendered for users whose token carries `pam` (platform administrators). */
  platformAdminOnly?: boolean;
  groups: ScreenGroup[];
};

const screen = (
  key: string,
  labelAr: string,
  labelEn: string,
  href: string,
  status: ScreenStatus,
  extra: Partial<ScreenItem> = {},
): ScreenItem => ({ key, labelAr, labelEn, href, status, ...extra });

// ---------------------------------------------------------------------------
// NOTE: the platform console used to be module 0 here. It moved to the dedicated
// `apps/platform-admin` deployment during the 2026-09 surface separation — the staff
// surface must not route to `/platform/*` at all. Operators reach the console through
// the dashboard link (NEXT_PUBLIC_PLATFORM_URL).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 1. المحاسبة
// ---------------------------------------------------------------------------
const accounting: ModuleNode = {
  key: 'accounting',
  icon: '📊',
  labelAr: 'المحاسبة',
  labelEn: 'Accounting',
  href: '/accounting/accounts',
  permission: 'accounting.account.view',
  groups: [
    {
      key: 'accounting-defs',
      labelAr: 'تعاريف',
      labelEn: 'Definitions',
      items: [
        screen('coa', 'دليل الحسابات', 'Chart of accounts', '/accounting/accounts', 'ready', {
          permission: 'accounting.account.view',
          endpoint: '/accounts',
        }),
        screen('coa-tree', 'شجرة الحسابات', 'Account tree', '/accounting/accounts/tree', 'ready', {
          permission: 'accounting.account.view',
          endpoint: '/accounts',
        }),
        screen('cash-card', 'بطاقة صندوق', 'Cash box card', '/accounting/cash-locations?type=cash', 'ready', {
          permission: 'organization.cashlocation.view',
          endpoint: '/cash-locations',
        }),
        screen('bank-card', 'بطاقة بنك', 'Bank card', '/accounting/cash-locations?type=bank', 'ready', {
          permission: 'organization.cashlocation.view',
          endpoint: '/cash-locations',
        }),
        screen('cost-center', 'بطاقة مركز تكلفة', 'Cost centre card', '/accounting/cost-centers', 'ready', {
          permission: 'accounting.account.view',
          endpoint: '/cost-centers',
        }),
        screen('payment-methods', 'طرق الدفع', 'Payment methods', '/accounting/payment-methods', 'ready', {
          permission: 'parties.view',
          endpoint: '/payment-methods',
        }),
      ],
    },
    {
      key: 'accounting-ops',
      labelAr: 'العمليات',
      labelEn: 'Operations',
      items: [
        screen(
          'opening-entry',
          'قيد إفتتاحي',
          'Opening entry',
          '/accounting/journal-entries/new?kind=opening',
          'ready',
          { permission: 'accounting.journal.post', endpoint: 'POST /journal-entries' },
        ),
        screen('journal-voucher', 'سند قيد', 'Journal voucher', '/accounting/journal-entries/new', 'ready', {
          permission: 'accounting.journal.post',
          endpoint: 'POST /journal-entries',
        }),
        screen('periods', 'الفترات المحاسبية', 'Fiscal periods', '/accounting/periods', 'ready', {
          permission: 'accounting.period.view',
          endpoint: '/fiscal-periods',
        }),
      ],
    },
    {
      key: 'accounting-reports',
      labelAr: 'تقارير محاسبية',
      labelEn: 'Accounting reports',
      items: [
        screen(
          'journals-report',
          'القيود اليومية',
          'Journal entries',
          '/accounting/journal-entries',
          'ready',
          { permission: 'accounting.reports.view', endpoint: '/journal-entries' },
        ),
        screen('vouchers-report', 'عرض السندات', 'Vouchers', '/treasury/vouchers', 'ready', {
          permission: 'treasury.view',
          endpoint: '/vouchers',
        }),
        screen('statement', 'كشف حساب', 'Account statement', '/accounting/ledger', 'ready', {
          permission: 'accounting.reports.view',
          endpoint: '/statements/general-ledger/{accountId}',
        }),
        screen(
          'main-statement',
          'كشف حساب رئيسي',
          'Main account statement',
          '/accounting/ledger?rollup=1',
          'ready',
          { permission: 'accounting.reports.view', endpoint: '/statements/general-ledger/{accountId}' },
        ),
        screen('cash-movement', 'حركة الصندوق', 'Cash movement', '/reports/cash-movement', 'ready', {
          permission: 'reporting.view',
          endpoint: '/reports/cash-movement',
        }),
        screen(
          'cc-balances',
          '📊 كشف مركز الكلفة',
          'Cost-centre statement',
          '/accounting/cost-center-statement',
          'ready',
          { permission: 'accounting.reports.view', endpoint: '/statements/cost-center/{costCenterId}' },
        ),
        screen('daily-movement', 'الحركة اليومية', 'Daily movement', '/reports/general-ledger', 'ready', {
          permission: 'reporting.view',
        }),
        screen('party-statement', 'كشف حساب عميل', 'Party statement', '/reports/party-statement', 'ready', {
          permission: 'reporting.view',
        }),
        screen('trial-balance', 'ميزان المراجعة', 'Trial balance', '/accounting/trial-balance', 'ready', {
          permission: 'accounting.reports.view',
          endpoint: '/statements/trial-balance',
        }),
        screen(
          'income-statement',
          'أرباح وخسائر حسابات رئيسية',
          'Income statement',
          '/accounting/income-statement',
          'ready',
          { permission: 'accounting.reports.view', endpoint: '/statements/income-statement' },
        ),
        screen(
          'balance-sheet',
          'ميزانية تحليلية',
          'Analytical balance sheet',
          '/reports/balance-sheet',
          'ready',
          { permission: 'reporting.view' },
        ),
        screen('vat-return', 'الإقرار الضريبي', 'VAT return', '/reports/vat-return', 'ready', {
          permission: 'reporting.view',
        }),
        screen('reports-center', 'مركز التقارير (كل التقارير)', 'Report centre', '/reports', 'ready', {
          permission: 'reporting.view',
          endpoint: '/reports',
        }),
        screen(
          'custom-report-builder',
          'منشئ التقارير المخصص',
          'Custom report builder',
          '/reports/builder',
          'ready',
          {
            permission: 'reporting.view',
            endpoint: 'GET/POST /custom-reports · POST /custom-reports/:id/run',
          },
        ),
        screen('custom-reports', 'التقارير المحفوظة', 'Saved custom reports', '/reports/custom', 'ready', {
          permission: 'reporting.view',
          endpoint: 'GET /custom-reports',
        }),
        // 📒 الجزء الخامس — تقارير المحاسبة
        screen(
          'account-balances',
          'أرصدة الحسابات',
          'Account balances',
          '/reports/account-balances',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/account-balances' },
        ),
        screen(
          'journal-entries-report',
          'سجل القيود اليومية',
          'Journal entry register',
          '/reports/journal-entries',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/journal-entries' },
        ),
        screen(
          'journal-entry-lines',
          'تفاصيل القيد',
          'Journal entry details',
          '/reports/journal-entry-lines',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/journal-entry-lines' },
        ),
        screen(
          'income-statement-accounts',
          'أرباح وخسائر حسابات رئيسية (تقرير)',
          'Income statement by main account',
          '/reports/income-statement-accounts',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/income-statement-accounts' },
        ),
        screen(
          'cost-center-statement-report',
          'تقرير مراكز التكلفة',
          'Cost centre statement',
          '/reports/cost-center-statement',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/cost-center-statement' },
        ),
        screen(
          'vat-return-period',
          'الإقرار الضريبي للفترة',
          'VAT return for a period',
          '/reports/vat-return-period',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/vat-return-period' },
        ),
        // 💰 الجزء السادس — تقارير الخزينة والرواتب والمستخدمين
        screen('cash-statement', 'حركة الصندوق (كشف)', 'Cash statement', '/reports/cash-statement', 'ready', {
          permission: 'reporting.view',
          endpoint: '/reports/cash-statement',
        }),
        screen(
          'salary-statement',
          'تقرير الرواتب (سجل)',
          'Salary statement',
          '/reports/salary-statement',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/salary-statement' },
        ),
        screen(
          'salary-reserved',
          'تقرير الرواتب المستحقة',
          'Reserved salaries',
          '/reports/salary-reserved',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/salary-reserved' },
        ),
        screen('user-records', 'سجلات المستخدمين', 'User records', '/reports/user-records', 'ready', {
          permission: 'reporting.view',
          endpoint: '/reports/user-records',
        }),
        screen(
          'rent-invoices',
          'تقرير فواتير التأجير (سجل)',
          'Rent invoices register',
          '/reports/rent-invoices',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/rent-invoices' },
        ),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// 2. المستودعات
// ---------------------------------------------------------------------------
const inventory: ModuleNode = {
  key: 'inventory',
  icon: '🏭',
  labelAr: 'المستودعات',
  labelEn: 'Inventory',
  href: '/s/inventory/items',
  permission: 'inventory.view',
  groups: [
    {
      key: 'inventory-overview',
      labelAr: 'نظرة عامة',
      labelEn: 'Overview',
      items: [
        screen('inventory-overview', 'لوحة المخزون', 'Inventory overview', '/inventory/overview', 'ready', {
          permission: 'inventory.view',
          endpoint: '/inventory/levels',
        }),
      ],
    },
    {
      key: 'inventory-defs',
      labelAr: 'التعاريف',
      labelEn: 'Definitions',
      items: [
        screen('items', 'دليل المواد وبطاقاتها', 'Item directory and cards', '/inventory/items', 'ready', {
          permission: 'catalog.item.view',
          endpoint: '/organization/catalog/items',
        }),
        screen('warehouse-card', 'بطاقة مستودع', 'Warehouse card', '/inventory/warehouses', 'ready', {
          permission: 'organization.warehouse.view',
          endpoint: '/warehouses',
        }),
        screen('group-card', 'بطاقة مجموعة', 'Category card', '/inventory/categories', 'ready', {
          permission: 'catalog.category.view',
          endpoint: '/organization/catalog/categories',
        }),
        screen('unit-card', 'بطاقة وحدة', 'Unit card', '/inventory/units', 'ready', {
          permission: 'catalog.unit.view',
          endpoint: '/organization/catalog/units',
        }),
        screen(
          'item-units',
          'وحدات الصنف والباركود',
          'Item units and barcodes',
          '/inventory/item-units',
          'ready',
          {
            permission: 'catalog.item.view',
            endpoint: '/organization/catalog/items/:id/units',
          },
        ),
      ],
    },
    {
      key: 'inventory-ops',
      labelAr: 'العمليات',
      labelEn: 'Operations',
      items: [
        screen('transfer', 'مناقلة', 'Transfer', '/inventory/transfers', 'ready', {
          permission: 'inventory.view',
          endpoint: '/inventory/transfers',
        }),
        screen(
          'opening-stock',
          'بضاعة أول مدة',
          'Opening stock',
          '/inventory/vouchers?kind=opening',
          'ready',
          { permission: 'inventory.adjust', endpoint: 'POST /inventory/vouchers/:id/post' },
        ),
        screen('goods-in', 'فاتورة إدخال', 'Goods receipt', '/purchases/invoices/new', 'ready', {
          permission: 'purchase.invoice.create',
          endpoint: 'POST /purchase-invoices',
        }),
        screen('goods-out', 'فاتورة إخراج', 'Goods issue', '/sales/invoices/new', 'ready', {
          permission: 'sales.invoice.create',
          endpoint: 'POST /sales/invoices',
        }),
        screen('stock-adjust', 'تسوية مخزنية', 'Stock adjustment', '/inventory/adjustments', 'ready', {
          permission: 'inventory.adjust',
          endpoint: 'POST /inventory/adjustments/:id/post',
        }),
        screen('stock-voucher', 'سند إدخال / إخراج', 'Stock voucher', '/inventory/vouchers', 'ready', {
          permission: 'inventory.adjust',
          endpoint: '/inventory/vouchers',
        }),
        screen('stock-delivery', 'توصيل مخزني', 'Stock delivery', '/inventory/deliveries', 'ready', {
          permission: 'inventory.view',
          endpoint: '/inventory/deliveries',
        }),
        screen('goods-request', 'طلب بضاعة', 'Goods request', '/inventory/requests', 'ready', {
          permission: 'inventory.view',
          endpoint: '/inventory/requests',
        }),
        screen('barcode', 'طباعة الباركود', 'Barcode printing', '/inventory/barcodes', 'ready', {
          permission: 'catalog.item.view',
          endpoint: '/organization/catalog/items',
        }),
      ],
    },
    {
      key: 'inventory-reports',
      labelAr: 'تقارير مستودعية',
      labelEn: 'Inventory reports',
      items: [
        screen('stock-count', 'جرد المواد', 'Stock count', '/inventory/levels', 'ready', {
          permission: 'inventory.view',
          endpoint: '/inventory/levels',
        }),
        screen(
          'below-minimum',
          'أصناف تحت حد الطلب',
          'Below reorder point',
          '/inventory/below-minimum',
          'ready',
          { permission: 'inventory.view', endpoint: '/inventory/below-minimum' },
        ),
        screen('expiry', 'تواريخ الصلاحية', 'Expiry dates', '/inventory/expiry', 'ready', {
          permission: 'inventory.view',
          endpoint: '/inventory/expiry',
        }),
        screen('item-card', 'بطاقة الصنف', 'Item card (stock ledger)', '/inventory/item-card', 'ready', {
          permission: 'inventory.view',
          endpoint: '/inventory/item-card',
        }),
        screen(
          'item-movement',
          'حركة مادة تفصيلي',
          'Item movement (detail)',
          '/inventory/movements',
          'ready',
          { permission: 'inventory.view', endpoint: '/inventory/movements' },
        ),
        screen(
          'items-movement',
          'حركة مواد تجميعي',
          'Item movement (summary)',
          '/reports/item-movement-summary',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/inventory-movement' },
        ),
        screen('lots', 'صلاحية المواد (الدفعات)', 'Item expiry (lots)', '/inventory/lots', 'ready', {
          permission: 'inventory.view',
          endpoint: '/inventory/lots',
        }),
        screen('sales-analysis', 'تحليل المبيعات', 'Sales analysis', '/reports/sales-analysis', 'ready', {
          permission: 'reporting.view',
        }),
        screen(
          'purchase-sales-total',
          'إجمالي المبيعات والمشتريات',
          'Sales & purchases total',
          '/reports/sales-purchases-total',
          'ready',
          { permission: 'reporting.view' },
        ),
        screen(
          'turnover',
          'معدل الدوران والركود',
          'Turnover & dead stock',
          '/reports/inventory-turnover',
          'ready',
          { permission: 'reporting.view' },
        ),
        screen(
          'inventory-valuation',
          'جرد المواد وتقييم المخزون',
          'Inventory valuation',
          '/reports/inventory-valuation',
          'ready',
          { permission: 'reporting.view' },
        ),
        screen(
          'stock-limits',
          'الأصناف تحت الحد الأدنى',
          'Items below the minimum',
          '/reports/stock-limits',
          'ready',
          { permission: 'reporting.view' },
        ),
        screen('expiry-report', 'صلاحية المواد', 'Expiry report', '/reports/expiry-report', 'ready', {
          permission: 'reporting.view',
        }),
        screen(
          'serial-tracking',
          'تتبّع الأرقام التسلسلية',
          'Serial tracking report',
          '/reports/serial-tracking',
          'ready',
          { permission: 'reporting.view' },
        ),
        screen(
          'production-order',
          'تقرير أمر الإنتاج',
          'Production order report',
          '/inventory/production',
          'ready',
          { permission: 'inventory.view', endpoint: '/inventory/production-orders' },
        ),
        screen(
          'invoices-by-type',
          'الفواتير بحسب النوع',
          'Invoices by type',
          '/reports/invoices-by-type',
          'ready',
          { permission: 'reporting.view' },
        ),
        screen('expired-items', 'انتهاء صلاحية الأصناف', 'Expired items', '/reports/expired-items', 'ready', {
          permission: 'reporting.view',
        }),
        screen('serials', 'تقرير الأرقام التسلسلية', 'Serial numbers report', '/inventory/serials', 'ready', {
          permission: 'inventory.view',
          endpoint: '/inventory/serials',
        }),
      ],
    },
    {
      key: 'inventory-bins',
      labelAr: 'الرفوف',
      labelEn: 'Bins',
      items: [
        screen('warehouse-bins', 'رفوف المستودع', 'Warehouse bins', '/inventory/bins', 'ready', {
          permission: 'inventory.view',
          endpoint: 'GET/POST /inventory/bins',
        }),
        screen('bin-balances', 'أرصدة الرفوف', 'Bin balances', '/inventory/bin-balances', 'ready', {
          permission: 'inventory.view',
          endpoint: 'GET /inventory/bin-balances · POST /inventory/bin-transfers',
        }),
      ],
    },
    {
      key: 'inventory-salla',
      labelAr: 'متجر سلة',
      labelEn: 'Salla store',
      items: [
        screen('salla-products', 'المنتجات', 'Products', '/integrations/salla/products', 'ready', {
          permission: 'salla.integration.view',
          endpoint: '/integrations/salla/products',
        }),
        screen('salla-orders', 'إدارة الطلبات', 'Orders', '/integrations/salla/orders', 'ready', {
          permission: 'salla.integration.view',
          endpoint: '/integrations/salla/orders',
        }),
        screen(
          'salla-warehouses',
          'ربط المستودعات',
          'Warehouse mapping',
          '/integrations/salla/warehouses',
          'ready',
          { permission: 'salla.integration.view', endpoint: '/integrations/salla/mappings' },
        ),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// 3. المشتريات
// ---------------------------------------------------------------------------
const purchases: ModuleNode = {
  key: 'purchases',
  icon: '🛒',
  labelAr: 'المشتريات',
  labelEn: 'Purchases',
  href: '/purchases/invoices',
  permission: 'purchase.view',
  groups: [
    {
      key: 'purchases-ops',
      labelAr: 'العمليات',
      labelEn: 'Operations',
      items: [
        screen('purchase-invoice', 'فاتورة المشتريات', 'Purchase invoice', '/purchases/invoices', 'ready', {
          endpoint: '/purchase-invoices',
        }),
        screen(
          'purchase-ocr',
          'قراءة فاتورة بالـ OCR',
          'OCR purchase invoice',
          '/purchases/invoices/ocr',
          'ready',
          {
            permission: 'purchase.ocr.use',
            endpoint: 'POST /ocr/jobs',
          },
        ),
        screen(
          'purchase-return',
          'مردود المشتريات',
          'Purchase return',
          '/purchases/invoices/new?kind=purchase_return',
          'ready',
          { permission: 'purchase.invoice.create', endpoint: 'POST /purchase-invoices' },
        ),
        screen(
          'supplier-portal-admin',
          'بوابة الموردين',
          'Supplier portal',
          '/purchases/supplier-portal',
          'ready',
          { permission: 'supplier_portal.access', endpoint: '/supplier-portal/users' },
        ),
      ],
    },
    {
      key: 'purchases-vouchers',
      labelAr: 'السندات',
      labelEn: 'Vouchers',
      items: [
        screen('purchase-credit-note', 'إشعار دائن', 'Credit note', '/purchases/notes/credit', 'ready', {
          permission: 'purchase.view',
          endpoint: '/purchases/adjustment-notes',
        }),
      ],
    },
    {
      key: 'purchases-notes',
      labelAr: 'الإشعارات',
      labelEn: 'Notes',
      items: [
        screen('pn-debit', 'إشعار مدين', 'Debit note', '/purchases/notes/debit', 'ready', {
          permission: 'purchase.view',
          endpoint: '/purchases/adjustment-notes',
        }),
        screen('pn-report', 'تقرير الإشعارات', 'Notes report', '/reports/purchase-notes', 'ready', {
          permission: 'reporting.view',
        }),
      ],
    },
    {
      key: 'purchases-reports',
      labelAr: 'التقارير',
      labelEn: 'Reports',
      items: [
        screen(
          'supplier-statement',
          'كشف مورد',
          'Supplier statement',
          '/sales/statements?kind=supplier',
          'ready',
          { permission: 'parties.view', endpoint: '/parties/{id}/statement' },
        ),
        screen(
          'purchase-invoices-report',
          'تقرير فواتير المشتريات',
          'Purchase invoices',
          '/reports/purchase-invoices',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/purchases' },
        ),
        screen(
          'purchase-returns-report',
          'تقرير مردود فواتير المشتريات',
          'Purchase returns',
          '/reports/purchase-returns',
          'ready',
          { permission: 'reporting.view' },
        ),
        screen(
          'items-purchases-summary',
          'مشتريات الأصناف تجميعي',
          'Item purchases summary',
          '/reports/items-purchases-summary',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/items-purchases-summary' },
        ),
        screen(
          'purchase-invoices-details',
          'تفاصيل فواتير المشتريات',
          'Purchase invoices details',
          '/reports/purchase-invoices-details',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/purchase-invoices-details' },
        ),
        screen(
          'items-profit-details',
          'أرباح المواد تفصيلي',
          'Item profit details',
          '/reports/items-profit-details',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/items-profit-details' },
        ),
        screen('net-purchases', 'صافي المشتريات', 'Net purchases', '/reports/net-purchases', 'ready', {
          permission: 'reporting.view',
        }),
        screen(
          'purchases-detail',
          'مشتريات تفصيلية',
          'Detailed purchases',
          '/reports/purchases-detail',
          'ready',
          { permission: 'reporting.view' },
        ),
        screen(
          'purchases-items',
          'مشتريات الأصناف تجميعي',
          'Purchases by item',
          '/reports/purchases-by-item',
          'ready',
          { permission: 'reporting.view' },
        ),
        screen(
          'supplier-balances',
          'أرصدة الموردين',
          'Supplier balances',
          '/reports/supplier-balances',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/party-balances' },
        ),
        screen(
          'supplier-settlements',
          'سداد الموردين',
          'Supplier settlements',
          '/reports/supplier-settlements',
          'ready',
          { permission: 'reporting.view' },
        ),
        screen(
          'employee-purchases',
          'مشتريات موظف',
          'Purchases by employee',
          '/reports/purchases-by-employee',
          'ready',
          { permission: 'reporting.view' },
        ),
        screen(
          'invoices-by-supplier',
          'الفواتير بحسب الموردين',
          'Invoices by supplier',
          '/reports/invoices-by-supplier',
          'ready',
          { permission: 'reporting.view' },
        ),
      ],
    },
    {
      key: 'purchases-other',
      labelAr: 'أخرى',
      labelEn: 'Other',
      items: [
        screen('supplier-card', 'بطاقة مورد', 'Supplier card', '/purchases/suppliers', 'ready', {
          permission: 'parties.view',
          endpoint: '/parties?kind=supplier',
        }),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// 4. المبيعات
// ---------------------------------------------------------------------------
const sales: ModuleNode = {
  key: 'sales',
  icon: '🧾',
  labelAr: 'المبيعات',
  labelEn: 'Sales',
  href: '/sales/invoices',
  permission: 'sales.view',
  groups: [
    {
      key: 'sales-ops',
      labelAr: 'العمليات',
      labelEn: 'Operations',
      items: [
        screen('pos', 'نقطة البيع', 'Point of sale', '/sales/pos', 'ready', {
          permission: 'sales.invoice.create',
          endpoint: 'POST /sales/invoices',
        }),
        screen('pos-offline', 'نقطة البيع أوفلاين', 'Offline POS', '/pos/offline', 'ready', {
          permission: 'pos.operate',
          endpoint: 'GET /pos/offline-data · POST /pos/offline-sync',
        }),
        screen('pos-offline-queue', 'طابور POS أوفلاين', 'Offline POS queue', '/pos/offline-queue', 'ready', {
          permission: 'pos.operate',
          endpoint: 'POST /pos/offline-sync',
        }),
        screen('sales-invoice', 'فاتورة مبيعات', 'Sales invoice', '/sales/invoices', 'ready', {
          endpoint: '/sales/invoices',
        }),
        screen('cash-customer', '👤 عميل نقدي', 'Cash customer', '/sales/cash-customers', 'ready', {
          endpoint: '/sales/cash-customers',
        }),
        screen('sales-return', 'مردود المبيعات', 'Sales return', '/sales/returns', 'ready', {
          permission: 'sales.return.create',
          endpoint: 'POST /sales/invoices/{id}/return',
        }),
        screen('quotation', 'عرض سعر', 'Quotation', '/sales/quotations', 'ready', {
          permission: 'sales.view',
          endpoint: '/sales/quotations',
        }),
        screen(
          'contracting-return',
          'مرتجع مقاولات',
          'Contracting return',
          '/projects/contracting-return',
          'ready',
          { permission: 'projects.manage', endpoint: '/contracting/returns' },
        ),
      ],
    },
    {
      key: 'sales-vouchers',
      labelAr: 'السندات',
      labelEn: 'Vouchers',
      items: [
        screen('sales-debit-note', 'إشعار مدين', 'Debit note', '/sales/notes/debit', 'ready', {
          permission: 'sales.view',
          endpoint: '/sales/adjustment-notes',
        }),
      ],
    },
    {
      key: 'sales-notes',
      labelAr: 'الإشعارات',
      labelEn: 'Notes',
      items: [
        screen('sn-credit', 'إشعار دائن', 'Credit note', '/sales/notes/credit', 'ready', {
          permission: 'sales.view',
          endpoint: '/sales/adjustment-notes',
        }),
        screen('sn-report', 'تقرير الإشعارات', 'Notes report', '/reports/sales-notes', 'ready', {
          permission: 'reporting.view',
        }),
      ],
    },
    {
      key: 'sales-reports',
      labelAr: 'التقارير',
      labelEn: 'Reports',
      items: [
        screen(
          'sales-invoices-report',
          'تقرير فواتير المبيعات',
          'Sales invoices',
          '/reports/sales-invoices',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/sales' },
        ),
        screen(
          'sales-returns-report',
          'تقرير مردود فواتير المبيعات',
          'Sales returns',
          '/reports/sales-returns',
          'ready',
          { permission: 'reporting.view' },
        ),
        screen(
          'sales-movement-items',
          'إجمالي حركة المواد',
          'Sales item movement',
          '/reports/sales-movement-items',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/sales-movement-items' },
        ),
        screen(
          'sales-movement-invoices',
          'عرض الفواتير',
          'Sales invoice movement',
          '/reports/sales-movement-invoices',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/sales-movement-invoices' },
        ),
        screen('net-sales', 'صافي المبيعات', 'Net sales', '/reports/net-sales', 'ready', {
          permission: 'reporting.view',
        }),
        screen(
          'items-sales-summary',
          'مبيعات الأصناف تجميعي',
          'Item sales summary',
          '/reports/items-sales-summary',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/items-sales-summary' },
        ),
        screen(
          'items-pos-sales-summary',
          'مبيعات الأصناف تجميعي - نقطة البيع',
          'POS item sales summary',
          '/reports/items-pos-sales-summary',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/items-pos-sales-summary' },
        ),
        screen(
          'items-profit-summary',
          'أرباح المواد تجميعي',
          'Item profit summary',
          '/reports/items-profit-summary',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/items-profit-summary' },
        ),
        screen(
          'sales-invoices-details',
          'تقرير فواتير المبيعات',
          'Sales invoices details',
          '/reports/sales-invoices-details',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/sales-invoices-details' },
        ),
        screen(
          'pos-sales-invoices-details',
          'تقرير مبيعات الفواتير',
          'POS invoices details',
          '/reports/pos-sales-invoices-details',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/pos-sales-invoices-details' },
        ),
        screen(
          'sales-notifications',
          'تقرير الإشعارات',
          'Sales notifications',
          '/reports/sales-notifications',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/sales-notifications' },
        ),
        screen('daily-sales', 'تقرير مبيعات حسب اليوم', 'Daily sales', '/reports/daily-sales', 'ready', {
          permission: 'reporting.view',
          endpoint: '/reports/daily-sales',
        }),
        screen(
          'daily-process',
          'تقرير الحركة اليومية',
          'Daily movements',
          '/reports/daily-process',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/daily-process' },
        ),
        screen(
          'sales-inv-analysis',
          'تقرير تحليل المبيعات',
          'Sales analysis',
          '/reports/sales-inv-analysis',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/sales-inv-analysis' },
        ),
        // 📚 الجزء الرابع — تقارير المخزون والأرقام التسلسلية
        screen(
          'inventory-documents',
          'تقرير مستندات المخزون',
          'Inventory documents',
          '/reports/inventory-documents',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/inventory-documents' },
        ),
        screen(
          'item-movement-totals',
          'مادة باجمالي الحركات',
          'Item movement totals',
          '/reports/item-movement-totals',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/item-movement-totals' },
        ),
        screen(
          'item-movement-details',
          'حركة صنف تفصيلي',
          'Item movement details',
          '/reports/item-movement-details',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/item-movement-details' },
        ),
        screen('item-expiry', 'صلاحية المواد', 'Item expiry', '/reports/item-expiry', 'ready', {
          permission: 'reporting.view',
          endpoint: '/reports/item-expiry',
        }),
        screen(
          'serial-movements',
          'حركة الأرقام التسلسلية',
          'Serial number movements',
          '/reports/serial-movements',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/serial-movements' },
        ),
        screen(
          'serial-balances',
          'أرصدة الأرقام التسلسلية',
          'Serial number balances',
          '/reports/serial-balances',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/serial-balances' },
        ),
        screen('produced-items', 'تقرير مواد المنتجة', 'Produced items', '/reports/produced-items', 'ready', {
          permission: 'reporting.view',
          endpoint: '/reports/produced-items',
        }),
        screen(
          'produced-components',
          'مكونات المواد المنتجة',
          'Produced item components',
          '/reports/produced-components',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/produced-components' },
        ),
        screen(
          'items-sales-by-category',
          'تقرير مبيعات الأصناف حسب المجموعة',
          'Item sales by category',
          '/reports/items-sales-by-category',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/items-sales-by-category' },
        ),
        screen(
          'category-sales-by-day',
          'تقرير المبيعات اليومية للمجموعة',
          'Category sales by day',
          '/reports/category-sales-by-day',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/category-sales-by-day' },
        ),
        screen('sales-detail', 'مبيعات تفصيلية', 'Detailed sales', '/reports/sales-detail', 'ready', {
          permission: 'reporting.view',
        }),
        screen('sales-items', 'مبيعات الأصناف تجميعي', 'Sales by item', '/reports/sales-by-item', 'ready', {
          permission: 'reporting.view',
        }),
        screen(
          'sales-by-category',
          'مبيعات بحسب الفئة',
          'Sales by category',
          '/reports/sales-by-category',
          'ready',
          { permission: 'reporting.view' },
        ),
        screen(
          'sales-invoice-profit',
          'أرباح الفواتير',
          'Invoice profit',
          '/reports/invoice-profit',
          'ready',
          { permission: 'reporting.view', endpoint: 'GET /reports/invoice-profit' },
        ),
        screen('item-profit', 'أرباح الأصناف', 'Item profit', '/reports/item-profit', 'ready', {
          permission: 'reporting.view',
        }),
        screen(
          'item-profit-detail',
          'تفاصيل أرباح الأصناف',
          'Item profit detail',
          '/reports/item-profit-detail',
          'ready',
          { permission: 'reporting.view' },
        ),
        screen('reps-report', 'تقرير المندوبين', 'Sales reps', '/reports/sales-by-salesman', 'ready', {
          permission: 'reporting.view',
        }),
        screen(
          'salesman-commissions',
          '📋 طباعة فواتير مندوب وعمولاتهم',
          'Salesman commissions',
          '/sales/salesman-commissions',
          'ready',
          {
            /**
             * `frmInvBySalesMen` — the window `frmSalesMen` opens with
             * «📋 طباعة فواتير مندوب وعمولاتهم» L272. It reads three ledgers of the sales
             * module (فواتير · إشعارات مدين · سندات قبض), so it lives here and answers to
             * `sales.view` rather than to the report engine's `reporting.view`.
             */
            permission: 'sales.view',
            endpoint: 'GET /sales/salesmen/commissions',
          },
        ),
        screen('employee-sales', 'مبيعات موظف', 'Sales by employee', '/reports/sales-by-employee', 'ready', {
          permission: 'reporting.view',
        }),
        screen('customer-statement', 'كشف عميل', 'Customer statement', '/sales/statements', 'ready', {
          permission: 'parties.view',
          endpoint: '/parties/{id}/statement',
        }),
        screen(
          'customer-balances',
          'أرصدة حساب العملاء',
          'Customer account balances',
          '/reports/customer-balances',
          'ready',
          { permission: 'reporting.view', endpoint: '/reports/party-balances' },
        ),
        screen(
          'customer-last-payment',
          'حركة آخر سداد للعملاء',
          'Last payment movement',
          '/reports/customer-last-payment',
          'ready',
          { permission: 'reporting.view' },
        ),
        screen(
          'customer-settlements',
          'سداد العملاء',
          'Customer settlements',
          '/reports/customer-settlements',
          'ready',
          { permission: 'reporting.view' },
        ),
        screen(
          'invoices-by-customer',
          'الفواتير بحسب العملاء',
          'Invoices by customer',
          '/reports/invoices-by-customer',
          'ready',
          { permission: 'reporting.view' },
        ),
        screen('sales-movement', 'حركة المبيعات', 'Sales movement', '/reports/sales-by-day', 'ready', {
          permission: 'reporting.view',
        }),
        screen('sales-chart', 'تقرير بياني', 'Chart report', '/reports/monthly-sales', 'ready', {
          permission: 'reporting.view',
        }),
        screen(
          'contracting-invoices-report',
          'تقرير فواتير المقاولات',
          'Contracting invoices',
          '/reports/project-bills',
          'ready',
          { permission: 'reporting.view' },
        ),
      ],
    },
    {
      key: 'sales-pos-reports',
      labelAr: 'تقارير نقطة البيع',
      labelEn: 'POS reports',
      items: [
        screen('pos-sales', 'تقرير مبيعات POS', 'POS sales', '/reports/pos-sales', 'ready', {
          permission: 'reporting.view',
          endpoint: '/pos/reports/sales',
        }),
        screen(
          'pos-item-detail',
          'تفاصيل أصناف POS',
          'POS item detail',
          '/reports/pos-item-detail',
          'ready',
          { permission: 'reporting.view' },
        ),
        screen(
          'pos-item-summary',
          'أصناف POS تجميعي',
          'POS item summary',
          '/reports/pos-item-summary',
          'ready',
          { permission: 'reporting.view' },
        ),
        screen('pos-daily', 'تقرير المبيعات اليومية', 'Daily sales', '/reports/pos-daily', 'ready', {
          permission: 'reporting.view',
        }),
        screen('pos-group', 'تقرير مبيعات للمجموعة', 'Sales by group', '/reports/pos-by-category', 'ready', {
          permission: 'reporting.view',
        }),
      ],
    },
    {
      key: 'sales-other',
      labelAr: 'أخرى',
      labelEn: 'Other',
      items: [
        screen('customer-card', 'بطاقة عميل', 'Customer card', '/sales/customers', 'ready', {
          permission: 'parties.view',
          endpoint: '/parties?kind=customer',
        }),
        screen('rep-card', 'بطاقة مندوب', 'Sales rep card', '/sales/salesmen', 'ready', {
          permission: 'sales.view',
          endpoint: '/sales/salesmen',
        }),
        screen(
          'customer-portal-access',
          'وصول العملاء للبوابة',
          'Customer portal access',
          '/sales/portal-access',
          'ready',
          { permission: 'parties.view', endpoint: '/portal-access' },
        ),
        screen(
          'ecommerce-orders',
          'طلبات المتجر الإلكتروني',
          'E-commerce orders',
          '/sales/ecommerce-orders',
          'ready',
          {
            permission: 'ecommerce.manage',
            endpoint: 'GET /ecommerce/orders?store_id=&status=',
          },
        ),
        screen('crm-pipelines', 'مسار المبيعات', 'CRM pipeline', '/crm/pipelines', 'ready', {
          permission: 'crm.deals.view',
          endpoint: 'GET/POST /crm/pipelines · GET/POST /crm/deals · PUT /crm/deals/:id/move',
        }),
        screen('crm-activities', 'أنشطة المبيعات', 'CRM activities', '/crm/activities', 'ready', {
          permission: 'crm.deals.view',
          endpoint: 'GET /crm/activities · POST /crm/deals/:id/activities',
        }),
        screen('crm-forecast', 'تنبؤ المبيعات', 'Sales forecast', '/crm/forecast', 'ready', {
          permission: 'crm.deals.view',
          endpoint: 'GET /crm/forecast',
        }),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// 5. التفصيل
// ---------------------------------------------------------------------------
/**
 * 🧵 التفصيل — `Form_WPF/frmOrders.xaml` («إدارة طلبات التفصيل»),
 * `Form_WPF/frmOrderDetails.xaml` («إضافة طلب تفصيل») و`Form_WPF/frmOptions.xaml`
 * («⚙️ إدارة الخيارات الجاهزة»). The desktop reaches them from its التفصيل menu; the
 * القياسات half of the trade (`frmMeasurements`) is a later part of this phase.
 */
const tailoring: ModuleNode = {
  key: 'tailoring',
  icon: '🧵',
  labelAr: 'التفصيل',
  labelEn: 'Tailoring',
  href: '/tailoring/orders',
  permission: 'tailoring.view',
  groups: [
    {
      key: 'tailoring-orders',
      labelAr: 'الطلبات',
      labelEn: 'Orders',
      items: [
        screen('tailoring-order', 'إدارة طلبات التفصيل', 'Tailoring orders', '/tailoring/orders', 'ready', {
          permission: 'tailoring.view',
          endpoint: '/tailoring/orders',
        }),
        // 🧾 فاتورة التفصيل — `frmViewOrders.xaml` («عرض الطلبات - ViewOrders») reads
        // `Inv_Tailor`, a different document from the طلب of `frmOrders`.
        screen('tailoring-invoice', 'فواتير التفصيل', 'Tailoring invoices', '/tailoring/invoices', 'ready', {
          permission: 'tailoring.view',
          endpoint: '/tailoring/invoices',
        }),
      ],
    },
    {
      key: 'tailoring-measurements',
      labelAr: 'القياسات',
      labelEn: 'Measurements',
      items: [
        // 📏 القياسات — `frmMeasurements.xaml` («إدارة قياسات العملاء»).
        screen(
          'tailoring-measurement',
          'قياسات العملاء',
          'Customer measurements',
          '/tailoring/measurements',
          'ready',
          {
            permission: 'tailoring.view',
            endpoint: '/tailoring/measurements',
          },
        ),
        // 📏 خصائص القياسات — `frmMeasurementAttributes.xaml` («إدارة خصائص القياسات»).
        screen(
          'tailoring-measurement-attribute',
          'خصائص القياسات',
          'Measurement attributes',
          '/tailoring/measurements/attributes',
          'ready',
          {
            permission: 'tailoring.view',
            endpoint: '/tailoring/measurement-attributes',
          },
        ),
      ],
    },
    {
      key: 'tailoring-catalogue',
      labelAr: 'التعاريف',
      labelEn: 'Catalogue',
      items: [
        screen(
          'tailoring-options',
          'إدارة الخيارات الجاهزة',
          'Tailoring options',
          '/tailoring/options',
          'ready',
          {
            permission: 'tailoring.view',
            endpoint: '/tailoring/option-categories',
          },
        ),
        screen('tailoring-type', 'أنواع التفصيل', 'Tailoring types', '/tailoring/types', 'ready', {
          permission: 'tailoring.view',
          endpoint: '/tailoring/types',
        }),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// 5b. النظارات
//
// `Form_WPF/frmGlasses.xaml` («👓 بيانات النظارات») — one window, two tabs: «👓  القياسات»
// (the ten values of the two eyes) and «⚙  أسماء الحقول» (the ten captions, saved by
// «💾 حفظ الأسماء»). The desktop opens the قياسات from a sale invoice
// (`frmInvSale.glassesOptions` L2505, Alt+G) and the captions from the definitions entry;
// both are one module here.
// ---------------------------------------------------------------------------
const optics: ModuleNode = {
  key: 'optics',
  icon: '👓',
  labelAr: 'النظارات',
  labelEn: 'Optics',
  href: '/optics/prescriptions',
  permission: 'optics.view',
  groups: [
    {
      key: 'optics-prescriptions',
      labelAr: 'الوصفات',
      labelEn: 'Prescriptions',
      items: [
        // 👓 بيانات النظارات — `Glasses(InvGlobalID, ItemId, orientation, SPH, CYL, AX, ADD, IPD)`.
        screen(
          'optics-prescription',
          'بيانات النظارات',
          'Glasses prescriptions',
          '/optics/prescriptions',
          'ready',
          {
            permission: 'optics.view',
            endpoint: '/optics/prescriptions',
          },
        ),
      ],
    },
    {
      key: 'optics-defs',
      labelAr: 'التعاريف',
      labelEn: 'Definitions',
      items: [
        // ⚙️ أسماء الحقول — `Other_Column(R1…R5, L1…L5)`.
        screen('optics-field-label', 'أسماء الحقول', 'Field labels', '/optics/field-labels', 'ready', {
          permission: 'optics.view',
          endpoint: '/optics/field-labels',
        }),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// 6. الموظفين والرواتب
// ---------------------------------------------------------------------------
const hrm: ModuleNode = {
  key: 'hrm',
  icon: '👥',
  labelAr: 'الموظفين والرواتب',
  labelEn: 'HR & Payroll',
  href: '/hrm/employees',
  permission: 'hrm.view',
  groups: [
    {
      key: 'hrm-defs',
      labelAr: 'التعاريف',
      labelEn: 'Definitions',
      items: [
        // 🏢 `frmManagement.xaml` («الإدارات») + `frmDepartments.xaml`
        // («إدخال بيانات الإدارات والأقسام») — one window over the two-level unit, and
        // `frmJobs.xaml` («الوظائف») beside it.
        screen('departments', 'الإدارات والأقسام', 'Departments & sections', '/hrm/departments', 'ready', {
          endpoint: '/hrm/departments',
        }),
        screen('jobs', 'الوظائف', 'Jobs', '/hrm/jobs', 'ready', { endpoint: '/hrm/jobs' }),
        screen('employee', 'تعريف موظف', 'Employee', '/hrm/employees', 'ready', {
          endpoint: '/hrm/employees',
        }),
      ],
    },
    {
      key: 'hrm-ops',
      labelAr: 'العمليات',
      labelEn: 'Operations',
      items: [
        screen('adjustments', 'الحوافز والجزاءات', 'Bonuses & deductions', '/hrm/adjustments', 'ready', {
          endpoint: '/hrm/adjustments',
        }),
        screen('payroll-run', 'إستحقاق وصرف الرواتب', 'Payroll run and payment', '/hrm/payroll', 'ready', {
          endpoint: '/hrm/payroll/runs',
        }),
        screen('hrm-compliance', 'تنبيهات الإقامة والتأمين', 'Iqama and insurance alerts', '/hrm/compliance', 'ready', {
          permission: 'hrm.view',
          endpoint: 'GET /hrm/compliance/alerts',
        }),
        screen('hrm-leaves', 'إجازات الموظفين', 'Approved leave', '/hrm/leaves', 'ready', {
          permission: 'hrm.view',
          endpoint: 'GET /hrm/employee-leaves',
        }),
        screen('hrm-geofences', 'نطاق حضور الفروع', 'Attendance geofence', '/hrm/geofences', 'ready', {
          permission: 'hrm.manage',
          endpoint: 'GET/PUT /hrm/geofences',
        }),
        // 💵 `Form_WPF/frmSalaryPay.xaml` «دفع الرواتب» — one إذن صرف per employee per
        // month. The row under «التقارير» with the same name is the report
        // (`frmRptSalary`); the window itself belongs here, next to the مسيّر it pays.
        screen('salary-payments', 'دفع الرواتب', 'Salary payment', '/hrm/salary-payments', 'ready', {
          endpoint: '/hrm/salary-payments',
        }),
      ],
    },
    {
      key: 'hrm-reports',
      labelAr: 'التقارير',
      labelEn: 'Reports',
      items: [
        // 📊 `Form_WPF/frmRptSalary.xaml` «تقرير الرواتب» — every إذن صرف, month by
        // month. The row under this name used to point at `/reports/payroll-payments`,
        // which is the مسيّر report («دفع الرواتب»), not this window.
        screen('salary-report', 'تقرير الرواتب', 'Salary report', '/hrm/salary-report', 'ready', {
          permission: 'hrm.view',
          endpoint: '/hrm/reports/salary',
        }),
        // The مسيّر itself, from the report engine — its label is the catalog's own.
        screen(
          'salary-payments-report',
          'دفع الرواتب',
          'Payroll payments report',
          '/reports/payroll-payments',
          'ready',
          { permission: 'reporting.view' },
        ),
        // 📈 `Form_WPF/frmEmpInvs.xaml` «مبيعات ومشتريات موظف خلال الفترة» — what a
        // salesman sold, line by line. The row is named for what the cloud can actually
        // serve: a purchase invoice carries no employee, so the مشتريات half is not here.
        screen(
          'employee-movements',
          'حركات الموظف',
          'Employee movements',
          '/hrm/employee-movements',
          'ready',
          {
            permission: 'hrm.view',
            endpoint: '/hrm/employee-movements',
          },
        ),
        // 📄 `Form_WPF/frmEmpAccountGet.xaml` «كشف حساب موظف» — the employee's account
        // statement. It used to sit under `/reports/employee-account`, a route that was
        // never built; the screen lives with the employees it reports on.
        screen(
          'employee-account',
          'كشف حساب موظف',
          'Employee account statement',
          '/hrm/employee-statement',
          'ready',
          {
            permission: 'hrm.view',
            endpoint: '/hrm/employee-statement',
          },
        ),
        screen('user-logs', 'سجلات المستخدمين', 'User logs', '/settings/audit', 'ready', {
          permission: 'tenant.audit.view',
          endpoint: '/audit-log',
        }),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// 6. إدارة المراسي
// ---------------------------------------------------------------------------
const marina: ModuleNode = {
  key: 'marina',
  icon: '⛵',
  labelAr: 'إدارة المراسي',
  labelEn: 'Marina',
  href: '/marina/vessels',
  permission: 'marina.view',
  groups: [
    {
      key: 'marina-defs',
      labelAr: 'التعاريف',
      labelEn: 'Definitions',
      items: [
        // 📋 بطاقة فئة — `frmGroupM.xaml` («📋 بطاقة فئة») و`frmAddPeriod.xaml`
        // («⏰ إدارة فترات التأجير»): الفئة وتسعيرها، ثم «📋 قائمة الفئات».
        screen(
          'marina-group',
          'بطاقة الفئة وفترات التأجير',
          'Group card and rental periods',
          '/marina/groups',
          'ready',
          { endpoint: '/marina/groups' },
        ),
        screen(
          'marina-vessel',
          'بطاقات النماذج والمراكب والملاك',
          'Model, vessel and owner cards',
          '/marina/vessels',
          'ready',
          { endpoint: '/marina' },
        ),
        // 📋 إضافات — `frmAdditions.xaml` («📋 إضافات»): الرقم والاسم والقيمة، وهي ما
        // يملأ «🎁 الإضافات» في `frmBookingM` («الحجوزات»).
        screen('marina-additions', 'الإضافات', 'Booking additions', '/marina/additions', 'ready', {
          endpoint: '/marina/additions',
        }),
      ],
    },
    {
      key: 'marina-manage',
      labelAr: 'إدارة',
      labelEn: 'Management',
      items: [
        screen('marina-prep', 'تحضير المراكب', 'Vessel preparation', '/marina/preparation', 'ready', {
          permission: 'marina.view',
          endpoint: '/marina/preparations',
        }),
        screen('marina-violations', 'المخالفات', 'Violations', '/marina/violations', 'ready', {
          endpoint: '/marina/violations',
        }),
        screen('marina-rota', 'خطة الدور', 'Rotation plan', '/marina/rota', 'ready', {
          permission: 'marina.view',
          endpoint: '/marina/operation-plans',
        }),
      ],
    },
    {
      key: 'marina-ops',
      labelAr: 'العمليات',
      labelEn: 'Operations',
      items: [
        // 🧾 بحث الفواتير — `frmInvoiceRentSrch.xaml` («بحث الفواتير»): «🔍 خيارات البحث»
        // و«🧾 قائمة الفواتير»؛ وإصدار فاتورة التأجير من حجزٍ بلا فاتورة يسكن الشاشة نفسها.
        screen('marina-link', 'بحث الفواتير', 'Rental invoice search', '/marina/link-invoices', 'ready', {
          permission: 'marina.view',
          endpoint: '/marina/rental-invoices',
        }),
        // ⛵ الحجوزات — `frmBookingM.xaml` («الحجوزات»): «📋 بيانات الحجوزات» و«🔍 البحث».
        screen('marina-bookings', 'الحجوزات', 'Bookings', '/marina/bookings', 'ready', {
          endpoint: '/marina/bookings',
        }),
        screen('marina-day-close', 'إغلاق اليومية', 'Day close', '/marina/day-close', 'ready', {
          permission: 'marina.view',
          endpoint: '/marina/day-close',
        }),
      ],
    },
    {
      key: 'marina-reports',
      labelAr: 'التقارير',
      labelEn: 'Reports',
      items: [
        screen('marina-day-closes', 'إغلاقات اليومية', 'Day closes', '/reports/cashier-shift', 'ready', {
          permission: 'reporting.view',
        }),
        screen(
          'marina-rental-invoices',
          'تقرير فواتير التأجير',
          'Rental invoices',
          '/reports/marina-rentals',
          'ready',
          { permission: 'reporting.view' },
        ),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// 7. إدارة المشاريع
// ---------------------------------------------------------------------------
const projects: ModuleNode = {
  key: 'projects',
  icon: '🏗️',
  labelAr: 'إدارة المشاريع',
  labelEn: 'Projects',
  href: '/projects',
  permission: 'projects.view',
  groups: [
    {
      key: 'projects-defs',
      labelAr: 'التعاريف',
      labelEn: 'Definitions',
      items: [
        screen('boq-item', 'بطاقة بند', 'BOQ item card', '/projects/boq', 'ready', {
          permission: 'projects.manage',
          endpoint: 'GET/POST /projects/{id}/boq · PATCH/DELETE /projects/boq/{termId}',
        }),
        screen('project-stages', 'مراحل مشروع', 'Project stages', '/projects/stages', 'ready', {
          permission: 'projects.manage',
          endpoint: 'GET/POST /projects/stage-templates · POST/PATCH/DELETE /projects/stages/{stageId}',
        }),
      ],
    },
    {
      key: 'projects-ops',
      labelAr: 'العمليات',
      labelEn: 'Operations',
      items: [
        screen('customer-contract', 'عقد عميل', 'Customer contract', '/projects', 'ready', {
          endpoint: '/projects',
        }),
        screen(
          'contractor-contract',
          'عقد مقاول',
          'Contractor contract',
          '/projects/contractor-contract',
          'ready',
          { permission: 'projects.manage', endpoint: '/contracting/contracts' },
        ),
        screen('project-followup', 'متابعة', 'Follow-up', '/projects/followup', 'ready', {
          permission: 'projects.view',
          endpoint: '/projects/{id}',
        }),
        screen('project-board', 'لوحة كانبان', 'Kanban board', '/projects/board', 'ready', {
          permission: 'projects.tasks.view',
          endpoint: 'GET/POST /projects/{id}/tasks · PUT /projects/tasks/{id}/move',
        }),
        screen('project-gantt', 'مخطط جانت', 'Gantt', '/projects/gantt', 'ready', {
          permission: 'projects.tasks.view',
          endpoint: 'GET /projects/{id}/gantt',
        }),
        screen('project-time', 'تتبع الوقت', 'Time tracking', '/projects/time', 'ready', {
          permission: 'projects.tasks.view',
          endpoint: 'GET /projects/{id}/time · POST /projects/tasks/{id}/time-logs',
        }),
        screen('project-cost', 'تكلفة المشروع', 'Project cost', '/projects/cost', 'ready', {
          permission: 'projects.tasks.view',
          endpoint: 'GET /projects/{id}/cost',
        }),
        screen('project-offers', 'عروض', 'Offers', '/projects/offers', 'ready', {
          permission: 'projects.manage',
          endpoint: '/contracting/offers',
        }),
        screen(
          'contractor-payment',
          'سند دفع لمقاول',
          'Contractor payment',
          '/projects/contractor-payment',
          'ready',
          { permission: 'projects.contractor.pay', endpoint: 'POST /contracting/contracts/{id}/payments' },
        ),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// 9. الإعدادات
// ---------------------------------------------------------------------------
const settings: ModuleNode = {
  key: 'settings',
  icon: '⚙️',
  labelAr: 'الإعدادات',
  labelEn: 'Settings',
  href: '/settings/company',
  groups: [
    {
      key: 'settings-org',
      labelAr: 'تعاريف المنشأة',
      labelEn: 'Organisation',
      items: [
        screen('company-card', 'بطاقة المنشأة', 'Company card', '/settings/company', 'ready', {
          permission: 'organization.companyprofile.view',
          endpoint: '/company-profile',
        }),
        screen('branch-card', 'بطاقة فرع', 'Branch card', '/settings/branches', 'ready', {
          permission: 'organization.branch.view',
          endpoint: '/branches',
        }),
        screen(
          'posting-profiles',
          'الربط المحاسبي',
          'Posting profiles',
          '/settings/posting-profiles',
          'ready',
          { permission: 'organization.postingprofile.view', endpoint: '/branch-posting-profiles' },
        ),
        screen(
          'zatca-settings',
          'إعدادات الربط مع هيئة الزكاة والضريبة',
          'ZATCA integration',
          '/settings/zatca',
          'ready',
          { permission: 'einvoice.view', endpoint: '/einvoice/settings' },
        ),
        screen(
          'zatca-sent',
          'الفواتير المرفوعة على موقع الضرائب',
          'Sent e-invoices',
          '/settings/zatca/sent',
          'ready',
          { permission: 'einvoice.view', endpoint: '/einvoice/filings' },
        ),
        screen(
          'zatca-status',
          'مزامنة الفواتير - ZATCA',
          'ZATCA invoice sync',
          '/settings/zatca/status',
          'ready',
          {
            permission: 'einvoice.view',
            endpoint: 'GET /reports/einvoice-sync-status · POST /einvoice/sync',
          },
        ),
        screen(
          'payment-gateways',
          'بوابات الدفع — جيديا · NeoLeap',
          'Payment gateways',
          '/settings/payment-gateways',
          'ready',
          {
            permission: 'pos.config.manage',
            endpoint: 'GET /payment-gateways · PUT · POST /:provider/test · POST /:provider/sale',
          },
        ),
        screen('online-payments', 'روابط الدفع — ميسر', 'Online payment links', '/settings/payments', 'ready', {
          permission: 'payments.links.manage',
          endpoint: 'GET/POST /payments/providers · POST /payments/links · POST /payments/webhooks/:provider',
        }),
        screen('whatsapp', 'واتساب — إرسال الفواتير', 'WhatsApp', '/settings/whatsapp', 'ready', {
          permission: 'tenant.settings.manage',
          endpoint:
            'GET /whatsapp/settings · PUT · POST /whatsapp/test · POST /whatsapp/send · GET /whatsapp/messages',
        }),
        // P-C6 — البريد: نصّ رسائلنا، وسجلّ ما خرج باسمنا، وهوِيّة المُرسِل. الوصول إلى
        // السجلّ `tenant.email.log.view` (مدقّق المنشأة يراه بلا قدرة على التعديل)، وتحرير
        // النصّ `tenant.email.template.manage`. ولا شاشة إرسال: الإرسال فعلُ حدثٍ في النظام.
        screen('email', 'البريد — القوالب والسجلّ', 'E-mail', '/settings/email', 'ready', {
          permission: 'tenant.email.log.view',
          endpoint:
            'GET /email/messages · GET /email/templates · PUT /email/templates/:event · GET/PUT /email/settings',
        }),
        screen(
          'ecommerce',
          'التجارة الإلكترونية — سلة · زد · Shopify',
          'E-commerce',
          '/settings/ecommerce',
          'ready',
          {
            permission: 'ecommerce.manage',
            endpoint:
              'GET /ecommerce/providers · POST/GET /ecommerce/stores · POST /ecommerce/stores/:id/sync',
          },
        ),
        screen('marketplace', 'سوق الإضافات', 'Marketplace', '/settings/marketplace', 'ready', {
          permission: 'tenant.apps.manage',
          endpoint: 'GET /marketplace/apps · POST /marketplace/apps/:code/install · DELETE /marketplace/apps/:code',
        }),
        screen('white-label', 'الدومين والشعار', 'White label', '/settings/white-label', 'ready', {
          permission: 'tenant.apps.manage',
          endpoint:
            'GET/POST /settings/white-label/domains · POST /settings/white-label/domains/:id/verify · GET/PUT /settings/white-label/branding',
        }),
        screen(
          'approval-settings',
          'مسارات الموافقات',
          'Approval workflows',
          '/settings/approvals',
          'ready',
          {
            permission: 'approval.manage',
            endpoint: 'GET/POST/PATCH /approval-workflows · GET/POST /approval-workflows/:id/steps',
          },
        ),
        screen('custom-fields', 'الحقول الإضافية', 'Custom fields', '/settings/custom-fields', 'ready', {
          permission: 'custom_fields.view',
          endpoint: 'GET/POST/PUT/DELETE /custom-fields',
        }),
      ],
    },
    {
      key: 'settings-admin',
      labelAr: 'إعدادات إدارية',
      labelEn: 'Administrative',
      items: [
        // 📄 مدير الملفات — R7. مقابله في الديسكتوب نافذة «الوثائق» (`frmshowdocument.xaml`)
        // التي تُفتح من كل مستندٍ وبطاقة، وتعرض مرفقات **ذلك** المستند وحدها. والسحابة
        // تخزّن الكائنات في مساحة المنشأة كلها، فالشاشة تعرض المخزن كله ومعه مرشّح
        // «مرتبط بـ» ليُقرأ المستند الواحد كما كان — ونصّ الحذف والتأكيد من النافذة نفسها.
        screen('file-manager', 'مدير الملفات', 'File manager', '/settings/files', 'ready', {
          permission: 'tenant.file.upload',
          endpoint: 'GET /files · POST /files/presign · DELETE /files/:id',
          description:
            'frmshowdocument.xaml («الوثائق» · «📄 الوثائق المرفقة») — المخزن الكامل: بحثٌ وترشيحٌ بالحالة وبالمستند المرتبط، وتنزيلٌ برابطٍ موقّع قصير العمر، ورفعٌ مباشر إلى التخزين الكائني (بلا مرور البايتات بالـAPI)، وحذفٌ ناعم برمزه `tenant.file.manage`.',
        }),
        screen('backup', 'النسخ الإحتياطي', 'Backup', '/settings/backup', 'ready', {
          permission: 'settings.backup.manage',
          endpoint: '/settings/backups',
        }),
        screen('data-rotation', 'تدوير البيانات', 'Data rotation', '/settings/data-rotation', 'ready', {
          permission: 'settings.rotation.manage',
          endpoint: '/settings/data-rotation',
        }),
        screen('new-file', 'إنشاء ملف', 'New company file', '/settings/new-file', 'ready', {
          permission: 'settings.companyfile.create',
          endpoint: '/settings/company-files',
        }),
        screen('import-export', 'إستيراد وتصدير البيانات', 'Import / export', '/migration/runs', 'ready', {
          permission: 'migration.view',
          endpoint: '/migration/runs',
        }),
        screen(
          'invoice-maintenance',
          'صيانة الفواتير',
          'Invoice maintenance',
          '/settings/invoice-maintenance',
          'ready',
          { permission: 'settings.maintenance.manage', endpoint: '/settings/invoice-maintenance' },
        ),
        screen('offers', 'العروض', 'Offers', '/settings/offers', 'ready', {
          permission: 'sales.view',
          endpoint: '/sales/offers',
        }),
        screen('data-sync', 'مزامنة البيانات', 'Data sync', '/settings/sync', 'ready', {
          permission: 'compat.manage',
          endpoint: '/jobs/outbox',
        }),
        screen('restore', 'إستعادة البيانات', 'Restore', '/settings/restore', 'ready', {
          permission: 'settings.restore.manage',
          endpoint: '/settings/restores',
        }),
      ],
    },
    {
      key: 'settings-ai',
      labelAr: 'المساعد الذكي',
      labelEn: 'Assistant',
      items: [
        screen('ai-assistant', 'المساعد المحاسبي', 'Accounting assistant', '/assistant', 'ready', {
          permission: 'ai.assistant.use',
          endpoint: 'POST /ai/chat · GET /ai/conversations · GET /ai/skills · POST /ai/suggest',
        }),
        screen('ai-settings', 'إعدادات المساعد', 'Assistant settings', '/settings/ai', 'ready', {
          permission: 'ai.settings.manage',
          endpoint: 'GET/PUT /ai/settings',
        }),
      ],
    },
    {
      key: 'settings-users',
      labelAr: 'إعدادات المستخدمين',
      labelEn: 'Users',
      items: [
        screen('user-card', 'بطاقة مستخدم', 'User card', '/settings/users', 'ready', {
          permission: 'tenant.membership.manage',
          endpoint: '/memberships',
        }),
        screen('user-permissions', 'صلاحيات المستخدمين', 'User permissions', '/settings/roles', 'ready', {
          permission: 'tenant.role.manage',
          endpoint: '/roles',
        }),
        screen(
          'change-password',
          'تغيير كلمة المرور',
          'Change password',
          '/settings/change-password',
          'ready',
          { endpoint: 'POST /auth/change-password' },
        ),
        screen('two-factor', 'التحقق بخطوتين', 'Two-factor authentication', '/settings/two-factor', 'ready', {
          endpoint: '/auth/mfa',
        }),
      ],
    },
    {
      key: 'settings-general',
      labelAr: 'إعدادات عامة',
      labelEn: 'General',
      items: [
        screen('general-settings', 'إعدادات عامة', 'General settings', '/settings/general', 'ready', {
          permission: 'tenant.settings.manage',
          endpoint: '/settings',
        }),
        // 📊 الاستخدام والحصص — P-C5 (`PLATFORM_CONSOLE_PLAN.md` §4: «شاشة للمستأجر في
        // staff (`/settings/usage`)»). لا مقابل لها في `Desktop_ERP`: النسخة المكتبية تخدم
        // منشأةً واحدة على جهاز العميل، فلا حصص ولا حدود منصّة. القراءة `tenant.view` لأن
        // الرقم يخصّ المنشأة نفسها؛ ولا كتابة هنا — الحدود يضعها المشغّل في لوحة المنصّة.
        // 🔔 مركز الإشعارات — P-C7 (`PLATFORM_CONSOLE_PLAN.md` §4: «مركز إشعارات في staff:
        // جرس + شاشة» بلا نقاط نهاية جديدة، يستهلك `/notifications` القائم). لا مقابل له في
        // `Desktop_ERP`: المكتبي يعرض تنبيهاً عابراً ولا يُبقي صندوقاً دائماً لكل عضويّة.
        screen('comment-mentions', 'إشارات التعليقات', 'Comment mentions', '/comments/mentions', 'ready', {
          permission: 'comment.view',
          endpoint: 'GET /comments/mentions · POST /comments/mentions/:id/read',
        }),
        screen('notifications', 'مركز الإشعارات', 'Notification centre', '/notifications', 'ready', {
          permission: 'tenant.notification.view',
          endpoint: 'GET /notifications · POST /notifications/:id/read',
          description:
            'PLATFORM_CONSOLE_PLAN.md §4 (P-C7) — كل ما وُجّه للعضويّة: إعلانات المنصة ونصوصها (ar/en) وإشعارات النظام، مع وسم المقروء وعدد غير المقروء نفسه الذي يعرضه الجرس.',
        }),
        screen('approval-inbox', 'وارد الموافقات', 'Approval inbox', '/approvals/inbox', 'ready', {
          permission: 'approval.approve',
          endpoint: 'GET /approvals/inbox · POST /approvals/requests/:id/approve|reject',
        }),
        screen('approval-history', 'سجل الموافقات', 'Approval history', '/approvals/history', 'ready', {
          permission: 'approval.approve',
          endpoint: 'GET /approvals/history',
        }),
        screen('usage', 'الاستخدام والحصص', 'Usage & quotas', '/settings/usage', 'ready', {
          permission: 'tenant.view',
          endpoint: 'GET /usage',
          description:
            'PLATFORM_CONSOLE_PLAN.md §4 (P-C5) — ثمانية مقاييس: المستخدمون · الفروع · الأصناف · فواتير الشهر · التخزين · استدعاءات الـAPI · واتساب · البريد، مع ٨٠٪ ناعم و١٠٠٪ صلب.',
        }),
        // 🖨️ إعدادات الطباعة — `SettingPrint` of the desktop (`frmSettings.xaml`
        // «خيارات الطباعة» + `frmInvRptType.xaml`). Reading them is part of viewing a
        // report; changing them is part of owning the report designer's surface, so the
        // screen carries `reporting.layout.manage`.
        screen('printing-settings', 'إعدادات الطباعة', 'Printing settings', '/settings/printing', 'ready', {
          permission: 'reporting.layout.manage',
          endpoint: 'GET·PUT·DELETE /reports/print-settings/:scope',
          description:
            'frmSettings.xaml «خيارات الطباعة» · frmInvRptType.xaml · Class/Print.cs — رأس · تذييل · ختم · عدد النسخ · الطابعة',
        }),
        screen('language', 'اللغة', 'Language', '/settings/language', 'ready', {
          endpoint: 'client-side preference (localStorage)',
        }),
        screen(
          'prep-device',
          'إعدادات جهاز التحضير',
          'Preparation device',
          '/s/settings/prep-device',
          'planned',
        ),
        screen(
          'salla-settings',
          'إعدادات ربط سلة',
          'Salla integration',
          '/integrations/salla/settings',
          'ready',
          { permission: 'salla.integration.view', endpoint: '/integrations/salla/settings' },
        ),
      ],
    },
    {
      key: 'settings-sync',
      labelAr: 'المزامنة',
      labelEn: 'Synchronisation',
      items: [
        screen('sync-invoices', 'مزامنة الفواتير', 'Invoice sync', '/settings/sync/invoices', 'ready', {
          permission: 'compat.manage',
          endpoint: '/compat/sync/documents?entity=invoices',
        }),
        screen('sync-journals', 'مزامنة القيود', 'Journal sync', '/settings/sync/journals', 'ready', {
          permission: 'compat.manage',
          endpoint: '/compat/sync/documents?entity=journals',
        }),
        screen('sync-vouchers', 'مزامنة السندات', 'Voucher sync', '/settings/sync/vouchers', 'ready', {
          permission: 'compat.manage',
          endpoint: '/compat/sync/documents?entity=vouchers',
        }),
        screen('sync-stock', 'مزامنة المخزون', 'Stock sync', '/settings/sync/stock', 'ready', {
          permission: 'compat.manage',
          endpoint: '/compat/sync/documents?entity=stock',
        }),
        screen('sync-manage', 'إدارة المزامنة', 'Sync management', '/settings/sync/manage', 'ready', {
          permission: 'compat.manage',
          endpoint: '/jobs/queues',
        }),
        screen('sync-prices', 'إعدادات الأسعار', 'Price settings', '/settings/price-lists', 'ready', {
          permission: 'organization.priceList.view',
          endpoint: '/price-lists',
        }),
        screen('sync-zatca', 'مزامنة الفواتير Zatca', 'ZATCA sync', '/settings/sync/zatca', 'ready', {
          permission: 'einvoice.view',
          endpoint: '/einvoice/submissions',
        }),
        screen(
          'android-devices',
          'أجهزة أندرويد المرتبطة',
          'Linked Android devices',
          '/settings/devices',
          'ready',
          { permission: 'compat.manage', endpoint: '/compat/devices' },
        ),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// 10. الدعم الفني
// ---------------------------------------------------------------------------
const support: ModuleNode = {
  key: 'support',
  icon: '🎧',
  labelAr: 'الدعم الفني',
  labelEn: 'Support',
  href: '/support/license',
  groups: [
    {
      key: 'support-main',
      labelAr: 'الدعم',
      labelEn: 'Support',
      items: [
        screen('license', 'الترخيص', 'Licence', '/support/license', 'ready', {
          endpoint: '/billing/subscription',
        }),
        screen('about', 'عن البرنامج', 'About', '/support/about', 'ready'),
        screen('update', 'تحديث البرنامج', 'Update', '/support/about#updates', 'ready'),
        screen(
          'report-designer',
          'فتح المصمم لتصميم التقارير',
          'Report designer',
          '/support/report-designer',
          'ready',
          { permission: 'reporting.layout.manage', endpoint: '/reports/layouts' },
        ),
        screen('help', '🆘 إطلب المساعدة', 'Request help', '/support/help', 'ready'),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// 2. الخزينة
//
// `frmSandQ` / `frmSandD` (the documents), `frmTreasury` / `frmBanks` (the masters) and
// `frmRptKhzna` (the statement) are one module in the desktop too; the voucher screens
// used to sit under المحاسبة › العمليات because the treasury module had no home. They
// moved here — the routes did not change, and no endpoint was touched.
// ---------------------------------------------------------------------------
const treasury: ModuleNode = {
  key: 'treasury',
  icon: '🏦',
  labelAr: 'الخزينة',
  labelEn: 'Treasury',
  href: '/treasury/vouchers',
  permission: 'treasury.view',
  groups: [
    {
      key: 'treasury-defs',
      labelAr: 'تعاريف',
      labelEn: 'Definitions',
      items: [
        screen('safe-card', '🏦 تعريف الخزينة', 'Safes', '/treasury/safes', 'ready', {
          permission: 'organization.cashlocation.view',
          endpoint: '/cash-locations?filter[kind]=safe',
        }),
        screen('bank-def', '🏦 تعريف البنوك', 'Banks', '/treasury/banks', 'ready', {
          permission: 'organization.cashlocation.view',
          endpoint: '/cash-locations?filter[kind]=bank',
        }),
        screen('expense-card', '📒 بطاقة حساب المصاريف', 'Expense card', '/accounting/expenses', 'ready', {
          permission: 'treasury.view',
          endpoint: '/expense-types',
        }),
      ],
    },
    {
      key: 'treasury-bank-feeds',
      labelAr: 'التغذية البنكية',
      labelEn: 'Bank feeds',
      items: [
        screen('bank-accounts', 'الحسابات البنكية', 'Bank accounts', '/treasury/bank-accounts', 'ready', {
          permission: 'treasury.bank.view',
          endpoint: 'GET/POST /treasury/bank-accounts',
        }),
        screen(
          'bank-statements',
          'كشوف الحساب البنكي',
          'Bank statements',
          '/treasury/bank-statements',
          'ready',
          {
            permission: 'treasury.bank.view',
            endpoint: 'POST /treasury/bank-statements/import · GET /treasury/bank-statements',
          },
        ),
        screen(
          'bank-reconciliation',
          'التسوية البنكية',
          'Bank reconciliation',
          '/treasury/bank-reconciliation',
          'ready',
          {
            permission: 'treasury.bank.view',
            endpoint: 'GET /treasury/bank-reconciliation · POST /treasury/bank-statements/:id/auto-match',
          },
        ),
      ],
    },
    {
      key: 'treasury-ops',
      labelAr: 'العمليات',
      labelEn: 'Operations',
      items: [
        screen(
          'receipt-voucher',
          '📄 سند قبض',
          'Receipt voucher',
          '/treasury/vouchers?kind=receipt',
          'ready',
          {
            permission: 'treasury.view',
            endpoint: '/vouchers',
          },
        ),
        screen(
          'payment-voucher',
          '📄 سند صرف',
          'Payment voucher',
          '/treasury/vouchers?kind=payment',
          'ready',
          {
            permission: 'treasury.view',
            endpoint: '/vouchers',
          },
        ),
        screen('day-close', '📊 إغلاق اليومية', 'Day close', '/treasury/day-close', 'ready', {
          permission: 'treasury.view',
          endpoint: '/shift-closes/day-closes',
        }),
        screen('cash-transfer', 'مناقلة', 'Cash transfer', '/treasury/transfers', 'ready', {
          permission: 'treasury.view',
          endpoint: '/cash-transfers',
        }),
      ],
    },
    {
      key: 'treasury-cheques',
      labelAr: 'الشيكات',
      labelEn: 'Cheques',
      items: [
        screen('cheques', '🏦 كشف الشيكات', 'Cheque register', '/treasury/cheques', 'ready', {
          permission: 'treasury.view',
          endpoint: '/vouchers?filter[method]=cheque',
          description:
            'frmSandQ / frmPaymentVoucher — تحت التحصيل/محصّل/مرتجع مع تحصيل بقيد أوراق القبض→صندوق وارتجاع بقيد عكسي',
        }),
      ],
    },
    {
      key: 'treasury-reports',
      labelAr: 'التقارير',
      labelEn: 'Reports',
      items: [
        screen('safe-movement', '🏦 حركة الصندوق', 'Safe movement', '/treasury/movements', 'ready', {
          permission: 'treasury.view',
          endpoint: '/cash-locations/:id/movements',
        }),
      ],
    },
  ],
};

const employeeApp: ModuleNode = {
  key: 'employee-app',
  icon: '📱',
  labelAr: 'تطبيق الموظف',
  labelEn: 'Employee app',
  href: '/m',
  groups: [
    {
      key: 'employee-self',
      labelAr: 'حسابي',
      labelEn: 'Self service',
      items: [
        screen('employee-home', 'تطبيق الموظف', 'Employee app', '/m', 'ready', {
          permission: 'employee.self.view',
          endpoint: 'GET /employee/me',
        }),
        screen('employee-attendance', 'حضور وانصراف', 'Attendance', '/m/attendance', 'ready', {
          permission: 'employee.self.manage',
          endpoint: 'POST /employee/attendance',
        }),
        screen('employee-request', 'طلب جديد', 'New request', '/m/requests/new', 'ready', {
          permission: 'employee.self.manage',
          endpoint: 'POST /employee/requests',
        }),
        screen('employee-profile', 'راتبي وإجازاتي', 'Payslips and leave', '/m/profile', 'ready', {
          permission: 'employee.self.view',
          endpoint: 'GET /employee/payslips',
        }),
      ],
    },
    {
      key: 'employee-team',
      labelAr: 'الفريق',
      labelEn: 'Team',
      items: [
        screen('employee-approvals', 'موافقات الفريق', 'Team approvals', '/m/approvals', 'ready', {
          permission: 'employee.team.approve',
          endpoint: 'POST /employee/requests/:id/approve',
        }),
      ],
    },
  ],
};

const manufacturing: ModuleNode = {
  key: 'manufacturing',
  icon: '⚙️',
  labelAr: 'التصنيع',
  labelEn: 'Manufacturing',
  href: '/manufacturing/orders',
  permission: 'manufacturing.view',
  groups: [
    {
      key: 'manufacturing-ops',
      labelAr: 'أوامر التصنيع',
      labelEn: 'Manufacturing orders',
      items: [
        screen('manufacturing-boms', 'قوائم المواد', 'Bills of materials', '/manufacturing/boms', 'ready', {
          permission: 'manufacturing.view',
          endpoint: 'GET/POST /manufacturing/boms',
        }),
        screen('manufacturing-orders', 'أوامر التصنيع', 'Manufacturing orders', '/manufacturing/orders', 'ready', {
          permission: 'manufacturing.view',
          endpoint: 'POST /manufacturing/orders/:id/produce',
        }),
      ],
    },
  ],
};

const dashboards: ModuleNode = {
  key: 'dashboards',
  icon: '📈',
  labelAr: 'لوحات المؤشرات',
  labelEn: 'Dashboards',
  href: '/dashboards',
  permission: 'dashboards.view',
  groups: [
    {
      key: 'mine',
      labelAr: 'لوحاتي',
      labelEn: 'My dashboards',
      items: [
        screen('bi-dashboards', 'لوحات المؤشرات', 'Dashboards', '/dashboards', 'ready', {
          permission: 'dashboards.view',
          endpoint: 'GET /dashboards',
          description: 'لوحة شخصية: مؤشرات وتقارير تُسحب وتُرتَّب، وتظهر في الصفحة الرئيسية.',
        }),
      ],
    },
  ],
};

export const modules: ModuleNode[] = [
  dashboards,
  accounting,
  treasury,
  inventory,
  manufacturing,
  purchases,
  sales,
  tailoring,
  optics,
  hrm,
  employeeApp,
  marina,
  projects,
  settings,
  support,
];

/** Flat index of every screen, used by the scaffold route and by the search box. */
export const allScreens: Array<
  ScreenItem & { moduleKey: string; moduleLabelAr: string; groupLabelAr: string }
> = modules.flatMap((module) =>
  module.groups.flatMap((group) =>
    group.items.map((item) => ({
      ...item,
      moduleKey: module.key,
      moduleLabelAr: module.labelAr,
      groupLabelAr: group.labelAr,
    })),
  ),
);

export function findScreenByHref(href: string) {
  const normalised = href.split('?')[0];
  return allScreens.find((item) => item.href.split('?')[0] === normalised);
}

export function screenCounts() {
  return allScreens.reduce(
    (accumulator, item) => {
      accumulator[item.status] += 1;
      accumulator.total += 1;
      return accumulator;
    },
    { ready: 0, api: 0, planned: 0, total: 0 },
  );
}

/**
 * Filters the tree for the signed-in user. `permissions` is the effective list from
 * `GET /me`; the owner role receives `*`.
 */
/**
 * `enabledHrefs` is omitted until the marketplace answers, so a slow catalog does not
 * flash-hide a screen. Once it answers, a href in `gatedHrefs` stays only if an
 * installed app (or a legacy store that was never explicitly disabled) enables it.
 * OCR, WMS and e-sign are not in that gate.
 */
export function visibleModules(
  permissions: string[],
  isPlatformAdmin: boolean,
  appGate?: { gatedHrefs: readonly string[]; enabledHrefs: readonly string[] } | null,
): ModuleNode[] {
  // AUD-12 — نفس مُحلّل العقود المستعمل في `can()`: صلاحيةٌ قديمة الاسم تفتح الشاشة
  // نفسها التي تفتحها الكنسية، ولا يعتمد الظهور على إملاءٍ واحد.
  const canonical = (code: string) => canonicalizePermissionCode(code);
  const granted = new Set(permissions.map(canonical));
  const allows = (permission?: string) =>
    !permission || granted.has('*') || granted.has(canonical(permission));
  const gated = new Set(appGate?.gatedHrefs ?? []);
  const enabled = new Set(appGate?.enabledHrefs ?? []);
  const screenVisible = (item: ScreenItem) => {
    if (!allows(item.permission)) return false;
    if (!appGate) return true;
    const href = item.href.split('?')[0] ?? item.href;
    return !gated.has(href) || enabled.has(href);
  };

  return modules
    .filter((module) => (module.platformAdminOnly ? isPlatformAdmin : allows(module.permission)))
    .map((module) => ({
      ...module,
      groups: module.groups
        .map((group) => ({ ...group, items: group.items.filter((item) => screenVisible(item)) }))
        .filter((group) => group.items.length > 0),
    }))
    .filter((module) => module.groups.length > 0);
}
