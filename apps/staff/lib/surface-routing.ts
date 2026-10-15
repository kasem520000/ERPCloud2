/**
 * AUD-13 — تصنيف المسار حسب حدّ المقطع لا البادئة الخام.
 *
 * كان `AuthGate` يستعمل `startsWith('/m')` و`startsWith('/esign')`، فتطابق `/marina` و
 * `/migration` و`/manufacturing` قشرةَ الموظف، و`/esign-evil` يمرّ إلى الصفحة العامة.
 * القاعدة نفسها انتقلت إلى `@erp/web-core/surface-routing` (M2) لأن كل الواجهات
 * تحتاجها؛ قوائم مسارات هذا التطبيق تبقى هنا.
 */

import { matchesPrefix } from '@erp/web-core/surface-routing';

export { matchesPrefix };

/** مساراتٌ تصادق نفسها (بوابة المورد وصفحة التوقيع العامة) فلا تمرّ على AuthGate. */
const PUBLIC_PREFIXES = ['/supplier-portal', '/esign'] as const;

/** مسارات تطبيق الموظف (`/m`, `/m/…`) — قشرة مختلفة عن لوحة الإدارة. */
const EMPLOYEE_PREFIX = '/m';

export function isPublicSurface(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix));
}

export function isEmployeeSurface(pathname: string): boolean {
  return matchesPrefix(pathname, EMPLOYEE_PREFIX);
}
