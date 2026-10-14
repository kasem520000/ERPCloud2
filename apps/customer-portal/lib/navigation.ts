export type PortalRoute = { key: string; href: string; labelAr: string; labelEn: string };

/**
 * What a customer of the tenant can actually do here.
 *
 * Every route below is backed by a `/portal/*` endpoint that resolves the caller's own party
 * from their token. Screens that used to sit here — quick sale, stock lookup, task inbox,
 * notifications — were mock-ups for capabilities the API does not expose to buyers, so they
 * are gone rather than left as furniture.
 *
 * Split from the shared `apps/marketing/lib/navigation.ts` during the 2026-09 surface
 * separation: this app deliberately advertises NO public route — marketing pages
 * (home/pricing/contact/verify) live on the marketing surface only.
 */
export const portalRoutes: PortalRoute[] = [
  { key: 'portal', href: '/portal', labelAr: 'لوحة الحساب', labelEn: 'Dashboard' },
  { key: 'invoices', href: '/portal/invoices', labelAr: 'فواتيري', labelEn: 'Invoices' },
  { key: 'statement', href: '/portal/statement', labelAr: 'كشف الحساب', labelEn: 'Statement' },
  { key: 'payments', href: '/portal/payments', labelAr: 'المدفوعات', labelEn: 'Payments' },
  { key: 'profile', href: '/portal/profile', labelAr: 'بياناتي', labelEn: 'My details' },
];
