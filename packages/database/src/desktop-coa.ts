/**
 * Desktop default chart of accounts — GENERATED, do not edit by hand.
 *
 * Regenerate: `node scripts/desktop-seed/extract-coa.mjs`
 * Sources: `Desktop_ERP/CrystalLiteDB.txt` + `Desktop_ERP/AlterDb.txt`
 * (112 accounts, AlterDb overrides applied).
 *
 * Mapping rules live in the extractor. Every new tenant receives this chart
 * through `OrgProvisioningService`; existing tenants via `pnpm seed:coa`.
 */

export type DesktopSeedAccount = {
  code: string;
  nameAr: string;
  /** Parent code; absent on the four roots. */
  parent?: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  /** Always explicit — contra accounts override their type's natural side. */
  normalBalance: 'debit' | 'credit';
  /** False on header groups; absent (postable) on leaves. */
  postable?: boolean;
};

export const DESKTOP_DEFAULT_COA: DesktopSeedAccount[] = [
  {
    "code": "1",
    "nameAr": "الأصول",
    "type": "asset",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "2",
    "nameAr": "الخصوم",
    "type": "liability",
    "normalBalance": "credit",
    "postable": false
  },
  {
    "code": "3",
    "nameAr": "المصروفات",
    "type": "expense",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "4",
    "nameAr": "إيرادات",
    "type": "revenue",
    "normalBalance": "credit",
    "postable": false
  },
  {
    "code": "11",
    "nameAr": "الأصول الثابتة",
    "parent": "1",
    "type": "asset",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "12",
    "nameAr": "الأصول المتداولة",
    "parent": "1",
    "type": "asset",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "21",
    "nameAr": "حقوق الملكية",
    "parent": "2",
    "type": "equity",
    "normalBalance": "credit",
    "postable": false
  },
  {
    "code": "22",
    "nameAr": "الخصوم المتداولة",
    "parent": "2",
    "type": "liability",
    "normalBalance": "credit",
    "postable": false
  },
  {
    "code": "23",
    "nameAr": "الخصوم  الغير متداولة",
    "parent": "2",
    "type": "liability",
    "normalBalance": "credit",
    "postable": false
  },
  {
    "code": "31",
    "nameAr": "مصروفات",
    "parent": "3",
    "type": "expense",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "32",
    "nameAr": "صافي المشتريات",
    "parent": "3",
    "type": "expense",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "41",
    "nameAr": "صافي المبيعات",
    "parent": "4",
    "type": "revenue",
    "normalBalance": "credit",
    "postable": false
  },
  {
    "code": "42",
    "nameAr": "إيرادات اخرى",
    "parent": "4",
    "type": "revenue",
    "normalBalance": "credit",
    "postable": false
  },
  {
    "code": "111",
    "nameAr": "الأراضي",
    "parent": "11",
    "type": "asset",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "112",
    "nameAr": "المباني",
    "parent": "11",
    "type": "asset",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "113",
    "nameAr": "آلات و معدات",
    "parent": "11",
    "type": "asset",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "114",
    "nameAr": "وسائل نقل و انتقال",
    "parent": "11",
    "type": "asset",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "115",
    "nameAr": "عدد و أدوات",
    "parent": "11",
    "type": "asset",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "116",
    "nameAr": "أثاث و تجهيزات مكتبية",
    "parent": "11",
    "type": "asset",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "121",
    "nameAr": "الصناديق",
    "parent": "12",
    "type": "asset",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "122",
    "nameAr": "البنوك",
    "parent": "12",
    "type": "asset",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "123",
    "nameAr": "العملاء",
    "parent": "12",
    "type": "asset",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "124",
    "nameAr": "أوراق قبض",
    "parent": "12",
    "type": "asset",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "125",
    "nameAr": "مصروفات مدفوعة مقدما",
    "parent": "12",
    "type": "asset",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "126",
    "nameAr": "حسابات مدينة أخرى",
    "parent": "12",
    "type": "asset",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "127",
    "nameAr": "المخزون",
    "parent": "12",
    "type": "asset",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "128",
    "nameAr": "التطبيقات",
    "parent": "12",
    "type": "asset",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "211",
    "nameAr": "رأس المال",
    "parent": "21",
    "type": "equity",
    "normalBalance": "credit",
    "postable": false
  },
  {
    "code": "212",
    "nameAr": "الحسابات الجارية",
    "parent": "21",
    "type": "equity",
    "normalBalance": "credit",
    "postable": false
  },
  {
    "code": "213",
    "nameAr": "أرباح و خسائر السنوات السابقة",
    "parent": "21",
    "type": "equity",
    "normalBalance": "credit",
    "postable": false
  },
  {
    "code": "221",
    "nameAr": "ذمم دائنة",
    "parent": "22",
    "type": "liability",
    "normalBalance": "credit",
    "postable": false
  },
  {
    "code": "222",
    "nameAr": "ذمم دائنة اخرى",
    "parent": "22",
    "type": "liability",
    "normalBalance": "credit",
    "postable": false
  },
  {
    "code": "223",
    "nameAr": "أوراق مالية دائنة",
    "parent": "22",
    "type": "liability",
    "normalBalance": "credit",
    "postable": false
  },
  {
    "code": "224",
    "nameAr": "رواتب مستحقة",
    "parent": "22",
    "type": "liability",
    "normalBalance": "credit",
    "postable": false
  },
  {
    "code": "231",
    "nameAr": "مجمع الاهلاك",
    "parent": "23",
    "type": "liability",
    "normalBalance": "credit",
    "postable": false
  },
  {
    "code": "232",
    "nameAr": "الإحتياطيات",
    "parent": "23",
    "type": "liability",
    "normalBalance": "credit",
    "postable": false
  },
  {
    "code": "233",
    "nameAr": "المخصصات",
    "parent": "23",
    "type": "liability",
    "normalBalance": "credit",
    "postable": false
  },
  {
    "code": "311",
    "nameAr": "مصاريف إدارية",
    "parent": "31",
    "type": "expense",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "312",
    "nameAr": "مصاريف عمومية",
    "parent": "31",
    "type": "expense",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "313",
    "nameAr": "مصاريف الخدمات",
    "parent": "31",
    "type": "expense",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "314",
    "nameAr": "مصاريف مباشرة",
    "parent": "31",
    "type": "expense",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "1211",
    "nameAr": "صناديق الفرع الرئيسي",
    "parent": "121",
    "type": "asset",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "1221",
    "nameAr": "بنوك الفرع الرئيسي",
    "parent": "122",
    "type": "asset",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "1231",
    "nameAr": "عملاء الفرع الرئيسي",
    "parent": "123",
    "type": "asset",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "2211",
    "nameAr": "موردين",
    "parent": "221",
    "type": "liability",
    "normalBalance": "credit",
    "postable": false
  },
  {
    "code": "2212",
    "nameAr": "ملاك",
    "parent": "221",
    "type": "liability",
    "normalBalance": "credit",
    "postable": false
  },
  {
    "code": "2221",
    "nameAr": "تأمين مسترد",
    "parent": "222",
    "type": "liability",
    "normalBalance": "credit",
    "postable": false
  },
  {
    "code": "2241",
    "nameAr": "موظفين الفرع الرئيسي",
    "parent": "224",
    "type": "liability",
    "normalBalance": "credit",
    "postable": false
  },
  {
    "code": "3121",
    "nameAr": "مصاريف متنوعة",
    "parent": "312",
    "type": "expense",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "3122",
    "nameAr": "مصاريف الموظفين",
    "parent": "312",
    "type": "expense",
    "normalBalance": "debit",
    "postable": false
  },
  {
    "code": "22111",
    "nameAr": "موردين الفرع الرئيسي",
    "parent": "2211",
    "type": "liability",
    "normalBalance": "credit",
    "postable": false
  },
  {
    "code": "1110001",
    "nameAr": "أرض",
    "parent": "111",
    "type": "asset",
    "normalBalance": "debit"
  },
  {
    "code": "1120001",
    "nameAr": "مبنى",
    "parent": "112",
    "type": "asset",
    "normalBalance": "debit"
  },
  {
    "code": "1130001",
    "nameAr": "آلات و معدات",
    "parent": "113",
    "type": "asset",
    "normalBalance": "debit"
  },
  {
    "code": "1140001",
    "nameAr": "نقل",
    "parent": "114",
    "type": "asset",
    "normalBalance": "debit"
  },
  {
    "code": "1150001",
    "nameAr": "أدوات",
    "parent": "115",
    "type": "asset",
    "normalBalance": "debit"
  },
  {
    "code": "1160001",
    "nameAr": "أثاث",
    "parent": "116",
    "type": "asset",
    "normalBalance": "debit"
  },
  {
    "code": "1211001",
    "nameAr": "الصندوق الرئيسي",
    "parent": "1211",
    "type": "asset",
    "normalBalance": "debit"
  },
  {
    "code": "1211002",
    "nameAr": "عهدة الإغلاق",
    "parent": "1211",
    "type": "asset",
    "normalBalance": "debit"
  },
  {
    "code": "1221001",
    "nameAr": "شبكة",
    "parent": "1221",
    "type": "asset",
    "normalBalance": "debit"
  },
  {
    "code": "1221002",
    "nameAr": "فيزا",
    "parent": "1221",
    "type": "asset",
    "normalBalance": "debit"
  },
  {
    "code": "1240001",
    "nameAr": "أوراق قبض",
    "parent": "124",
    "type": "asset",
    "normalBalance": "debit"
  },
  {
    "code": "1250001",
    "nameAr": "مصروفات مدفوعة مقدما",
    "parent": "125",
    "type": "asset",
    "normalBalance": "debit"
  },
  {
    "code": "1260001",
    "nameAr": "حسابات مدينة أخرى",
    "parent": "126",
    "type": "asset",
    "normalBalance": "debit"
  },
  {
    "code": "1270001",
    "nameAr": "حساب بضاعة آخر المدة",
    "parent": "127",
    "type": "asset",
    "normalBalance": "debit"
  },
  {
    "code": "1270002",
    "nameAr": "بضاعة أول المدة",
    "parent": "127",
    "type": "asset",
    "normalBalance": "debit"
  },
  {
    "code": "2110001",
    "nameAr": "راس المال المدفوع",
    "parent": "211",
    "type": "equity",
    "normalBalance": "credit"
  },
  {
    "code": "2120001",
    "nameAr": "جاري المالك",
    "parent": "212",
    "type": "equity",
    "normalBalance": "credit"
  },
  {
    "code": "2130001",
    "nameAr": "أرباح و خسائر",
    "parent": "213",
    "type": "equity",
    "normalBalance": "credit",
    "postable": false
  },
  {
    "code": "2222001",
    "nameAr": "ضريبة القيمة المضافة",
    "parent": "222",
    "type": "liability",
    "normalBalance": "credit"
  },
  {
    "code": "2222002",
    "nameAr": "الضريبة الإنتقائية",
    "parent": "222",
    "type": "liability",
    "normalBalance": "credit"
  },
  {
    "code": "2230001",
    "nameAr": "أوراق دفع",
    "parent": "223",
    "type": "liability",
    "normalBalance": "credit"
  },
  {
    "code": "2310001",
    "nameAr": "مجمع  إهلاك مباني",
    "parent": "231",
    "type": "liability",
    "normalBalance": "credit"
  },
  {
    "code": "2310002",
    "nameAr": "مجمع  إهلاك آلات",
    "parent": "231",
    "type": "liability",
    "normalBalance": "credit"
  },
  {
    "code": "2310003",
    "nameAr": "مجمع إهلاك وسائل نقل",
    "parent": "231",
    "type": "liability",
    "normalBalance": "credit"
  },
  {
    "code": "2310004",
    "nameAr": "مجمع  إهلاك عدد و أدوات",
    "parent": "231",
    "type": "liability",
    "normalBalance": "credit"
  },
  {
    "code": "2310005",
    "nameAr": "مجمع  إهلاك أثاث و تجهيزات مكتبية",
    "parent": "231",
    "type": "liability",
    "normalBalance": "credit"
  },
  {
    "code": "2320001",
    "nameAr": "إحتياطي قانوني",
    "parent": "232",
    "type": "liability",
    "normalBalance": "credit"
  },
  {
    "code": "2330001",
    "nameAr": "مخصص ديون مشكوك في تحصيلها",
    "parent": "233",
    "type": "liability",
    "normalBalance": "credit"
  },
  {
    "code": "3110001",
    "nameAr": "مصاريف بنكية",
    "parent": "311",
    "type": "expense",
    "normalBalance": "debit"
  },
  {
    "code": "3110002",
    "nameAr": "مصروفات الضيافة",
    "parent": "311",
    "type": "expense",
    "normalBalance": "debit"
  },
  {
    "code": "3110003",
    "nameAr": "ديون معدومة",
    "parent": "311",
    "type": "expense",
    "normalBalance": "debit"
  },
  {
    "code": "3110004",
    "nameAr": "فروقات الصندوق",
    "parent": "311",
    "type": "expense",
    "normalBalance": "debit"
  },
  {
    "code": "3121001",
    "nameAr": "مصاريف اخرى",
    "parent": "3121",
    "type": "expense",
    "normalBalance": "debit"
  },
  {
    "code": "3121002",
    "nameAr": "مخالفات و غرامات",
    "parent": "3121",
    "type": "expense",
    "normalBalance": "debit"
  },
  {
    "code": "3121003",
    "nameAr": "مصاريف فرق العملة",
    "parent": "3121",
    "type": "expense",
    "normalBalance": "debit"
  },
  {
    "code": "3122001",
    "nameAr": "راتب أساسي",
    "parent": "3122",
    "type": "expense",
    "normalBalance": "debit"
  },
  {
    "code": "3122002",
    "nameAr": "حوافز",
    "parent": "3122",
    "type": "expense",
    "normalBalance": "debit"
  },
  {
    "code": "3122003",
    "nameAr": "بدل سكن",
    "parent": "3122",
    "type": "expense",
    "normalBalance": "debit"
  },
  {
    "code": "3122004",
    "nameAr": "بدل مواصلات",
    "parent": "3122",
    "type": "expense",
    "normalBalance": "debit"
  },
  {
    "code": "3122005",
    "nameAr": "بدل علاج",
    "parent": "3122",
    "type": "expense",
    "normalBalance": "debit"
  },
  {
    "code": "3122006",
    "nameAr": "بدلات أخرى",
    "parent": "3122",
    "type": "expense",
    "normalBalance": "debit"
  },
  {
    "code": "3130001",
    "nameAr": "مصروفات دعاية و إعلان و استقبال",
    "parent": "313",
    "type": "expense",
    "normalBalance": "debit"
  },
  {
    "code": "3130002",
    "nameAr": "فواتير كهرباء",
    "parent": "313",
    "type": "expense",
    "normalBalance": "debit"
  },
  {
    "code": "3130003",
    "nameAr": "فواتير هاتف",
    "parent": "313",
    "type": "expense",
    "normalBalance": "debit"
  },
  {
    "code": "3130004",
    "nameAr": "فواتير جوالات العمل",
    "parent": "313",
    "type": "expense",
    "normalBalance": "debit"
  },
  {
    "code": "3130005",
    "nameAr": "فواتير انترنت",
    "parent": "313",
    "type": "expense",
    "normalBalance": "debit"
  },
  {
    "code": "3130006",
    "nameAr": "نثريات عامه",
    "parent": "313",
    "type": "expense",
    "normalBalance": "debit"
  },
  {
    "code": "3140001",
    "nameAr": "مصاريف تنفيذ مشاريع",
    "parent": "314",
    "type": "expense",
    "normalBalance": "debit"
  },
  {
    "code": "3200001",
    "nameAr": "المشتريات",
    "parent": "32",
    "type": "expense",
    "normalBalance": "debit"
  },
  {
    "code": "3200002",
    "nameAr": "مردودات المشتريات",
    "parent": "32",
    "type": "expense",
    "normalBalance": "credit"
  },
  {
    "code": "3200003",
    "nameAr": "خصم مكتسب",
    "parent": "32",
    "type": "expense",
    "normalBalance": "credit"
  },
  {
    "code": "4100001",
    "nameAr": "المبيعات",
    "parent": "41",
    "type": "revenue",
    "normalBalance": "credit"
  },
  {
    "code": "4100002",
    "nameAr": "مردودات المبيعات",
    "parent": "41",
    "type": "revenue",
    "normalBalance": "debit"
  },
  {
    "code": "4100003",
    "nameAr": "خصم ممنوح",
    "parent": "41",
    "type": "revenue",
    "normalBalance": "debit"
  },
  {
    "code": "4200001",
    "nameAr": "ايرادات توصيل",
    "parent": "42",
    "type": "revenue",
    "normalBalance": "credit"
  },
  {
    "code": "4200002",
    "nameAr": "إيرادات الإضافات",
    "parent": "42",
    "type": "revenue",
    "normalBalance": "credit"
  },
  {
    "code": "4200003",
    "nameAr": "إيرادات عامة",
    "parent": "42",
    "type": "revenue",
    "normalBalance": "credit"
  },
  {
    "code": "12310001",
    "nameAr": "عميل عام",
    "parent": "1231",
    "type": "asset",
    "normalBalance": "debit"
  },
  {
    "code": "22111001",
    "nameAr": "مورد عام",
    "parent": "22111",
    "type": "liability",
    "normalBalance": "credit"
  },
  {
    "code": "22210001",
    "nameAr": "تأمين مسترد",
    "parent": "2221",
    "type": "liability",
    "normalBalance": "credit"
  },
  {
    "code": "22410001",
    "nameAr": "مدير",
    "parent": "2241",
    "type": "liability",
    "normalBalance": "credit"
  }
];
