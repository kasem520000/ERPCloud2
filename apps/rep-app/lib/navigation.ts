/**
 * M5 — the rep app's screen registry. Five primary tabs (the phone shell's bottom bar)
 * plus secondary screens reachable from home/queue. Permission gates mirror the M4 API
 * routes exactly: reads need `van_sales.view`, and each write screen needs the same code
 * the replay endpoint re-checks per row.
 */
export type NavScreen = {
  href: string;
  labelAr: string;
  labelEn: string;
  icon: 'home' | 'customers' | 'stock' | 'invoice' | 'queue' | 'receipt' | 'return' | 'closing' | 'sync';
  /** Undefined = visible to every session (the shell hides nothing without a session). */
  permission?: string;
  primary: boolean;
};

export const SCREENS: NavScreen[] = [
  { href: '/', labelAr: 'اليوم', labelEn: 'Today', icon: 'home', permission: 'van_sales.view', primary: true },
  { href: '/customers', labelAr: 'العملاء', labelEn: 'Customers', icon: 'customers', permission: 'van_sales.view', primary: true },
  { href: '/stock', labelAr: 'البضاعة', labelEn: 'Van stock', icon: 'stock', permission: 'van_sales.view', primary: true },
  { href: '/invoice', labelAr: 'بيعة', labelEn: 'Sell', icon: 'invoice', permission: 'van_sales.invoice.create', primary: true },
  { href: '/queue', labelAr: 'الطابور', labelEn: 'Queue', icon: 'queue', permission: 'van_sales.view', primary: true },
  { href: '/receipt', labelAr: 'تحصيل', labelEn: 'Collect', icon: 'receipt', permission: 'van_sales.collection.create', primary: false },
  { href: '/return', labelAr: 'مرتجع', labelEn: 'Return', icon: 'return', permission: 'van_sales.invoice.create', primary: false },
  { href: '/closing', labelAr: 'إغلاق الوردية', labelEn: 'Close route', icon: 'closing', permission: 'van_sales.closing.submit', primary: false },
  { href: '/sync', labelAr: 'المزامنة', labelEn: 'Sync', icon: 'sync', permission: 'van_sales.view', primary: false },
];

/** The bottom bar shows primaries only, filtered by what the session can do. */
export function visibleScreens(can: (permission: string) => boolean): NavScreen[] {
  return SCREENS.filter((screen) => !screen.permission || can(screen.permission));
}

export function primaryScreens(can: (permission: string) => boolean): NavScreen[] {
  return visibleScreens(can).filter((screen) => screen.primary);
}
