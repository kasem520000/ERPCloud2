import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { isEmployeeSurface, isPublicSurface, matchesPrefix } from '../lib/surface-routing.js';

/**
 * AUD-13 — حدود المسار في AuthGate.
 *
 * كان `startsWith('/m')` يطابق `/marina` و`/migration` و`/manufacturing` فتغلّفها قشرة
 * الموظف، و`startsWith('/esign')` يفتح `/esign-evil` بلا جلسة. والحدّ الصحيح: المسار
 * يساوي البادئة أو يتبعها `/`.
 */
describe('AUD-13 — حدود مسار القشرة', () => {
  it('تطبيق الموظف: /m و/m/… فقط', () => {
    expect(isEmployeeSurface('/m')).toBe(true);
    expect(isEmployeeSurface('/m/')).toBe(true);
    expect(isEmployeeSurface('/m/attendance')).toBe(true);
    expect(isEmployeeSurface('/m/requests/new')).toBe(true);

    for (const pathname of ['/marina', '/marina/additions', '/migration', '/manufacturing', '/maintenance']) {
      expect(isEmployeeSurface(pathname), pathname).toBe(false);
    }
  });

  it('الأسطح العامة: /esign و/supplier-portal بحدّ مقطع', () => {
    expect(isPublicSurface('/esign')).toBe(true);
    expect(isPublicSurface('/esign/document-1')).toBe(true);
    expect(isPublicSurface('/esign-evil')).toBe(false);
    expect(isPublicSurface('/supplier-portal')).toBe(true);
    expect(isPublicSurface('/supplier-portal/invoices')).toBe(true);
    expect(isPublicSurface('/supplier-portal-evil')).toBe(false);
    expect(isPublicSurface('/')).toBe(false);
  });

  it('المطابقة لا تعتمد على بادئة خام', () => {
    expect(matchesPrefix('/m', '/m')).toBe(true);
    expect(matchesPrefix('/m/x', '/m')).toBe(true);
    expect(matchesPrefix('/mx', '/m')).toBe(false);
    expect(matchesPrefix('/esign', '/esign')).toBe(true);
    expect(matchesPrefix('/esigning', '/esign')).toBe(false);
  });

  it('AuthGate نفسه لا يعود إلى startsWith الخام', async () => {
    const gate = await readFile(new URL('../components/auth-gate.tsx', import.meta.url), 'utf8');
    expect(gate).not.toMatch(/startsWith\('\/m'\)/);
    expect(gate).not.toMatch(/startsWith\('\/esign'\)/);
    expect(gate).not.toMatch(/startsWith\('\/supplier-portal'\)/);
    expect(gate).toContain('isEmployeeSurface');
  });

  it('قشرة الموظف تعرض لافتة الدخول المؤقّت مثل قشرة الإدارة', async () => {
    const shell = await readFile(new URL('../components/employee-shell.tsx', import.meta.url), 'utf8');
    expect(shell).toContain('ImpersonationBanner');
  });
});
