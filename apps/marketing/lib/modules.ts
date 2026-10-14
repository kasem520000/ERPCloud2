/**
 * P-M2 — الوحدات الثمانية المعروضة في الموقع.
 *
 * **المصدر هو شجرة `apps/staff`** لا قائمةٌ مكتوبة هنا: كل تسمية ورمز من
 * `apps/staff/lib/navigation.ts` بالسطر، وهذا ما يجعل الموقع يقول ما يقوله المنتج —
 * ولو تغيّرت تسميةٌ في التطبيق لظهر الفرق فوراً في المراجعة (الخطّة §5 P-M2: «شبكة
 * الوحدات الثمانية من شجرة `apps/staff` نفسها»).
 *
 * وثمانيةٌ لا اثنا عشر: القائمة تعرض ما يشتريه العميل من السوق، لا شاشات الضبط
 * (`settings`) ولا الدعم (`support`) ولا الوحدات الرأسية (`tailoring` · `optics` · القطاعات
 * في P-M8).
 */

export type SiteModule = {
  key: string;
  icon: string;
  /** التسمية العربية كما في `apps/staff/lib/navigation.ts` حرفياً. */
  labelAr: string;
  labelEn: string;
  /** مسار الشاشة في تطبيق العمل — يُظهر أن الوحدة موجودة فعلاً لا وصفاً تسويقياً. */
  staffHref: string;
  /** سطرٌ واحد يقول ما تفعله الوحدة (نصّ التسمية من الشجرة، والشرح من دليل الاستخدام). */
  blurbAr: string;
  blurbEn: string;
  /** ملف+سطر تسمية الوحدة في الشجرة — بوابة «المصدر بالسطر» في هذا المستودع. */
  source: string;
};

export const siteModules: readonly SiteModule[] = [
  {
    key: 'accounting',
    icon: '📊',
    labelAr: 'المحاسبة',
    labelEn: 'Accounting',
    staffHref: '/accounting/accounts',
    blurbAr: 'دليل حسابات، قيودٌ مزدوجة، ميزان مراجعة، وإقفال فترات — الدفتر الذي يقرؤه المدقّق.',
    blurbEn: 'Chart of accounts, double-entry, trial balance and period close — the ledger an auditor reads.',
    source: 'apps/staff/lib/navigation.ts#accounting',
  },
  {
    key: 'treasury',
    icon: '🏦',
    labelAr: 'الخزينة',
    labelEn: 'Treasury',
    staffHref: '/treasury/movements',
    blurbAr: 'مقبوضات ومدفوعات، تحويلات بين الصدوق والبنوك، وإقفال يومٍ بأرصدته.',
    blurbEn: 'Receipts, payments, transfers between tills and banks, and a day close with balances.',
    source: 'apps/staff/lib/navigation.ts#treasury',
  },
  {
    key: 'inventory',
    icon: '🏭',
    labelAr: 'المستودعات',
    labelEn: 'Inventory',
    staffHref: '/inventory/items',
    blurbAr: 'أصنافٌ ووحداتٌ وباركود، أرصدةٌ لكل مستودع، وتحويلاتٌ وأوامر إنتاج.',
    blurbEn: 'Items, units and barcodes, per-warehouse balances, transfers and production orders.',
    source: 'apps/staff/lib/navigation.ts#inventory',
  },
  {
    key: 'purchases',
    icon: '🛒',
    labelAr: 'المشتريات',
    labelEn: 'Purchases',
    staffHref: '/purchases/orders',
    blurbAr: 'أوامر شراء، استلامات، فواتير موردين، ومرتجعات — مربوطةً بالمخزون والدفتر.',
    blurbEn: 'Purchase orders, receipts, supplier invoices and returns — tied to stock and ledger.',
    source: 'apps/staff/lib/navigation.ts#purchases',
  },
  {
    key: 'sales',
    icon: '🧾',
    labelAr: 'المبيعات',
    labelEn: 'Sales',
    staffHref: '/sales/invoices',
    blurbAr: 'عروض أسعار، فواتير نقدية وآجلة، مرتجعات، وبوابة عملاء لكشف الحساب.',
    blurbEn: 'Quotations, cash and credit invoices, returns, and a customer portal for statements.',
    source: 'apps/staff/lib/navigation.ts#sales',
  },
  {
    key: 'hrm',
    icon: '👥',
    labelAr: 'الموظفين والرواتب',
    labelEn: 'HR & Payroll',
    staffHref: '/hrm/employees',
    blurbAr: 'ملفّات الموظفين، حركاتٌ وظيفية، حضورٌ، مسيّرات رواتب، وسلفٌ وخصومات.',
    blurbEn: 'Employee files, movements, attendance, payroll runs, advances and deductions.',
    source: 'apps/staff/lib/navigation.ts#hrm',
  },
  {
    key: 'marina',
    icon: '⛵',
    labelAr: 'إدارة المراسي',
    labelEn: 'Marina',
    staffHref: '/marina/berths',
    blurbAr: 'مراسي وعقودُ إيجار دورية، فواتيرُ خدمة، ومتابعةُ إشغالٍ موسمية.',
    blurbEn: 'Berths, recurring contracts, service invoices and seasonal occupancy.',
    source: 'apps/staff/lib/navigation.ts#marina',
  },
  {
    key: 'projects',
    icon: '🏗️',
    labelAr: 'إدارة المشاريع',
    labelEn: 'Projects',
    staffHref: '/projects/list',
    blurbAr: 'مشاريع بميزانياتها، مستخلصاتٌ ومقاولون من الباطن، وربحٌ لكل مشروع.',
    blurbEn: 'Projects with budgets, progress claims, subcontractors and per-project margin.',
    source: 'apps/staff/lib/navigation.ts#projects',
  },
];

