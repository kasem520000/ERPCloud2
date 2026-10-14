import type { HelpArticle } from './ai-help.js';

/**
 * Ready staff screens extracted from `apps/staff/lib/navigation.ts`.
 * Production API images do not contain the staff source, so the assistant
 * falls back to this snapshot. Regenerate with `node scripts/build-ai-navigation-snapshot.mjs`.
 */
export const NAVIGATION_SNAPSHOT: readonly HelpArticle[] = [
  {
    "id": "nav:coa",
    "title": "دليل الحسابات",
    "href": "/accounting/accounts",
    "keywords": [
      "دليل",
      "الحسابات",
      "Chart",
      "of",
      "accounts",
      "accounting"
    ],
    "steps": [
      "افتح «دليل الحسابات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:coa-tree",
    "title": "شجرة الحسابات",
    "href": "/accounting/accounts/tree",
    "keywords": [
      "شجرة",
      "الحسابات",
      "Account",
      "tree",
      "accounting",
      "accounts"
    ],
    "steps": [
      "افتح «شجرة الحسابات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:cash-card",
    "title": "بطاقة صندوق",
    "href": "/accounting/cash-locations?type=cash",
    "keywords": [
      "بطاقة",
      "صندوق",
      "Cash",
      "box",
      "card",
      "accounting",
      "cash",
      "locations",
      "type"
    ],
    "steps": [
      "افتح «بطاقة صندوق» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:bank-card",
    "title": "بطاقة بنك",
    "href": "/accounting/cash-locations?type=bank",
    "keywords": [
      "بطاقة",
      "بنك",
      "Bank",
      "card",
      "accounting",
      "cash",
      "locations",
      "type",
      "bank"
    ],
    "steps": [
      "افتح «بطاقة بنك» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:cost-center",
    "title": "بطاقة مركز تكلفة",
    "href": "/accounting/cost-centers",
    "keywords": [
      "بطاقة",
      "مركز",
      "تكلفة",
      "Cost",
      "centre",
      "card",
      "accounting",
      "cost",
      "centers"
    ],
    "steps": [
      "افتح «بطاقة مركز تكلفة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:payment-methods",
    "title": "طرق الدفع",
    "href": "/accounting/payment-methods",
    "keywords": [
      "طرق",
      "الدفع",
      "Payment",
      "methods",
      "accounting",
      "payment"
    ],
    "steps": [
      "افتح «طرق الدفع» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:opening-entry",
    "title": "قيد إفتتاحي",
    "href": "/accounting/journal-entries/new?kind=opening",
    "keywords": [
      "قيد",
      "إفتتاحي",
      "Opening",
      "entry",
      "accounting",
      "journal",
      "entries",
      "new",
      "kind",
      "opening"
    ],
    "steps": [
      "افتح «قيد إفتتاحي» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:journal-voucher",
    "title": "سند قيد",
    "href": "/accounting/journal-entries/new",
    "keywords": [
      "سند",
      "قيد",
      "Journal",
      "voucher",
      "accounting",
      "journal",
      "entries",
      "new"
    ],
    "steps": [
      "افتح «سند قيد» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:periods",
    "title": "الفترات المحاسبية",
    "href": "/accounting/periods",
    "keywords": [
      "الفترات",
      "المحاسبية",
      "Fiscal",
      "periods",
      "accounting"
    ],
    "steps": [
      "افتح «الفترات المحاسبية» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:journals-report",
    "title": "القيود اليومية",
    "href": "/accounting/journal-entries",
    "keywords": [
      "القيود",
      "اليومية",
      "Journal",
      "entries",
      "accounting",
      "journal"
    ],
    "steps": [
      "افتح «القيود اليومية» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:vouchers-report",
    "title": "عرض السندات",
    "href": "/treasury/vouchers",
    "keywords": [
      "عرض",
      "السندات",
      "Vouchers",
      "treasury",
      "vouchers"
    ],
    "steps": [
      "افتح «عرض السندات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:statement",
    "title": "كشف حساب",
    "href": "/accounting/ledger",
    "keywords": [
      "كشف",
      "حساب",
      "Account",
      "statement",
      "accounting",
      "ledger"
    ],
    "steps": [
      "افتح «كشف حساب» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:main-statement",
    "title": "كشف حساب رئيسي",
    "href": "/accounting/ledger?rollup=1",
    "keywords": [
      "كشف",
      "حساب",
      "رئيسي",
      "Main",
      "account",
      "statement",
      "accounting",
      "ledger",
      "rollup"
    ],
    "steps": [
      "افتح «كشف حساب رئيسي» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:cash-movement",
    "title": "حركة الصندوق",
    "href": "/reports/cash-movement",
    "keywords": [
      "حركة",
      "الصندوق",
      "Cash",
      "movement",
      "reports",
      "cash"
    ],
    "steps": [
      "افتح «حركة الصندوق» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:cc-balances",
    "title": "📊 كشف مركز الكلفة",
    "href": "/accounting/cost-center-statement",
    "keywords": [
      "كشف",
      "مركز",
      "الكلفة",
      "Cost",
      "centre",
      "statement",
      "accounting",
      "cost",
      "center"
    ],
    "steps": [
      "افتح «📊 كشف مركز الكلفة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:daily-movement",
    "title": "الحركة اليومية",
    "href": "/reports/general-ledger",
    "keywords": [
      "الحركة",
      "اليومية",
      "Daily",
      "movement",
      "reports",
      "general",
      "ledger"
    ],
    "steps": [
      "افتح «الحركة اليومية» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:party-statement",
    "title": "كشف حساب عميل",
    "href": "/reports/party-statement",
    "keywords": [
      "كشف",
      "حساب",
      "عميل",
      "Party",
      "statement",
      "reports",
      "party"
    ],
    "steps": [
      "افتح «كشف حساب عميل» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:trial-balance",
    "title": "ميزان المراجعة",
    "href": "/accounting/trial-balance",
    "keywords": [
      "ميزان",
      "المراجعة",
      "Trial",
      "balance",
      "accounting",
      "trial"
    ],
    "steps": [
      "افتح «ميزان المراجعة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:income-statement",
    "title": "أرباح وخسائر حسابات رئيسية",
    "href": "/accounting/income-statement",
    "keywords": [
      "أرباح",
      "وخسائر",
      "حسابات",
      "رئيسية",
      "Income",
      "statement",
      "accounting",
      "income"
    ],
    "steps": [
      "افتح «أرباح وخسائر حسابات رئيسية» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:balance-sheet",
    "title": "ميزانية تحليلية",
    "href": "/reports/balance-sheet",
    "keywords": [
      "ميزانية",
      "تحليلية",
      "Analytical",
      "balance",
      "sheet",
      "reports"
    ],
    "steps": [
      "افتح «ميزانية تحليلية» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:vat-return",
    "title": "الإقرار الضريبي",
    "href": "/reports/vat-return",
    "keywords": [
      "الإقرار",
      "الضريبي",
      "VAT",
      "return",
      "reports",
      "vat"
    ],
    "steps": [
      "افتح «الإقرار الضريبي» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:reports-center",
    "title": "مركز التقارير (كل التقارير)",
    "href": "/reports",
    "keywords": [
      "مركز",
      "التقارير",
      "كل",
      "Report",
      "centre",
      "reports"
    ],
    "steps": [
      "افتح «مركز التقارير (كل التقارير)» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:custom-report-builder",
    "title": "منشئ التقارير المخصص",
    "href": "/reports/builder",
    "keywords": [
      "منشئ",
      "التقارير",
      "المخصص",
      "Custom",
      "report",
      "builder",
      "reports"
    ],
    "steps": [
      "افتح «منشئ التقارير المخصص» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:custom-reports",
    "title": "التقارير المحفوظة",
    "href": "/reports/custom",
    "keywords": [
      "التقارير",
      "المحفوظة",
      "Saved",
      "custom",
      "reports"
    ],
    "steps": [
      "افتح «التقارير المحفوظة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:account-balances",
    "title": "أرصدة الحسابات",
    "href": "/reports/account-balances",
    "keywords": [
      "أرصدة",
      "الحسابات",
      "Account",
      "balances",
      "reports",
      "account"
    ],
    "steps": [
      "افتح «أرصدة الحسابات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:journal-entries-report",
    "title": "سجل القيود اليومية",
    "href": "/reports/journal-entries",
    "keywords": [
      "سجل",
      "القيود",
      "اليومية",
      "Journal",
      "entry",
      "register",
      "reports",
      "journal",
      "entries"
    ],
    "steps": [
      "افتح «سجل القيود اليومية» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:journal-entry-lines",
    "title": "تفاصيل القيد",
    "href": "/reports/journal-entry-lines",
    "keywords": [
      "تفاصيل",
      "القيد",
      "Journal",
      "entry",
      "details",
      "reports",
      "journal",
      "lines"
    ],
    "steps": [
      "افتح «تفاصيل القيد» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:income-statement-accounts",
    "title": "أرباح وخسائر حسابات رئيسية (تقرير)",
    "href": "/reports/income-statement-accounts",
    "keywords": [
      "أرباح",
      "وخسائر",
      "حسابات",
      "رئيسية",
      "تقرير",
      "Income",
      "statement",
      "by",
      "main",
      "account",
      "reports",
      "income"
    ],
    "steps": [
      "افتح «أرباح وخسائر حسابات رئيسية (تقرير)» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:cost-center-statement-report",
    "title": "تقرير مراكز التكلفة",
    "href": "/reports/cost-center-statement",
    "keywords": [
      "تقرير",
      "مراكز",
      "التكلفة",
      "Cost",
      "centre",
      "statement",
      "reports",
      "cost",
      "center"
    ],
    "steps": [
      "افتح «تقرير مراكز التكلفة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:vat-return-period",
    "title": "الإقرار الضريبي للفترة",
    "href": "/reports/vat-return-period",
    "keywords": [
      "الإقرار",
      "الضريبي",
      "للفترة",
      "VAT",
      "return",
      "for",
      "period",
      "reports",
      "vat"
    ],
    "steps": [
      "افتح «الإقرار الضريبي للفترة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:cash-statement",
    "title": "حركة الصندوق (كشف)",
    "href": "/reports/cash-statement",
    "keywords": [
      "حركة",
      "الصندوق",
      "كشف",
      "Cash",
      "statement",
      "reports",
      "cash"
    ],
    "steps": [
      "افتح «حركة الصندوق (كشف)» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:salary-statement",
    "title": "تقرير الرواتب (سجل)",
    "href": "/reports/salary-statement",
    "keywords": [
      "تقرير",
      "الرواتب",
      "سجل",
      "Salary",
      "statement",
      "reports",
      "salary"
    ],
    "steps": [
      "افتح «تقرير الرواتب (سجل)» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:salary-reserved",
    "title": "تقرير الرواتب المستحقة",
    "href": "/reports/salary-reserved",
    "keywords": [
      "تقرير",
      "الرواتب",
      "المستحقة",
      "Reserved",
      "salaries",
      "reports",
      "salary",
      "reserved"
    ],
    "steps": [
      "افتح «تقرير الرواتب المستحقة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:user-records",
    "title": "سجلات المستخدمين",
    "href": "/reports/user-records",
    "keywords": [
      "سجلات",
      "المستخدمين",
      "User",
      "records",
      "reports",
      "user"
    ],
    "steps": [
      "افتح «سجلات المستخدمين» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:rent-invoices",
    "title": "تقرير فواتير التأجير (سجل)",
    "href": "/reports/rent-invoices",
    "keywords": [
      "تقرير",
      "فواتير",
      "التأجير",
      "سجل",
      "Rent",
      "invoices",
      "register",
      "reports",
      "rent"
    ],
    "steps": [
      "افتح «تقرير فواتير التأجير (سجل)» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:inventory-overview",
    "title": "لوحة المخزون",
    "href": "/inventory/overview",
    "keywords": [
      "لوحة",
      "المخزون",
      "Inventory",
      "overview",
      "inventory"
    ],
    "steps": [
      "افتح «لوحة المخزون» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:items",
    "title": "دليل المواد وبطاقاتها",
    "href": "/inventory/items",
    "keywords": [
      "دليل",
      "المواد",
      "وبطاقاتها",
      "Item",
      "directory",
      "and",
      "cards",
      "inventory",
      "items"
    ],
    "steps": [
      "افتح «دليل المواد وبطاقاتها» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:warehouse-card",
    "title": "بطاقة مستودع",
    "href": "/inventory/warehouses",
    "keywords": [
      "بطاقة",
      "مستودع",
      "Warehouse",
      "card",
      "inventory",
      "warehouses"
    ],
    "steps": [
      "افتح «بطاقة مستودع» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:group-card",
    "title": "بطاقة مجموعة",
    "href": "/inventory/categories",
    "keywords": [
      "بطاقة",
      "مجموعة",
      "Category",
      "card",
      "inventory",
      "categories"
    ],
    "steps": [
      "افتح «بطاقة مجموعة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:unit-card",
    "title": "بطاقة وحدة",
    "href": "/inventory/units",
    "keywords": [
      "بطاقة",
      "وحدة",
      "Unit",
      "card",
      "inventory",
      "units"
    ],
    "steps": [
      "افتح «بطاقة وحدة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:item-units",
    "title": "وحدات الصنف والباركود",
    "href": "/inventory/item-units",
    "keywords": [
      "وحدات",
      "الصنف",
      "والباركود",
      "Item",
      "units",
      "and",
      "barcodes",
      "inventory",
      "item"
    ],
    "steps": [
      "افتح «وحدات الصنف والباركود» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:transfer",
    "title": "مناقلة",
    "href": "/inventory/transfers",
    "keywords": [
      "مناقلة",
      "Transfer",
      "inventory",
      "transfers"
    ],
    "steps": [
      "افتح «مناقلة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:opening-stock",
    "title": "بضاعة أول مدة",
    "href": "/inventory/vouchers?kind=opening",
    "keywords": [
      "بضاعة",
      "أول",
      "مدة",
      "Opening",
      "stock",
      "inventory",
      "vouchers",
      "kind",
      "opening"
    ],
    "steps": [
      "افتح «بضاعة أول مدة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:goods-in",
    "title": "فاتورة إدخال",
    "href": "/purchases/invoices/new",
    "keywords": [
      "فاتورة",
      "إدخال",
      "Goods",
      "receipt",
      "purchases",
      "invoices",
      "new"
    ],
    "steps": [
      "افتح «فاتورة إدخال» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:goods-out",
    "title": "فاتورة إخراج",
    "href": "/sales/invoices/new",
    "keywords": [
      "فاتورة",
      "إخراج",
      "Goods",
      "issue",
      "sales",
      "invoices",
      "new"
    ],
    "steps": [
      "افتح «فاتورة إخراج» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:stock-adjust",
    "title": "تسوية مخزنية",
    "href": "/inventory/adjustments",
    "keywords": [
      "تسوية",
      "مخزنية",
      "Stock",
      "adjustment",
      "inventory",
      "adjustments"
    ],
    "steps": [
      "افتح «تسوية مخزنية» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:stock-voucher",
    "title": "سند إدخال / إخراج",
    "href": "/inventory/vouchers",
    "keywords": [
      "سند",
      "إدخال",
      "إخراج",
      "Stock",
      "voucher",
      "inventory",
      "vouchers"
    ],
    "steps": [
      "افتح «سند إدخال / إخراج» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:stock-delivery",
    "title": "توصيل مخزني",
    "href": "/inventory/deliveries",
    "keywords": [
      "توصيل",
      "مخزني",
      "Stock",
      "delivery",
      "inventory",
      "deliveries"
    ],
    "steps": [
      "افتح «توصيل مخزني» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:goods-request",
    "title": "طلب بضاعة",
    "href": "/inventory/requests",
    "keywords": [
      "طلب",
      "بضاعة",
      "Goods",
      "request",
      "inventory",
      "requests"
    ],
    "steps": [
      "افتح «طلب بضاعة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:barcode",
    "title": "طباعة الباركود",
    "href": "/inventory/barcodes",
    "keywords": [
      "طباعة",
      "الباركود",
      "Barcode",
      "printing",
      "inventory",
      "barcodes"
    ],
    "steps": [
      "افتح «طباعة الباركود» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:stock-count",
    "title": "جرد المواد",
    "href": "/inventory/levels",
    "keywords": [
      "جرد",
      "المواد",
      "Stock",
      "count",
      "inventory",
      "levels"
    ],
    "steps": [
      "افتح «جرد المواد» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:below-minimum",
    "title": "أصناف تحت حد الطلب",
    "href": "/inventory/below-minimum",
    "keywords": [
      "أصناف",
      "تحت",
      "حد",
      "الطلب",
      "Below",
      "reorder",
      "point",
      "inventory",
      "below",
      "minimum"
    ],
    "steps": [
      "افتح «أصناف تحت حد الطلب» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:expiry",
    "title": "تواريخ الصلاحية",
    "href": "/inventory/expiry",
    "keywords": [
      "تواريخ",
      "الصلاحية",
      "Expiry",
      "dates",
      "inventory",
      "expiry"
    ],
    "steps": [
      "افتح «تواريخ الصلاحية» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:item-card",
    "title": "بطاقة الصنف",
    "href": "/inventory/item-card",
    "keywords": [
      "بطاقة",
      "الصنف",
      "Item",
      "card",
      "stock",
      "ledger",
      "inventory",
      "item"
    ],
    "steps": [
      "افتح «بطاقة الصنف» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:item-movement",
    "title": "حركة مادة تفصيلي",
    "href": "/inventory/movements",
    "keywords": [
      "حركة",
      "مادة",
      "تفصيلي",
      "Item",
      "movement",
      "detail",
      "inventory",
      "movements"
    ],
    "steps": [
      "افتح «حركة مادة تفصيلي» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:items-movement",
    "title": "حركة مواد تجميعي",
    "href": "/reports/item-movement-summary",
    "keywords": [
      "حركة",
      "مواد",
      "تجميعي",
      "Item",
      "movement",
      "summary",
      "reports",
      "item"
    ],
    "steps": [
      "افتح «حركة مواد تجميعي» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:lots",
    "title": "صلاحية المواد (الدفعات)",
    "href": "/inventory/lots",
    "keywords": [
      "صلاحية",
      "المواد",
      "الدفعات",
      "Item",
      "expiry",
      "lots",
      "inventory"
    ],
    "steps": [
      "افتح «صلاحية المواد (الدفعات)» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:sales-analysis",
    "title": "تحليل المبيعات",
    "href": "/reports/sales-analysis",
    "keywords": [
      "تحليل",
      "المبيعات",
      "Sales",
      "analysis",
      "reports",
      "sales"
    ],
    "steps": [
      "افتح «تحليل المبيعات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:purchase-sales-total",
    "title": "إجمالي المبيعات والمشتريات",
    "href": "/reports/sales-purchases-total",
    "keywords": [
      "إجمالي",
      "المبيعات",
      "والمشتريات",
      "Sales",
      "purchases",
      "total",
      "reports",
      "sales"
    ],
    "steps": [
      "افتح «إجمالي المبيعات والمشتريات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:turnover",
    "title": "معدل الدوران والركود",
    "href": "/reports/inventory-turnover",
    "keywords": [
      "معدل",
      "الدوران",
      "والركود",
      "Turnover",
      "dead",
      "stock",
      "reports",
      "inventory",
      "turnover"
    ],
    "steps": [
      "افتح «معدل الدوران والركود» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:inventory-valuation",
    "title": "جرد المواد وتقييم المخزون",
    "href": "/reports/inventory-valuation",
    "keywords": [
      "جرد",
      "المواد",
      "وتقييم",
      "المخزون",
      "Inventory",
      "valuation",
      "reports",
      "inventory"
    ],
    "steps": [
      "افتح «جرد المواد وتقييم المخزون» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:stock-limits",
    "title": "الأصناف تحت الحد الأدنى",
    "href": "/reports/stock-limits",
    "keywords": [
      "الأصناف",
      "تحت",
      "الحد",
      "الأدنى",
      "Items",
      "below",
      "the",
      "minimum",
      "reports",
      "stock",
      "limits"
    ],
    "steps": [
      "افتح «الأصناف تحت الحد الأدنى» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:expiry-report",
    "title": "صلاحية المواد",
    "href": "/reports/expiry-report",
    "keywords": [
      "صلاحية",
      "المواد",
      "Expiry",
      "report",
      "reports",
      "expiry"
    ],
    "steps": [
      "افتح «صلاحية المواد» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:serial-tracking",
    "title": "تتبّع الأرقام التسلسلية",
    "href": "/reports/serial-tracking",
    "keywords": [
      "تتب",
      "الأرقام",
      "التسلسلية",
      "Serial",
      "tracking",
      "report",
      "reports",
      "serial"
    ],
    "steps": [
      "افتح «تتبّع الأرقام التسلسلية» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:production-order",
    "title": "تقرير أمر الإنتاج",
    "href": "/inventory/production",
    "keywords": [
      "تقرير",
      "أمر",
      "الإنتاج",
      "Production",
      "order",
      "report",
      "inventory",
      "production"
    ],
    "steps": [
      "افتح «تقرير أمر الإنتاج» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:invoices-by-type",
    "title": "الفواتير بحسب النوع",
    "href": "/reports/invoices-by-type",
    "keywords": [
      "الفواتير",
      "بحسب",
      "النوع",
      "Invoices",
      "by",
      "type",
      "reports",
      "invoices"
    ],
    "steps": [
      "افتح «الفواتير بحسب النوع» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:expired-items",
    "title": "انتهاء صلاحية الأصناف",
    "href": "/reports/expired-items",
    "keywords": [
      "انتهاء",
      "صلاحية",
      "الأصناف",
      "Expired",
      "items",
      "reports",
      "expired"
    ],
    "steps": [
      "افتح «انتهاء صلاحية الأصناف» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:serials",
    "title": "تقرير الأرقام التسلسلية",
    "href": "/inventory/serials",
    "keywords": [
      "تقرير",
      "الأرقام",
      "التسلسلية",
      "Serial",
      "numbers",
      "report",
      "inventory",
      "serials"
    ],
    "steps": [
      "افتح «تقرير الأرقام التسلسلية» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:warehouse-bins",
    "title": "رفوف المستودع",
    "href": "/inventory/bins",
    "keywords": [
      "رفوف",
      "المستودع",
      "Warehouse",
      "bins",
      "inventory"
    ],
    "steps": [
      "افتح «رفوف المستودع» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:bin-balances",
    "title": "أرصدة الرفوف",
    "href": "/inventory/bin-balances",
    "keywords": [
      "أرصدة",
      "الرفوف",
      "Bin",
      "balances",
      "inventory",
      "bin"
    ],
    "steps": [
      "افتح «أرصدة الرفوف» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:salla-products",
    "title": "المنتجات",
    "href": "/integrations/salla/products",
    "keywords": [
      "المنتجات",
      "Products",
      "integrations",
      "salla",
      "products"
    ],
    "steps": [
      "افتح «المنتجات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:salla-orders",
    "title": "إدارة الطلبات",
    "href": "/integrations/salla/orders",
    "keywords": [
      "إدارة",
      "الطلبات",
      "Orders",
      "integrations",
      "salla",
      "orders"
    ],
    "steps": [
      "افتح «إدارة الطلبات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:salla-warehouses",
    "title": "ربط المستودعات",
    "href": "/integrations/salla/warehouses",
    "keywords": [
      "ربط",
      "المستودعات",
      "Warehouse",
      "mapping",
      "integrations",
      "salla",
      "warehouses"
    ],
    "steps": [
      "افتح «ربط المستودعات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:purchase-invoice",
    "title": "فاتورة المشتريات",
    "href": "/purchases/invoices",
    "keywords": [
      "فاتورة",
      "المشتريات",
      "Purchase",
      "invoice",
      "purchases",
      "invoices"
    ],
    "steps": [
      "افتح «فاتورة المشتريات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:purchase-ocr",
    "title": "قراءة فاتورة بالـ OCR",
    "href": "/purchases/invoices/ocr",
    "keywords": [
      "قراءة",
      "فاتورة",
      "بالـ",
      "OCR",
      "purchase",
      "invoice",
      "purchases",
      "invoices",
      "ocr"
    ],
    "steps": [
      "افتح «قراءة فاتورة بالـ OCR» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:purchase-return",
    "title": "مردود المشتريات",
    "href": "/purchases/invoices/new?kind=purchase_return",
    "keywords": [
      "مردود",
      "المشتريات",
      "Purchase",
      "return",
      "purchases",
      "invoices",
      "new",
      "kind",
      "purchase"
    ],
    "steps": [
      "افتح «مردود المشتريات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:supplier-portal-admin",
    "title": "بوابة الموردين",
    "href": "/purchases/supplier-portal",
    "keywords": [
      "بوابة",
      "الموردين",
      "Supplier",
      "portal",
      "purchases",
      "supplier"
    ],
    "steps": [
      "افتح «بوابة الموردين» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:purchase-credit-note",
    "title": "إشعار دائن",
    "href": "/purchases/notes/credit",
    "keywords": [
      "إشعار",
      "دائن",
      "Credit",
      "note",
      "purchases",
      "notes",
      "credit"
    ],
    "steps": [
      "افتح «إشعار دائن» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:pn-debit",
    "title": "إشعار مدين",
    "href": "/purchases/notes/debit",
    "keywords": [
      "إشعار",
      "مدين",
      "Debit",
      "note",
      "purchases",
      "notes",
      "debit"
    ],
    "steps": [
      "افتح «إشعار مدين» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:pn-report",
    "title": "تقرير الإشعارات",
    "href": "/reports/purchase-notes",
    "keywords": [
      "تقرير",
      "الإشعارات",
      "Notes",
      "report",
      "reports",
      "purchase",
      "notes"
    ],
    "steps": [
      "افتح «تقرير الإشعارات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:supplier-statement",
    "title": "كشف مورد",
    "href": "/sales/statements?kind=supplier",
    "keywords": [
      "كشف",
      "مورد",
      "Supplier",
      "statement",
      "sales",
      "statements",
      "kind",
      "supplier"
    ],
    "steps": [
      "افتح «كشف مورد» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:purchase-invoices-report",
    "title": "تقرير فواتير المشتريات",
    "href": "/reports/purchase-invoices",
    "keywords": [
      "تقرير",
      "فواتير",
      "المشتريات",
      "Purchase",
      "invoices",
      "reports",
      "purchase"
    ],
    "steps": [
      "افتح «تقرير فواتير المشتريات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:purchase-returns-report",
    "title": "تقرير مردود فواتير المشتريات",
    "href": "/reports/purchase-returns",
    "keywords": [
      "تقرير",
      "مردود",
      "فواتير",
      "المشتريات",
      "Purchase",
      "returns",
      "reports",
      "purchase"
    ],
    "steps": [
      "افتح «تقرير مردود فواتير المشتريات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:items-purchases-summary",
    "title": "مشتريات الأصناف تجميعي",
    "href": "/reports/items-purchases-summary",
    "keywords": [
      "مشتريات",
      "الأصناف",
      "تجميعي",
      "Item",
      "purchases",
      "summary",
      "reports",
      "items"
    ],
    "steps": [
      "افتح «مشتريات الأصناف تجميعي» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:purchase-invoices-details",
    "title": "تفاصيل فواتير المشتريات",
    "href": "/reports/purchase-invoices-details",
    "keywords": [
      "تفاصيل",
      "فواتير",
      "المشتريات",
      "Purchase",
      "invoices",
      "details",
      "reports",
      "purchase"
    ],
    "steps": [
      "افتح «تفاصيل فواتير المشتريات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:items-profit-details",
    "title": "أرباح المواد تفصيلي",
    "href": "/reports/items-profit-details",
    "keywords": [
      "أرباح",
      "المواد",
      "تفصيلي",
      "Item",
      "profit",
      "details",
      "reports",
      "items"
    ],
    "steps": [
      "افتح «أرباح المواد تفصيلي» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:net-purchases",
    "title": "صافي المشتريات",
    "href": "/reports/net-purchases",
    "keywords": [
      "صافي",
      "المشتريات",
      "Net",
      "purchases",
      "reports",
      "net"
    ],
    "steps": [
      "افتح «صافي المشتريات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:purchases-detail",
    "title": "مشتريات تفصيلية",
    "href": "/reports/purchases-detail",
    "keywords": [
      "مشتريات",
      "تفصيلية",
      "Detailed",
      "purchases",
      "reports",
      "detail"
    ],
    "steps": [
      "افتح «مشتريات تفصيلية» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:purchases-items",
    "title": "مشتريات الأصناف تجميعي",
    "href": "/reports/purchases-by-item",
    "keywords": [
      "مشتريات",
      "الأصناف",
      "تجميعي",
      "Purchases",
      "by",
      "item",
      "reports",
      "purchases"
    ],
    "steps": [
      "افتح «مشتريات الأصناف تجميعي» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:supplier-balances",
    "title": "أرصدة الموردين",
    "href": "/reports/supplier-balances",
    "keywords": [
      "أرصدة",
      "الموردين",
      "Supplier",
      "balances",
      "reports",
      "supplier"
    ],
    "steps": [
      "افتح «أرصدة الموردين» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:supplier-settlements",
    "title": "سداد الموردين",
    "href": "/reports/supplier-settlements",
    "keywords": [
      "سداد",
      "الموردين",
      "Supplier",
      "settlements",
      "reports",
      "supplier"
    ],
    "steps": [
      "افتح «سداد الموردين» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:employee-purchases",
    "title": "مشتريات موظف",
    "href": "/reports/purchases-by-employee",
    "keywords": [
      "مشتريات",
      "موظف",
      "Purchases",
      "by",
      "employee",
      "reports",
      "purchases"
    ],
    "steps": [
      "افتح «مشتريات موظف» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:invoices-by-supplier",
    "title": "الفواتير بحسب الموردين",
    "href": "/reports/invoices-by-supplier",
    "keywords": [
      "الفواتير",
      "بحسب",
      "الموردين",
      "Invoices",
      "by",
      "supplier",
      "reports",
      "invoices"
    ],
    "steps": [
      "افتح «الفواتير بحسب الموردين» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:supplier-card",
    "title": "بطاقة مورد",
    "href": "/purchases/suppliers",
    "keywords": [
      "بطاقة",
      "مورد",
      "Supplier",
      "card",
      "purchases",
      "suppliers"
    ],
    "steps": [
      "افتح «بطاقة مورد» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:pos",
    "title": "نقطة البيع",
    "href": "/sales/pos",
    "keywords": [
      "نقطة",
      "البيع",
      "Point",
      "of",
      "sale",
      "sales",
      "pos"
    ],
    "steps": [
      "افتح «نقطة البيع» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:pos-offline",
    "title": "نقطة البيع أوفلاين",
    "href": "/pos/offline",
    "keywords": [
      "نقطة",
      "البيع",
      "أوفلاين",
      "Offline",
      "POS",
      "pos",
      "offline"
    ],
    "steps": [
      "افتح «نقطة البيع أوفلاين» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:pos-offline-queue",
    "title": "طابور POS أوفلاين",
    "href": "/pos/offline-queue",
    "keywords": [
      "طابور",
      "POS",
      "أوفلاين",
      "Offline",
      "queue",
      "pos",
      "offline"
    ],
    "steps": [
      "افتح «طابور POS أوفلاين» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:sales-invoice",
    "title": "فاتورة مبيعات",
    "href": "/sales/invoices",
    "keywords": [
      "فاتورة",
      "مبيعات",
      "Sales",
      "invoice",
      "sales",
      "invoices"
    ],
    "steps": [
      "افتح «فاتورة مبيعات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:cash-customer",
    "title": "👤 عميل نقدي",
    "href": "/sales/cash-customers",
    "keywords": [
      "عميل",
      "نقدي",
      "Cash",
      "customer",
      "sales",
      "cash",
      "customers"
    ],
    "steps": [
      "افتح «👤 عميل نقدي» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:sales-return",
    "title": "مردود المبيعات",
    "href": "/sales/returns",
    "keywords": [
      "مردود",
      "المبيعات",
      "Sales",
      "return",
      "sales",
      "returns"
    ],
    "steps": [
      "افتح «مردود المبيعات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:quotation",
    "title": "عرض سعر",
    "href": "/sales/quotations",
    "keywords": [
      "عرض",
      "سعر",
      "Quotation",
      "sales",
      "quotations"
    ],
    "steps": [
      "افتح «عرض سعر» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:contracting-return",
    "title": "مرتجع مقاولات",
    "href": "/projects/contracting-return",
    "keywords": [
      "مرتجع",
      "مقاولات",
      "Contracting",
      "return",
      "projects",
      "contracting"
    ],
    "steps": [
      "افتح «مرتجع مقاولات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:sales-debit-note",
    "title": "إشعار مدين",
    "href": "/sales/notes/debit",
    "keywords": [
      "إشعار",
      "مدين",
      "Debit",
      "note",
      "sales",
      "notes",
      "debit"
    ],
    "steps": [
      "افتح «إشعار مدين» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:sn-credit",
    "title": "إشعار دائن",
    "href": "/sales/notes/credit",
    "keywords": [
      "إشعار",
      "دائن",
      "Credit",
      "note",
      "sales",
      "notes",
      "credit"
    ],
    "steps": [
      "افتح «إشعار دائن» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:sn-report",
    "title": "تقرير الإشعارات",
    "href": "/reports/sales-notes",
    "keywords": [
      "تقرير",
      "الإشعارات",
      "Notes",
      "report",
      "reports",
      "sales",
      "notes"
    ],
    "steps": [
      "افتح «تقرير الإشعارات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:sales-invoices-report",
    "title": "تقرير فواتير المبيعات",
    "href": "/reports/sales-invoices",
    "keywords": [
      "تقرير",
      "فواتير",
      "المبيعات",
      "Sales",
      "invoices",
      "reports",
      "sales"
    ],
    "steps": [
      "افتح «تقرير فواتير المبيعات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:sales-returns-report",
    "title": "تقرير مردود فواتير المبيعات",
    "href": "/reports/sales-returns",
    "keywords": [
      "تقرير",
      "مردود",
      "فواتير",
      "المبيعات",
      "Sales",
      "returns",
      "reports",
      "sales"
    ],
    "steps": [
      "افتح «تقرير مردود فواتير المبيعات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:sales-movement-items",
    "title": "إجمالي حركة المواد",
    "href": "/reports/sales-movement-items",
    "keywords": [
      "إجمالي",
      "حركة",
      "المواد",
      "Sales",
      "item",
      "movement",
      "reports",
      "sales",
      "items"
    ],
    "steps": [
      "افتح «إجمالي حركة المواد» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:sales-movement-invoices",
    "title": "عرض الفواتير",
    "href": "/reports/sales-movement-invoices",
    "keywords": [
      "عرض",
      "الفواتير",
      "Sales",
      "invoice",
      "movement",
      "reports",
      "sales",
      "invoices"
    ],
    "steps": [
      "افتح «عرض الفواتير» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:net-sales",
    "title": "صافي المبيعات",
    "href": "/reports/net-sales",
    "keywords": [
      "صافي",
      "المبيعات",
      "Net",
      "sales",
      "reports",
      "net"
    ],
    "steps": [
      "افتح «صافي المبيعات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:items-sales-summary",
    "title": "مبيعات الأصناف تجميعي",
    "href": "/reports/items-sales-summary",
    "keywords": [
      "مبيعات",
      "الأصناف",
      "تجميعي",
      "Item",
      "sales",
      "summary",
      "reports",
      "items"
    ],
    "steps": [
      "افتح «مبيعات الأصناف تجميعي» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:items-pos-sales-summary",
    "title": "مبيعات الأصناف تجميعي - نقطة البيع",
    "href": "/reports/items-pos-sales-summary",
    "keywords": [
      "مبيعات",
      "الأصناف",
      "تجميعي",
      "نقطة",
      "البيع",
      "POS",
      "item",
      "sales",
      "summary",
      "reports",
      "items",
      "pos"
    ],
    "steps": [
      "افتح «مبيعات الأصناف تجميعي - نقطة البيع» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:items-profit-summary",
    "title": "أرباح المواد تجميعي",
    "href": "/reports/items-profit-summary",
    "keywords": [
      "أرباح",
      "المواد",
      "تجميعي",
      "Item",
      "profit",
      "summary",
      "reports",
      "items"
    ],
    "steps": [
      "افتح «أرباح المواد تجميعي» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:sales-invoices-details",
    "title": "تقرير فواتير المبيعات",
    "href": "/reports/sales-invoices-details",
    "keywords": [
      "تقرير",
      "فواتير",
      "المبيعات",
      "Sales",
      "invoices",
      "details",
      "reports",
      "sales"
    ],
    "steps": [
      "افتح «تقرير فواتير المبيعات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:pos-sales-invoices-details",
    "title": "تقرير مبيعات الفواتير",
    "href": "/reports/pos-sales-invoices-details",
    "keywords": [
      "تقرير",
      "مبيعات",
      "الفواتير",
      "POS",
      "invoices",
      "details",
      "reports",
      "pos",
      "sales"
    ],
    "steps": [
      "افتح «تقرير مبيعات الفواتير» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:sales-notifications",
    "title": "تقرير الإشعارات",
    "href": "/reports/sales-notifications",
    "keywords": [
      "تقرير",
      "الإشعارات",
      "Sales",
      "notifications",
      "reports",
      "sales"
    ],
    "steps": [
      "افتح «تقرير الإشعارات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:daily-sales",
    "title": "تقرير مبيعات حسب اليوم",
    "href": "/reports/daily-sales",
    "keywords": [
      "تقرير",
      "مبيعات",
      "حسب",
      "اليوم",
      "Daily",
      "sales",
      "reports",
      "daily"
    ],
    "steps": [
      "افتح «تقرير مبيعات حسب اليوم» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:daily-process",
    "title": "تقرير الحركة اليومية",
    "href": "/reports/daily-process",
    "keywords": [
      "تقرير",
      "الحركة",
      "اليومية",
      "Daily",
      "movements",
      "reports",
      "daily",
      "process"
    ],
    "steps": [
      "افتح «تقرير الحركة اليومية» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:sales-inv-analysis",
    "title": "تقرير تحليل المبيعات",
    "href": "/reports/sales-inv-analysis",
    "keywords": [
      "تقرير",
      "تحليل",
      "المبيعات",
      "Sales",
      "analysis",
      "reports",
      "sales",
      "inv"
    ],
    "steps": [
      "افتح «تقرير تحليل المبيعات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:inventory-documents",
    "title": "تقرير مستندات المخزون",
    "href": "/reports/inventory-documents",
    "keywords": [
      "تقرير",
      "مستندات",
      "المخزون",
      "Inventory",
      "documents",
      "reports",
      "inventory"
    ],
    "steps": [
      "افتح «تقرير مستندات المخزون» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:item-movement-totals",
    "title": "مادة باجمالي الحركات",
    "href": "/reports/item-movement-totals",
    "keywords": [
      "مادة",
      "باجمالي",
      "الحركات",
      "Item",
      "movement",
      "totals",
      "reports",
      "item"
    ],
    "steps": [
      "افتح «مادة باجمالي الحركات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:item-movement-details",
    "title": "حركة صنف تفصيلي",
    "href": "/reports/item-movement-details",
    "keywords": [
      "حركة",
      "صنف",
      "تفصيلي",
      "Item",
      "movement",
      "details",
      "reports",
      "item"
    ],
    "steps": [
      "افتح «حركة صنف تفصيلي» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:item-expiry",
    "title": "صلاحية المواد",
    "href": "/reports/item-expiry",
    "keywords": [
      "صلاحية",
      "المواد",
      "Item",
      "expiry",
      "reports",
      "item"
    ],
    "steps": [
      "افتح «صلاحية المواد» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:serial-movements",
    "title": "حركة الأرقام التسلسلية",
    "href": "/reports/serial-movements",
    "keywords": [
      "حركة",
      "الأرقام",
      "التسلسلية",
      "Serial",
      "number",
      "movements",
      "reports",
      "serial"
    ],
    "steps": [
      "افتح «حركة الأرقام التسلسلية» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:serial-balances",
    "title": "أرصدة الأرقام التسلسلية",
    "href": "/reports/serial-balances",
    "keywords": [
      "أرصدة",
      "الأرقام",
      "التسلسلية",
      "Serial",
      "number",
      "balances",
      "reports",
      "serial"
    ],
    "steps": [
      "افتح «أرصدة الأرقام التسلسلية» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:produced-items",
    "title": "تقرير مواد المنتجة",
    "href": "/reports/produced-items",
    "keywords": [
      "تقرير",
      "مواد",
      "المنتجة",
      "Produced",
      "items",
      "reports",
      "produced"
    ],
    "steps": [
      "افتح «تقرير مواد المنتجة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:produced-components",
    "title": "مكونات المواد المنتجة",
    "href": "/reports/produced-components",
    "keywords": [
      "مكونات",
      "المواد",
      "المنتجة",
      "Produced",
      "item",
      "components",
      "reports",
      "produced"
    ],
    "steps": [
      "افتح «مكونات المواد المنتجة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:items-sales-by-category",
    "title": "تقرير مبيعات الأصناف حسب المجموعة",
    "href": "/reports/items-sales-by-category",
    "keywords": [
      "تقرير",
      "مبيعات",
      "الأصناف",
      "حسب",
      "المجموعة",
      "Item",
      "sales",
      "by",
      "category",
      "reports",
      "items"
    ],
    "steps": [
      "افتح «تقرير مبيعات الأصناف حسب المجموعة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:category-sales-by-day",
    "title": "تقرير المبيعات اليومية للمجموعة",
    "href": "/reports/category-sales-by-day",
    "keywords": [
      "تقرير",
      "المبيعات",
      "اليومية",
      "للمجموعة",
      "Category",
      "sales",
      "by",
      "day",
      "reports",
      "category"
    ],
    "steps": [
      "افتح «تقرير المبيعات اليومية للمجموعة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:sales-detail",
    "title": "مبيعات تفصيلية",
    "href": "/reports/sales-detail",
    "keywords": [
      "مبيعات",
      "تفصيلية",
      "Detailed",
      "sales",
      "reports",
      "detail"
    ],
    "steps": [
      "افتح «مبيعات تفصيلية» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:sales-items",
    "title": "مبيعات الأصناف تجميعي",
    "href": "/reports/sales-by-item",
    "keywords": [
      "مبيعات",
      "الأصناف",
      "تجميعي",
      "Sales",
      "by",
      "item",
      "reports",
      "sales"
    ],
    "steps": [
      "افتح «مبيعات الأصناف تجميعي» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:sales-by-category",
    "title": "مبيعات بحسب الفئة",
    "href": "/reports/sales-by-category",
    "keywords": [
      "مبيعات",
      "بحسب",
      "الفئة",
      "Sales",
      "by",
      "category",
      "reports",
      "sales"
    ],
    "steps": [
      "افتح «مبيعات بحسب الفئة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:sales-invoice-profit",
    "title": "أرباح الفواتير",
    "href": "/reports/invoice-profit",
    "keywords": [
      "أرباح",
      "الفواتير",
      "Invoice",
      "profit",
      "reports",
      "invoice"
    ],
    "steps": [
      "افتح «أرباح الفواتير» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:item-profit",
    "title": "أرباح الأصناف",
    "href": "/reports/item-profit",
    "keywords": [
      "أرباح",
      "الأصناف",
      "Item",
      "profit",
      "reports",
      "item"
    ],
    "steps": [
      "افتح «أرباح الأصناف» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:item-profit-detail",
    "title": "تفاصيل أرباح الأصناف",
    "href": "/reports/item-profit-detail",
    "keywords": [
      "تفاصيل",
      "أرباح",
      "الأصناف",
      "Item",
      "profit",
      "detail",
      "reports",
      "item"
    ],
    "steps": [
      "افتح «تفاصيل أرباح الأصناف» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:reps-report",
    "title": "تقرير المندوبين",
    "href": "/reports/sales-by-salesman",
    "keywords": [
      "تقرير",
      "المندوبين",
      "Sales",
      "reps",
      "reports",
      "sales",
      "by",
      "salesman"
    ],
    "steps": [
      "افتح «تقرير المندوبين» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:salesman-commissions",
    "title": "📋 طباعة فواتير مندوب وعمولاتهم",
    "href": "/sales/salesman-commissions",
    "keywords": [
      "طباعة",
      "فواتير",
      "مندوب",
      "وعمولاتهم",
      "Salesman",
      "commissions",
      "sales",
      "salesman"
    ],
    "steps": [
      "افتح «📋 طباعة فواتير مندوب وعمولاتهم» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:employee-sales",
    "title": "مبيعات موظف",
    "href": "/reports/sales-by-employee",
    "keywords": [
      "مبيعات",
      "موظف",
      "Sales",
      "by",
      "employee",
      "reports",
      "sales"
    ],
    "steps": [
      "افتح «مبيعات موظف» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:customer-statement",
    "title": "كشف عميل",
    "href": "/sales/statements",
    "keywords": [
      "كشف",
      "عميل",
      "Customer",
      "statement",
      "sales",
      "statements"
    ],
    "steps": [
      "افتح «كشف عميل» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:customer-balances",
    "title": "أرصدة حساب العملاء",
    "href": "/reports/customer-balances",
    "keywords": [
      "أرصدة",
      "حساب",
      "العملاء",
      "Customer",
      "account",
      "balances",
      "reports",
      "customer"
    ],
    "steps": [
      "افتح «أرصدة حساب العملاء» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:customer-last-payment",
    "title": "حركة آخر سداد للعملاء",
    "href": "/reports/customer-last-payment",
    "keywords": [
      "حركة",
      "آخر",
      "سداد",
      "للعملاء",
      "Last",
      "payment",
      "movement",
      "reports",
      "customer",
      "last"
    ],
    "steps": [
      "افتح «حركة آخر سداد للعملاء» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:customer-settlements",
    "title": "سداد العملاء",
    "href": "/reports/customer-settlements",
    "keywords": [
      "سداد",
      "العملاء",
      "Customer",
      "settlements",
      "reports",
      "customer"
    ],
    "steps": [
      "افتح «سداد العملاء» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:invoices-by-customer",
    "title": "الفواتير بحسب العملاء",
    "href": "/reports/invoices-by-customer",
    "keywords": [
      "الفواتير",
      "بحسب",
      "العملاء",
      "Invoices",
      "by",
      "customer",
      "reports",
      "invoices"
    ],
    "steps": [
      "افتح «الفواتير بحسب العملاء» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:sales-movement",
    "title": "حركة المبيعات",
    "href": "/reports/sales-by-day",
    "keywords": [
      "حركة",
      "المبيعات",
      "Sales",
      "movement",
      "reports",
      "sales",
      "by",
      "day"
    ],
    "steps": [
      "افتح «حركة المبيعات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:sales-chart",
    "title": "تقرير بياني",
    "href": "/reports/monthly-sales",
    "keywords": [
      "تقرير",
      "بياني",
      "Chart",
      "report",
      "reports",
      "monthly",
      "sales"
    ],
    "steps": [
      "افتح «تقرير بياني» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:contracting-invoices-report",
    "title": "تقرير فواتير المقاولات",
    "href": "/reports/project-bills",
    "keywords": [
      "تقرير",
      "فواتير",
      "المقاولات",
      "Contracting",
      "invoices",
      "reports",
      "project",
      "bills"
    ],
    "steps": [
      "افتح «تقرير فواتير المقاولات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:pos-sales",
    "title": "تقرير مبيعات POS",
    "href": "/reports/pos-sales",
    "keywords": [
      "تقرير",
      "مبيعات",
      "POS",
      "sales",
      "reports",
      "pos"
    ],
    "steps": [
      "افتح «تقرير مبيعات POS» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:pos-item-detail",
    "title": "تفاصيل أصناف POS",
    "href": "/reports/pos-item-detail",
    "keywords": [
      "تفاصيل",
      "أصناف",
      "POS",
      "item",
      "detail",
      "reports",
      "pos"
    ],
    "steps": [
      "افتح «تفاصيل أصناف POS» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:pos-item-summary",
    "title": "أصناف POS تجميعي",
    "href": "/reports/pos-item-summary",
    "keywords": [
      "أصناف",
      "POS",
      "تجميعي",
      "item",
      "summary",
      "reports",
      "pos"
    ],
    "steps": [
      "افتح «أصناف POS تجميعي» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:pos-daily",
    "title": "تقرير المبيعات اليومية",
    "href": "/reports/pos-daily",
    "keywords": [
      "تقرير",
      "المبيعات",
      "اليومية",
      "Daily",
      "sales",
      "reports",
      "pos",
      "daily"
    ],
    "steps": [
      "افتح «تقرير المبيعات اليومية» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:pos-group",
    "title": "تقرير مبيعات للمجموعة",
    "href": "/reports/pos-by-category",
    "keywords": [
      "تقرير",
      "مبيعات",
      "للمجموعة",
      "Sales",
      "by",
      "group",
      "reports",
      "pos",
      "category"
    ],
    "steps": [
      "افتح «تقرير مبيعات للمجموعة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:customer-card",
    "title": "بطاقة عميل",
    "href": "/sales/customers",
    "keywords": [
      "بطاقة",
      "عميل",
      "Customer",
      "card",
      "sales",
      "customers"
    ],
    "steps": [
      "افتح «بطاقة عميل» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:rep-card",
    "title": "بطاقة مندوب",
    "href": "/sales/salesmen",
    "keywords": [
      "بطاقة",
      "مندوب",
      "Sales",
      "rep",
      "card",
      "sales",
      "salesmen"
    ],
    "steps": [
      "افتح «بطاقة مندوب» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:customer-portal-access",
    "title": "وصول العملاء للبوابة",
    "href": "/sales/portal-access",
    "keywords": [
      "وصول",
      "العملاء",
      "للبوابة",
      "Customer",
      "portal",
      "access",
      "sales"
    ],
    "steps": [
      "افتح «وصول العملاء للبوابة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:ecommerce-orders",
    "title": "طلبات المتجر الإلكتروني",
    "href": "/sales/ecommerce-orders",
    "keywords": [
      "طلبات",
      "المتجر",
      "الإلكتروني",
      "commerce",
      "orders",
      "sales",
      "ecommerce"
    ],
    "steps": [
      "افتح «طلبات المتجر الإلكتروني» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:crm-pipelines",
    "title": "مسار المبيعات",
    "href": "/crm/pipelines",
    "keywords": [
      "مسار",
      "المبيعات",
      "CRM",
      "pipeline",
      "crm",
      "pipelines"
    ],
    "steps": [
      "افتح «مسار المبيعات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:crm-activities",
    "title": "أنشطة المبيعات",
    "href": "/crm/activities",
    "keywords": [
      "أنشطة",
      "المبيعات",
      "CRM",
      "activities",
      "crm"
    ],
    "steps": [
      "افتح «أنشطة المبيعات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:crm-forecast",
    "title": "تنبؤ المبيعات",
    "href": "/crm/forecast",
    "keywords": [
      "تنبؤ",
      "المبيعات",
      "Sales",
      "forecast",
      "crm"
    ],
    "steps": [
      "افتح «تنبؤ المبيعات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:tailoring-order",
    "title": "إدارة طلبات التفصيل",
    "href": "/tailoring/orders",
    "keywords": [
      "إدارة",
      "طلبات",
      "التفصيل",
      "Tailoring",
      "orders",
      "tailoring"
    ],
    "steps": [
      "افتح «إدارة طلبات التفصيل» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:tailoring-invoice",
    "title": "فواتير التفصيل",
    "href": "/tailoring/invoices",
    "keywords": [
      "فواتير",
      "التفصيل",
      "Tailoring",
      "invoices",
      "tailoring"
    ],
    "steps": [
      "افتح «فواتير التفصيل» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:tailoring-measurement",
    "title": "قياسات العملاء",
    "href": "/tailoring/measurements",
    "keywords": [
      "قياسات",
      "العملاء",
      "Customer",
      "measurements",
      "tailoring"
    ],
    "steps": [
      "افتح «قياسات العملاء» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:tailoring-measurement-attribute",
    "title": "خصائص القياسات",
    "href": "/tailoring/measurements/attributes",
    "keywords": [
      "خصائص",
      "القياسات",
      "Measurement",
      "attributes",
      "tailoring",
      "measurements"
    ],
    "steps": [
      "افتح «خصائص القياسات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:tailoring-options",
    "title": "إدارة الخيارات الجاهزة",
    "href": "/tailoring/options",
    "keywords": [
      "إدارة",
      "الخيارات",
      "الجاهزة",
      "Tailoring",
      "options",
      "tailoring"
    ],
    "steps": [
      "افتح «إدارة الخيارات الجاهزة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:tailoring-type",
    "title": "أنواع التفصيل",
    "href": "/tailoring/types",
    "keywords": [
      "أنواع",
      "التفصيل",
      "Tailoring",
      "types",
      "tailoring"
    ],
    "steps": [
      "افتح «أنواع التفصيل» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:optics-prescription",
    "title": "بيانات النظارات",
    "href": "/optics/prescriptions",
    "keywords": [
      "بيانات",
      "النظارات",
      "Glasses",
      "prescriptions",
      "optics"
    ],
    "steps": [
      "افتح «بيانات النظارات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:optics-field-label",
    "title": "أسماء الحقول",
    "href": "/optics/field-labels",
    "keywords": [
      "أسماء",
      "الحقول",
      "Field",
      "labels",
      "optics",
      "field"
    ],
    "steps": [
      "افتح «أسماء الحقول» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:departments",
    "title": "الإدارات والأقسام",
    "href": "/hrm/departments",
    "keywords": [
      "الإدارات",
      "والأقسام",
      "Departments",
      "sections",
      "hrm",
      "departments"
    ],
    "steps": [
      "افتح «الإدارات والأقسام» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:jobs",
    "title": "الوظائف",
    "href": "/hrm/jobs",
    "keywords": [
      "الوظائف",
      "Jobs",
      "hrm",
      "jobs"
    ],
    "steps": [
      "افتح «الوظائف» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:employee",
    "title": "تعريف موظف",
    "href": "/hrm/employees",
    "keywords": [
      "تعريف",
      "موظف",
      "Employee",
      "hrm",
      "employees"
    ],
    "steps": [
      "افتح «تعريف موظف» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:adjustments",
    "title": "الحوافز والجزاءات",
    "href": "/hrm/adjustments",
    "keywords": [
      "الحوافز",
      "والجزاءات",
      "Bonuses",
      "deductions",
      "hrm",
      "adjustments"
    ],
    "steps": [
      "افتح «الحوافز والجزاءات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:payroll-run",
    "title": "إستحقاق وصرف الرواتب",
    "href": "/hrm/payroll",
    "keywords": [
      "إستحقاق",
      "وصرف",
      "الرواتب",
      "Payroll",
      "run",
      "and",
      "payment",
      "hrm",
      "payroll"
    ],
    "steps": [
      "افتح «إستحقاق وصرف الرواتب» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:hrm-compliance",
    "title": "تنبيهات الإقامة والتأمين",
    "href": "/hrm/compliance",
    "keywords": [
      "تنبيهات",
      "الإقامة",
      "والتأمين",
      "Iqama",
      "and",
      "insurance",
      "alerts",
      "hrm",
      "compliance"
    ],
    "steps": [
      "افتح «تنبيهات الإقامة والتأمين» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:hrm-leaves",
    "title": "إجازات الموظفين",
    "href": "/hrm/leaves",
    "keywords": [
      "إجازات",
      "الموظفين",
      "Approved",
      "leave",
      "hrm",
      "leaves"
    ],
    "steps": [
      "افتح «إجازات الموظفين» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:hrm-geofences",
    "title": "نطاق حضور الفروع",
    "href": "/hrm/geofences",
    "keywords": [
      "نطاق",
      "حضور",
      "الفروع",
      "Attendance",
      "geofence",
      "hrm",
      "geofences"
    ],
    "steps": [
      "افتح «نطاق حضور الفروع» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:salary-payments",
    "title": "دفع الرواتب",
    "href": "/hrm/salary-payments",
    "keywords": [
      "دفع",
      "الرواتب",
      "Salary",
      "payment",
      "hrm",
      "salary",
      "payments"
    ],
    "steps": [
      "افتح «دفع الرواتب» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:salary-report",
    "title": "تقرير الرواتب",
    "href": "/hrm/salary-report",
    "keywords": [
      "تقرير",
      "الرواتب",
      "Salary",
      "report",
      "hrm",
      "salary"
    ],
    "steps": [
      "افتح «تقرير الرواتب» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:salary-payments-report",
    "title": "دفع الرواتب",
    "href": "/reports/payroll-payments",
    "keywords": [
      "دفع",
      "الرواتب",
      "Payroll",
      "payments",
      "report",
      "reports",
      "payroll"
    ],
    "steps": [
      "افتح «دفع الرواتب» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:employee-movements",
    "title": "حركات الموظف",
    "href": "/hrm/employee-movements",
    "keywords": [
      "حركات",
      "الموظف",
      "Employee",
      "movements",
      "hrm",
      "employee"
    ],
    "steps": [
      "افتح «حركات الموظف» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:employee-account",
    "title": "كشف حساب موظف",
    "href": "/hrm/employee-statement",
    "keywords": [
      "كشف",
      "حساب",
      "موظف",
      "Employee",
      "account",
      "statement",
      "hrm",
      "employee"
    ],
    "steps": [
      "افتح «كشف حساب موظف» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:user-logs",
    "title": "سجلات المستخدمين",
    "href": "/settings/audit",
    "keywords": [
      "سجلات",
      "المستخدمين",
      "User",
      "logs",
      "settings",
      "audit"
    ],
    "steps": [
      "افتح «سجلات المستخدمين» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:marina-group",
    "title": "بطاقة الفئة وفترات التأجير",
    "href": "/marina/groups",
    "keywords": [
      "بطاقة",
      "الفئة",
      "وفترات",
      "التأجير",
      "Group",
      "card",
      "and",
      "rental",
      "periods",
      "marina",
      "groups"
    ],
    "steps": [
      "افتح «بطاقة الفئة وفترات التأجير» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:marina-vessel",
    "title": "بطاقات النماذج والمراكب والملاك",
    "href": "/marina/vessels",
    "keywords": [
      "بطاقات",
      "النماذج",
      "والمراكب",
      "والملاك",
      "Model",
      "vessel",
      "and",
      "owner",
      "cards",
      "marina",
      "vessels"
    ],
    "steps": [
      "افتح «بطاقات النماذج والمراكب والملاك» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:marina-additions",
    "title": "الإضافات",
    "href": "/marina/additions",
    "keywords": [
      "الإضافات",
      "Booking",
      "additions",
      "marina"
    ],
    "steps": [
      "افتح «الإضافات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:marina-prep",
    "title": "تحضير المراكب",
    "href": "/marina/preparation",
    "keywords": [
      "تحضير",
      "المراكب",
      "Vessel",
      "preparation",
      "marina"
    ],
    "steps": [
      "افتح «تحضير المراكب» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:marina-violations",
    "title": "المخالفات",
    "href": "/marina/violations",
    "keywords": [
      "المخالفات",
      "Violations",
      "marina",
      "violations"
    ],
    "steps": [
      "افتح «المخالفات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:marina-rota",
    "title": "خطة الدور",
    "href": "/marina/rota",
    "keywords": [
      "خطة",
      "الدور",
      "Rotation",
      "plan",
      "marina",
      "rota"
    ],
    "steps": [
      "افتح «خطة الدور» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:marina-link",
    "title": "بحث الفواتير",
    "href": "/marina/link-invoices",
    "keywords": [
      "بحث",
      "الفواتير",
      "Rental",
      "invoice",
      "search",
      "marina",
      "link",
      "invoices"
    ],
    "steps": [
      "افتح «بحث الفواتير» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:marina-bookings",
    "title": "الحجوزات",
    "href": "/marina/bookings",
    "keywords": [
      "الحجوزات",
      "Bookings",
      "marina",
      "bookings"
    ],
    "steps": [
      "افتح «الحجوزات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:marina-day-close",
    "title": "إغلاق اليومية",
    "href": "/marina/day-close",
    "keywords": [
      "إغلاق",
      "اليومية",
      "Day",
      "close",
      "marina",
      "day"
    ],
    "steps": [
      "افتح «إغلاق اليومية» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:marina-day-closes",
    "title": "إغلاقات اليومية",
    "href": "/reports/cashier-shift",
    "keywords": [
      "إغلاقات",
      "اليومية",
      "Day",
      "closes",
      "reports",
      "cashier",
      "shift"
    ],
    "steps": [
      "افتح «إغلاقات اليومية» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:marina-rental-invoices",
    "title": "تقرير فواتير التأجير",
    "href": "/reports/marina-rentals",
    "keywords": [
      "تقرير",
      "فواتير",
      "التأجير",
      "Rental",
      "invoices",
      "reports",
      "marina",
      "rentals"
    ],
    "steps": [
      "افتح «تقرير فواتير التأجير» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:boq-item",
    "title": "بطاقة بند",
    "href": "/projects/boq",
    "keywords": [
      "بطاقة",
      "بند",
      "BOQ",
      "item",
      "card",
      "projects",
      "boq"
    ],
    "steps": [
      "افتح «بطاقة بند» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:project-stages",
    "title": "مراحل مشروع",
    "href": "/projects/stages",
    "keywords": [
      "مراحل",
      "مشروع",
      "Project",
      "stages",
      "projects"
    ],
    "steps": [
      "افتح «مراحل مشروع» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:customer-contract",
    "title": "عقد عميل",
    "href": "/projects",
    "keywords": [
      "عقد",
      "عميل",
      "Customer",
      "contract",
      "projects"
    ],
    "steps": [
      "افتح «عقد عميل» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:contractor-contract",
    "title": "عقد مقاول",
    "href": "/projects/contractor-contract",
    "keywords": [
      "عقد",
      "مقاول",
      "Contractor",
      "contract",
      "projects",
      "contractor"
    ],
    "steps": [
      "افتح «عقد مقاول» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:project-followup",
    "title": "متابعة",
    "href": "/projects/followup",
    "keywords": [
      "متابعة",
      "Follow",
      "up",
      "projects",
      "followup"
    ],
    "steps": [
      "افتح «متابعة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:project-board",
    "title": "لوحة كانبان",
    "href": "/projects/board",
    "keywords": [
      "لوحة",
      "كانبان",
      "Kanban",
      "board",
      "projects"
    ],
    "steps": [
      "افتح «لوحة كانبان» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:project-gantt",
    "title": "مخطط جانت",
    "href": "/projects/gantt",
    "keywords": [
      "مخطط",
      "جانت",
      "Gantt",
      "projects",
      "gantt"
    ],
    "steps": [
      "افتح «مخطط جانت» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:project-time",
    "title": "تتبع الوقت",
    "href": "/projects/time",
    "keywords": [
      "تتبع",
      "الوقت",
      "Time",
      "tracking",
      "projects",
      "time"
    ],
    "steps": [
      "افتح «تتبع الوقت» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:project-cost",
    "title": "تكلفة المشروع",
    "href": "/projects/cost",
    "keywords": [
      "تكلفة",
      "المشروع",
      "Project",
      "cost",
      "projects"
    ],
    "steps": [
      "افتح «تكلفة المشروع» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:project-offers",
    "title": "عروض",
    "href": "/projects/offers",
    "keywords": [
      "عروض",
      "Offers",
      "projects",
      "offers"
    ],
    "steps": [
      "افتح «عروض» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:contractor-payment",
    "title": "سند دفع لمقاول",
    "href": "/projects/contractor-payment",
    "keywords": [
      "سند",
      "دفع",
      "لمقاول",
      "Contractor",
      "payment",
      "projects",
      "contractor"
    ],
    "steps": [
      "افتح «سند دفع لمقاول» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:company-card",
    "title": "بطاقة المنشأة",
    "href": "/settings/company",
    "keywords": [
      "بطاقة",
      "المنشأة",
      "Company",
      "card",
      "settings",
      "company"
    ],
    "steps": [
      "افتح «بطاقة المنشأة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:branch-card",
    "title": "بطاقة فرع",
    "href": "/settings/branches",
    "keywords": [
      "بطاقة",
      "فرع",
      "Branch",
      "card",
      "settings",
      "branches"
    ],
    "steps": [
      "افتح «بطاقة فرع» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:posting-profiles",
    "title": "الربط المحاسبي",
    "href": "/settings/posting-profiles",
    "keywords": [
      "الربط",
      "المحاسبي",
      "Posting",
      "profiles",
      "settings",
      "posting"
    ],
    "steps": [
      "افتح «الربط المحاسبي» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:zatca-settings",
    "title": "إعدادات الربط مع هيئة الزكاة والضريبة",
    "href": "/settings/zatca",
    "keywords": [
      "إعدادات",
      "الربط",
      "مع",
      "هيئة",
      "الزكاة",
      "والضريبة",
      "ZATCA",
      "integration",
      "settings",
      "zatca"
    ],
    "steps": [
      "افتح «إعدادات الربط مع هيئة الزكاة والضريبة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:zatca-sent",
    "title": "الفواتير المرفوعة على موقع الضرائب",
    "href": "/settings/zatca/sent",
    "keywords": [
      "الفواتير",
      "المرفوعة",
      "على",
      "موقع",
      "الضرائب",
      "Sent",
      "invoices",
      "settings",
      "zatca",
      "sent"
    ],
    "steps": [
      "افتح «الفواتير المرفوعة على موقع الضرائب» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:zatca-status",
    "title": "مزامنة الفواتير - ZATCA",
    "href": "/settings/zatca/status",
    "keywords": [
      "مزامنة",
      "الفواتير",
      "ZATCA",
      "invoice",
      "sync",
      "settings",
      "zatca",
      "status"
    ],
    "steps": [
      "افتح «مزامنة الفواتير - ZATCA» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:payment-gateways",
    "title": "بوابات الدفع — جيديا · NeoLeap",
    "href": "/settings/payment-gateways",
    "keywords": [
      "بوابات",
      "الدفع",
      "جيديا",
      "NeoLeap",
      "Payment",
      "gateways",
      "settings",
      "payment"
    ],
    "steps": [
      "افتح «بوابات الدفع — جيديا · NeoLeap» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:online-payments",
    "title": "روابط الدفع — ميسر",
    "href": "/settings/payments",
    "keywords": [
      "روابط",
      "الدفع",
      "ميسر",
      "Online",
      "payment",
      "links",
      "settings",
      "payments"
    ],
    "steps": [
      "افتح «روابط الدفع — ميسر» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:whatsapp",
    "title": "واتساب — إرسال الفواتير",
    "href": "/settings/whatsapp",
    "keywords": [
      "واتساب",
      "إرسال",
      "الفواتير",
      "WhatsApp",
      "settings",
      "whatsapp"
    ],
    "steps": [
      "افتح «واتساب — إرسال الفواتير» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:email",
    "title": "البريد — القوالب والسجلّ",
    "href": "/settings/email",
    "keywords": [
      "البريد",
      "القوالب",
      "والسجل",
      "mail",
      "settings",
      "email"
    ],
    "steps": [
      "افتح «البريد — القوالب والسجلّ» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:ecommerce",
    "title": "التجارة الإلكترونية — سلة · زد · Shopify",
    "href": "/settings/ecommerce",
    "keywords": [
      "التجارة",
      "الإلكترونية",
      "سلة",
      "زد",
      "Shopify",
      "commerce",
      "settings",
      "ecommerce"
    ],
    "steps": [
      "افتح «التجارة الإلكترونية — سلة · زد · Shopify» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:marketplace",
    "title": "سوق الإضافات",
    "href": "/settings/marketplace",
    "keywords": [
      "سوق",
      "الإضافات",
      "Marketplace",
      "settings",
      "marketplace"
    ],
    "steps": [
      "افتح «سوق الإضافات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:white-label",
    "title": "الدومين والشعار",
    "href": "/settings/white-label",
    "keywords": [
      "الدومين",
      "والشعار",
      "White",
      "label",
      "settings",
      "white"
    ],
    "steps": [
      "افتح «الدومين والشعار» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:approval-settings",
    "title": "مسارات الموافقات",
    "href": "/settings/approvals",
    "keywords": [
      "مسارات",
      "الموافقات",
      "Approval",
      "workflows",
      "settings",
      "approvals"
    ],
    "steps": [
      "افتح «مسارات الموافقات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:custom-fields",
    "title": "الحقول الإضافية",
    "href": "/settings/custom-fields",
    "keywords": [
      "الحقول",
      "الإضافية",
      "Custom",
      "fields",
      "settings",
      "custom"
    ],
    "steps": [
      "افتح «الحقول الإضافية» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:file-manager",
    "title": "مدير الملفات",
    "href": "/settings/files",
    "keywords": [
      "مدير",
      "الملفات",
      "File",
      "manager",
      "settings",
      "files"
    ],
    "steps": [
      "افتح «مدير الملفات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:backup",
    "title": "النسخ الإحتياطي",
    "href": "/settings/backup",
    "keywords": [
      "النسخ",
      "الإحتياطي",
      "Backup",
      "settings",
      "backup"
    ],
    "steps": [
      "افتح «النسخ الإحتياطي» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:data-rotation",
    "title": "تدوير البيانات",
    "href": "/settings/data-rotation",
    "keywords": [
      "تدوير",
      "البيانات",
      "Data",
      "rotation",
      "settings",
      "data"
    ],
    "steps": [
      "افتح «تدوير البيانات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:new-file",
    "title": "إنشاء ملف",
    "href": "/settings/new-file",
    "keywords": [
      "إنشاء",
      "ملف",
      "New",
      "company",
      "file",
      "settings",
      "new"
    ],
    "steps": [
      "افتح «إنشاء ملف» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:import-export",
    "title": "إستيراد وتصدير البيانات",
    "href": "/migration/runs",
    "keywords": [
      "إستيراد",
      "وتصدير",
      "البيانات",
      "Import",
      "export",
      "migration",
      "runs"
    ],
    "steps": [
      "افتح «إستيراد وتصدير البيانات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:invoice-maintenance",
    "title": "صيانة الفواتير",
    "href": "/settings/invoice-maintenance",
    "keywords": [
      "صيانة",
      "الفواتير",
      "Invoice",
      "maintenance",
      "settings",
      "invoice"
    ],
    "steps": [
      "افتح «صيانة الفواتير» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:offers",
    "title": "العروض",
    "href": "/settings/offers",
    "keywords": [
      "العروض",
      "Offers",
      "settings",
      "offers"
    ],
    "steps": [
      "افتح «العروض» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:data-sync",
    "title": "مزامنة البيانات",
    "href": "/settings/sync",
    "keywords": [
      "مزامنة",
      "البيانات",
      "Data",
      "sync",
      "settings"
    ],
    "steps": [
      "افتح «مزامنة البيانات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:restore",
    "title": "إستعادة البيانات",
    "href": "/settings/restore",
    "keywords": [
      "إستعادة",
      "البيانات",
      "Restore",
      "settings",
      "restore"
    ],
    "steps": [
      "افتح «إستعادة البيانات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:ai-assistant",
    "title": "المساعد المحاسبي",
    "href": "/assistant",
    "keywords": [
      "المساعد",
      "المحاسبي",
      "Accounting",
      "assistant"
    ],
    "steps": [
      "افتح «المساعد المحاسبي» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:ai-settings",
    "title": "إعدادات المساعد",
    "href": "/settings/ai",
    "keywords": [
      "إعدادات",
      "المساعد",
      "Assistant",
      "settings",
      "ai"
    ],
    "steps": [
      "افتح «إعدادات المساعد» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:user-card",
    "title": "بطاقة مستخدم",
    "href": "/settings/users",
    "keywords": [
      "بطاقة",
      "مستخدم",
      "User",
      "card",
      "settings",
      "users"
    ],
    "steps": [
      "افتح «بطاقة مستخدم» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:user-permissions",
    "title": "صلاحيات المستخدمين",
    "href": "/settings/roles",
    "keywords": [
      "صلاحيات",
      "المستخدمين",
      "User",
      "permissions",
      "settings",
      "roles"
    ],
    "steps": [
      "افتح «صلاحيات المستخدمين» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:change-password",
    "title": "تغيير كلمة المرور",
    "href": "/settings/change-password",
    "keywords": [
      "تغيير",
      "كلمة",
      "المرور",
      "Change",
      "password",
      "settings",
      "change"
    ],
    "steps": [
      "افتح «تغيير كلمة المرور» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:two-factor",
    "title": "التحقق بخطوتين",
    "href": "/settings/two-factor",
    "keywords": [
      "التحقق",
      "بخطوتين",
      "Two",
      "factor",
      "authentication",
      "settings",
      "two"
    ],
    "steps": [
      "افتح «التحقق بخطوتين» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:general-settings",
    "title": "إعدادات عامة",
    "href": "/settings/general",
    "keywords": [
      "إعدادات",
      "عامة",
      "General",
      "settings",
      "general"
    ],
    "steps": [
      "افتح «إعدادات عامة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:comment-mentions",
    "title": "إشارات التعليقات",
    "href": "/comments/mentions",
    "keywords": [
      "إشارات",
      "التعليقات",
      "Comment",
      "mentions",
      "comments"
    ],
    "steps": [
      "افتح «إشارات التعليقات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:notifications",
    "title": "مركز الإشعارات",
    "href": "/notifications",
    "keywords": [
      "مركز",
      "الإشعارات",
      "Notification",
      "centre",
      "notifications"
    ],
    "steps": [
      "افتح «مركز الإشعارات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:approval-inbox",
    "title": "وارد الموافقات",
    "href": "/approvals/inbox",
    "keywords": [
      "وارد",
      "الموافقات",
      "Approval",
      "inbox",
      "approvals"
    ],
    "steps": [
      "افتح «وارد الموافقات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:approval-history",
    "title": "سجل الموافقات",
    "href": "/approvals/history",
    "keywords": [
      "سجل",
      "الموافقات",
      "Approval",
      "history",
      "approvals"
    ],
    "steps": [
      "افتح «سجل الموافقات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:usage",
    "title": "الاستخدام والحصص",
    "href": "/settings/usage",
    "keywords": [
      "الاستخدام",
      "والحصص",
      "Usage",
      "quotas",
      "settings",
      "usage"
    ],
    "steps": [
      "افتح «الاستخدام والحصص» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:printing-settings",
    "title": "إعدادات الطباعة",
    "href": "/settings/printing",
    "keywords": [
      "إعدادات",
      "الطباعة",
      "Printing",
      "settings",
      "printing"
    ],
    "steps": [
      "افتح «إعدادات الطباعة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:language",
    "title": "اللغة",
    "href": "/settings/language",
    "keywords": [
      "اللغة",
      "Language",
      "settings",
      "language"
    ],
    "steps": [
      "افتح «اللغة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:salla-settings",
    "title": "إعدادات ربط سلة",
    "href": "/integrations/salla/settings",
    "keywords": [
      "إعدادات",
      "ربط",
      "سلة",
      "Salla",
      "integration",
      "integrations",
      "salla",
      "settings"
    ],
    "steps": [
      "افتح «إعدادات ربط سلة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:sync-invoices",
    "title": "مزامنة الفواتير",
    "href": "/settings/sync/invoices",
    "keywords": [
      "مزامنة",
      "الفواتير",
      "Invoice",
      "sync",
      "settings",
      "invoices"
    ],
    "steps": [
      "افتح «مزامنة الفواتير» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:sync-journals",
    "title": "مزامنة القيود",
    "href": "/settings/sync/journals",
    "keywords": [
      "مزامنة",
      "القيود",
      "Journal",
      "sync",
      "settings",
      "journals"
    ],
    "steps": [
      "افتح «مزامنة القيود» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:sync-vouchers",
    "title": "مزامنة السندات",
    "href": "/settings/sync/vouchers",
    "keywords": [
      "مزامنة",
      "السندات",
      "Voucher",
      "sync",
      "settings",
      "vouchers"
    ],
    "steps": [
      "افتح «مزامنة السندات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:sync-stock",
    "title": "مزامنة المخزون",
    "href": "/settings/sync/stock",
    "keywords": [
      "مزامنة",
      "المخزون",
      "Stock",
      "sync",
      "settings",
      "stock"
    ],
    "steps": [
      "افتح «مزامنة المخزون» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:sync-manage",
    "title": "إدارة المزامنة",
    "href": "/settings/sync/manage",
    "keywords": [
      "إدارة",
      "المزامنة",
      "Sync",
      "management",
      "settings",
      "sync",
      "manage"
    ],
    "steps": [
      "افتح «إدارة المزامنة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:sync-prices",
    "title": "إعدادات الأسعار",
    "href": "/settings/price-lists",
    "keywords": [
      "إعدادات",
      "الأسعار",
      "Price",
      "settings",
      "price",
      "lists"
    ],
    "steps": [
      "افتح «إعدادات الأسعار» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:sync-zatca",
    "title": "مزامنة الفواتير Zatca",
    "href": "/settings/sync/zatca",
    "keywords": [
      "مزامنة",
      "الفواتير",
      "Zatca",
      "ZATCA",
      "sync",
      "settings",
      "zatca"
    ],
    "steps": [
      "افتح «مزامنة الفواتير Zatca» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:android-devices",
    "title": "أجهزة أندرويد المرتبطة",
    "href": "/settings/devices",
    "keywords": [
      "أجهزة",
      "أندرويد",
      "المرتبطة",
      "Linked",
      "Android",
      "devices",
      "settings"
    ],
    "steps": [
      "افتح «أجهزة أندرويد المرتبطة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:license",
    "title": "الترخيص",
    "href": "/support/license",
    "keywords": [
      "الترخيص",
      "Licence",
      "support",
      "license"
    ],
    "steps": [
      "افتح «الترخيص» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:about",
    "title": "عن البرنامج",
    "href": "/support/about",
    "keywords": [
      "عن",
      "البرنامج",
      "About",
      "support",
      "about"
    ],
    "steps": [
      "افتح «عن البرنامج» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:update",
    "title": "تحديث البرنامج",
    "href": "/support/about#updates",
    "keywords": [
      "تحديث",
      "البرنامج",
      "Update",
      "support",
      "about",
      "updates"
    ],
    "steps": [
      "افتح «تحديث البرنامج» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:report-designer",
    "title": "فتح المصمم لتصميم التقارير",
    "href": "/support/report-designer",
    "keywords": [
      "فتح",
      "المصمم",
      "لتصميم",
      "التقارير",
      "Report",
      "designer",
      "support",
      "report"
    ],
    "steps": [
      "افتح «فتح المصمم لتصميم التقارير» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:help",
    "title": "🆘 إطلب المساعدة",
    "href": "/support/help",
    "keywords": [
      "إطلب",
      "المساعدة",
      "Request",
      "help",
      "support"
    ],
    "steps": [
      "افتح «🆘 إطلب المساعدة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:safe-card",
    "title": "🏦 تعريف الخزينة",
    "href": "/treasury/safes",
    "keywords": [
      "تعريف",
      "الخزينة",
      "Safes",
      "treasury",
      "safes"
    ],
    "steps": [
      "افتح «🏦 تعريف الخزينة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:bank-def",
    "title": "🏦 تعريف البنوك",
    "href": "/treasury/banks",
    "keywords": [
      "تعريف",
      "البنوك",
      "Banks",
      "treasury",
      "banks"
    ],
    "steps": [
      "افتح «🏦 تعريف البنوك» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:expense-card",
    "title": "📒 بطاقة حساب المصاريف",
    "href": "/accounting/expenses",
    "keywords": [
      "بطاقة",
      "حساب",
      "المصاريف",
      "Expense",
      "card",
      "accounting",
      "expenses"
    ],
    "steps": [
      "افتح «📒 بطاقة حساب المصاريف» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:bank-accounts",
    "title": "الحسابات البنكية",
    "href": "/treasury/bank-accounts",
    "keywords": [
      "الحسابات",
      "البنكية",
      "Bank",
      "accounts",
      "treasury",
      "bank"
    ],
    "steps": [
      "افتح «الحسابات البنكية» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:bank-statements",
    "title": "كشوف الحساب البنكي",
    "href": "/treasury/bank-statements",
    "keywords": [
      "كشوف",
      "الحساب",
      "البنكي",
      "Bank",
      "statements",
      "treasury",
      "bank"
    ],
    "steps": [
      "افتح «كشوف الحساب البنكي» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:bank-reconciliation",
    "title": "التسوية البنكية",
    "href": "/treasury/bank-reconciliation",
    "keywords": [
      "التسوية",
      "البنكية",
      "Bank",
      "reconciliation",
      "treasury",
      "bank"
    ],
    "steps": [
      "افتح «التسوية البنكية» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:receipt-voucher",
    "title": "📄 سند قبض",
    "href": "/treasury/vouchers?kind=receipt",
    "keywords": [
      "سند",
      "قبض",
      "Receipt",
      "voucher",
      "treasury",
      "vouchers",
      "kind",
      "receipt"
    ],
    "steps": [
      "افتح «📄 سند قبض» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:payment-voucher",
    "title": "📄 سند صرف",
    "href": "/treasury/vouchers?kind=payment",
    "keywords": [
      "سند",
      "صرف",
      "Payment",
      "voucher",
      "treasury",
      "vouchers",
      "kind",
      "payment"
    ],
    "steps": [
      "افتح «📄 سند صرف» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:day-close",
    "title": "📊 إغلاق اليومية",
    "href": "/treasury/day-close",
    "keywords": [
      "إغلاق",
      "اليومية",
      "Day",
      "close",
      "treasury",
      "day"
    ],
    "steps": [
      "افتح «📊 إغلاق اليومية» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:cash-transfer",
    "title": "مناقلة",
    "href": "/treasury/transfers",
    "keywords": [
      "مناقلة",
      "Cash",
      "transfer",
      "treasury",
      "transfers"
    ],
    "steps": [
      "افتح «مناقلة» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:cheques",
    "title": "🏦 كشف الشيكات",
    "href": "/treasury/cheques",
    "keywords": [
      "كشف",
      "الشيكات",
      "Cheque",
      "register",
      "treasury",
      "cheques"
    ],
    "steps": [
      "افتح «🏦 كشف الشيكات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:safe-movement",
    "title": "🏦 حركة الصندوق",
    "href": "/treasury/movements",
    "keywords": [
      "حركة",
      "الصندوق",
      "Safe",
      "movement",
      "treasury",
      "movements"
    ],
    "steps": [
      "افتح «🏦 حركة الصندوق» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:employee-home",
    "title": "تطبيق الموظف",
    "href": "/m",
    "keywords": [
      "تطبيق",
      "الموظف",
      "Employee",
      "app"
    ],
    "steps": [
      "افتح «تطبيق الموظف» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:employee-attendance",
    "title": "حضور وانصراف",
    "href": "/m/attendance",
    "keywords": [
      "حضور",
      "وانصراف",
      "Attendance",
      "attendance"
    ],
    "steps": [
      "افتح «حضور وانصراف» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:employee-request",
    "title": "طلب جديد",
    "href": "/m/requests/new",
    "keywords": [
      "طلب",
      "جديد",
      "New",
      "request",
      "requests",
      "new"
    ],
    "steps": [
      "افتح «طلب جديد» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:employee-profile",
    "title": "راتبي وإجازاتي",
    "href": "/m/profile",
    "keywords": [
      "راتبي",
      "وإجازاتي",
      "Payslips",
      "and",
      "leave",
      "profile"
    ],
    "steps": [
      "افتح «راتبي وإجازاتي» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:employee-approvals",
    "title": "موافقات الفريق",
    "href": "/m/approvals",
    "keywords": [
      "موافقات",
      "الفريق",
      "Team",
      "approvals"
    ],
    "steps": [
      "افتح «موافقات الفريق» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:manufacturing-boms",
    "title": "قوائم المواد",
    "href": "/manufacturing/boms",
    "keywords": [
      "قوائم",
      "المواد",
      "Bills",
      "of",
      "materials",
      "manufacturing",
      "boms"
    ],
    "steps": [
      "افتح «قوائم المواد» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:manufacturing-orders",
    "title": "أوامر التصنيع",
    "href": "/manufacturing/orders",
    "keywords": [
      "أوامر",
      "التصنيع",
      "Manufacturing",
      "orders",
      "manufacturing"
    ],
    "steps": [
      "افتح «أوامر التصنيع» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  },
  {
    "id": "nav:bi-dashboards",
    "title": "لوحات المؤشرات",
    "href": "/dashboards",
    "keywords": [
      "لوحات",
      "المؤشرات",
      "Dashboards",
      "dashboards"
    ],
    "steps": [
      "افتح «لوحات المؤشرات» من قائمة النظام.",
      "أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد."
    ],
    "source": "navigation"
  }
];
