/**
 * M3 — the accounting app's screen registry: the surfaces the shell offers, each with
 * the API permission that guards its endpoints. The shell hides a screen the session
 * cannot view (`useSession().can`), mirroring how the staff panel treats permissions.
 *
 * Read-only by design in this milestone: the pages only call the GET endpoints listed
 * beside each screen.
 */

export type NavScreen = {
  href: string;
  labelAr: string;
  labelEn: string;
  /** `RequiresPermission` code the screen's GET endpoints demand. */
  permission: string;
  icon: 'home' | 'accounts' | 'journals' | 'periods' | 'trial' | 'income' | 'cost' | 'zatca';
};

export const SCREENS: readonly NavScreen[] = [
  { href: '/', labelAr: 'الرئيسية', labelEn: 'Home', permission: 'tenant.view', icon: 'home' },
  { href: '/accounts', labelAr: 'دليل الحسابات', labelEn: 'Chart of accounts', permission: 'accounting.account.view', icon: 'accounts' },
  { href: '/journals', labelAr: 'القيود اليومية', labelEn: 'Journal register', permission: 'accounting.reports.view', icon: 'journals' },
  { href: '/periods', labelAr: 'الفترات المالية', labelEn: 'Fiscal periods', permission: 'accounting.period.view', icon: 'periods' },
  { href: '/trial-balance', labelAr: 'ميزان المراجعة', labelEn: 'Trial balance', permission: 'accounting.reports.view', icon: 'trial' },
  { href: '/income-statement', labelAr: 'قائمة الدخل', labelEn: 'Income statement', permission: 'accounting.reports.view', icon: 'income' },
  { href: '/cost-centers', labelAr: 'مراكز التكلفة', labelEn: 'Cost centres', permission: 'accounting.account.view', icon: 'cost' },
  { href: '/zatca', labelAr: 'مكتب الزكاة والضريبة', labelEn: 'ZATCA desk', permission: 'einvoice.view', icon: 'zatca' },
];

export function visibleScreens(can: (permission?: string) => boolean): NavScreen[] {
  return SCREENS.filter((screen) => can(screen.permission));
}