/** «كيف تبدأ في خمس خطوات» — خطواتٌ من تدفّق الاشتراك الحقيقي لا من شعارات. */
export const onboardingSteps = [
  {
    titleAr: 'أنشئ المنشأة',
    titleEn: 'Create the workspace',
    bodyAr: 'الاسم والرمز والدولة والعملة — دقيقتان.',
    bodyEn: 'Name, code, country and currency — two minutes.',
  },
  {
    titleAr: 'أضف الفرع',
    titleEn: 'Add a branch',
    bodyAr: 'فرعٌ واحد أو فروعٌ، ولكلٍّ مخزنه وصدوقه.',
    bodyEn: 'One branch or many, each with its own store and till.',
  },
  {
    titleAr: 'ادعُ فريقك',
    titleEn: 'Invite your team',
    bodyAr: 'أدوارٌ جاهزة: مدير · محاسب · أمين صندوق.',
    bodyEn: 'Ready roles: manager, accountant, cashier.',
  },
  {
    titleAr: 'استورد دليل حساباتك',
    titleEn: 'Import your chart of accounts',
    bodyAr: 'الدليل السعودي جاهز، أو ارفع دليلك.',
    bodyEn: 'A Saudi chart ships by default, or upload yours.',
  },
  {
    titleAr: 'أصدر أول فاتورة',
    titleEn: 'Issue the first invoice',
    bodyAr: 'فاتورةٌ إلكترونية بترميز QR تُرسل في ثوانٍ.',
    bodyEn: 'An e-invoice with a QR code, sent in seconds.',
  },
];

/** قسم الفاتورة الإلكترونية — الأهمّ سعودياً (الخطّة §4). */
export const einvoicingPoints = [
  {
    titleAr: 'ترميز QR وفق مراحل زاتكا',
    titleEn: 'ZATCA QR per phase',
    bodyAr: 'رمزٌ يُقرأ من ورقة الفاتورة ويُتحقَّق منه من الموقع بلا حساب.',
    bodyEn: 'A code readable from paper and verifiable on this site without an account.',
  },
  {
    titleAr: 'ربطٌ مع منصة فاتورة',
    titleEn: 'Fatoora integration',
    bodyAr: 'بيانات المنشأة، توقيعٌ وترقيمٌ، وإرسالٌ في وضع التحقق.',
    bodyEn: 'Organization data, signing, numbering, and submission in simulation mode.',
  },
  {
    titleAr: 'تحقّقٌ عام من أي فاتورة',
    titleEn: 'Public invoice verification',
    bodyAr: 'أدخل رقم الفاتورة أو الرمز لتتأكّد أنها صادرةٌ منّا فعلاً.',
    bodyEn: 'Enter the number or the QR to confirm the invoice really came from us.',
  },
];
