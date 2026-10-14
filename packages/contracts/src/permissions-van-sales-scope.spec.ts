import { describe, expect, it } from 'vitest';

import {
  VAN_SALES_CODES_IMPLIED_BY_SALES_INVOICE,
  VAN_SALES_CODES_NEVER_IMPLIED_BY_SALES,
  permissionGrants,
  permissionRegistry,
} from './index.js';

/**
 * 🚐 نطاق الاستنتاج بين المبيعات والتوزيع (§5).
 *
 * القاعدة القديمة كانت تمنح كل كود `van_sales.*` — ومنها اعتماد إغلاق العهدة وتجاوز الأسعار
 * المثبّتة وسقوف البونص — لكل دور يملك `sales.invoice.create` ولا يملك كود توزيع صريحاً.
 * أي أن كاتب فواتير يصير معتمِداً للتسويات بلا قرار من المدير وبلا صفّ يُرى في شاشة الأدوار.
 *
 * الحدّ الجديد: القراءة تُستنتَج، والتشغيل (إصدار/تحصيل/تقديم إغلاق) يُستنتَج حتى لا يتوقّف
 * يوم العمل، والاعتماد والإدارة لا تُستنتَج أبداً — تُمنح صراحةً فتظهر وتُرى وتُسحب.
 */
describe('van-sales permission scope', () => {
  const clerk: readonly string[] = ['tenant.view', 'sales.view', 'sales.invoice.create'];
  const everyVanSalesCode = permissionRegistry
    .filter((entry) => entry.code.startsWith('van_sales.'))
    .map((entry) => entry.code);

  it('splits the distribution registry into implied and never-implied, with no overlap', () => {
    expect(everyVanSalesCode.length).toBeGreaterThanOrEqual(9);
    const split = [
      ...VAN_SALES_CODES_IMPLIED_BY_SALES_INVOICE,
      ...VAN_SALES_CODES_NEVER_IMPLIED_BY_SALES,
    ];
    // Reading is the one code handled by its own rule (`sales.view` ⇒ `van_sales.view`).
    expect([...split, 'van_sales.view'].sort()).toEqual([...everyVanSalesCode].sort());
    expect(new Set(split).size).toBe(split.length);
    for (const code of VAN_SALES_CODES_NEVER_IMPLIED_BY_SALES) {
      expect(VAN_SALES_CODES_IMPLIED_BY_SALES_INVOICE).not.toContain(code);
      expect(everyVanSalesCode).toContain(code);
    }
  });

  it('keeps reading open to a sales permission', () => {
    expect(permissionGrants(clerk, 'van_sales.view')).toBe(true);
    expect(permissionGrants(['sales.view'], 'van_sales.view')).toBe(true);
  });

  it('keeps the clerk operational: issue, collect, submit his own closing', () => {
    expect(VAN_SALES_CODES_IMPLIED_BY_SALES_INVOICE).toEqual([
      'van_sales.invoice.create',
      'van_sales.collection.create',
      'van_sales.closing.submit',
    ]);
    for (const code of VAN_SALES_CODES_IMPLIED_BY_SALES_INVOICE) {
      expect(permissionGrants(clerk, code), `${code} must stay implied for an invoice clerk`).toBe(true);
    }
  });

  it('never lets a sales permission approve, override, load, price or produce', () => {
    expect(VAN_SALES_CODES_NEVER_IMPLIED_BY_SALES).toEqual([
      'van_sales.production.manage',
      'van_sales.pricing.manage',
      'van_sales.load.manage',
      'van_sales.closing.approve',
      'van_sales.override.approve',
    ]);
    for (const code of VAN_SALES_CODES_NEVER_IMPLIED_BY_SALES) {
      expect(permissionGrants(clerk, code), `${code} must require an explicit grant`).toBe(false);
      expect(permissionGrants(['sales.view'], code), code).toBe(false);
      expect(permissionGrants(['sales.invoice.create'], code), code).toBe(false);
      expect(permissionGrants([...clerk, 'sales.invoice.post', 'sales.return.create'], code), code).toBe(
        false,
      );
    }
  });

  it('still honours an explicit grant and the owner wildcard', () => {
    expect(permissionGrants([...clerk, 'van_sales.closing.approve'], 'van_sales.closing.approve')).toBe(
      true,
    );
    expect(permissionGrants(['*'], 'van_sales.closing.approve')).toBe(true);
    expect(permissionGrants(['*'], 'van_sales.override.approve')).toBe(true);
  });

  it('lets an explicit distribution setup win over the sales inference', () => {
    // A role configured for production only is *not* silently an invoicing role as well: the
    // inference applies solely while the tenant has no explicit `van_sales.*` configuration.
    const productionOnly = [...clerk, 'van_sales.production.manage'];
    expect(permissionGrants(productionOnly, 'van_sales.production.manage')).toBe(true);
    expect(permissionGrants(productionOnly, 'van_sales.invoice.create')).toBe(false);
    expect(permissionGrants(productionOnly, 'van_sales.closing.approve')).toBe(false);
    // Reading stays open — it is implied by `sales.view`, not by the invoice rule.
    expect(permissionGrants(productionOnly, 'van_sales.view')).toBe(true);
  });

  it('never reaches a console code, and never invents one from a tenant grant', () => {
    expect(permissionGrants(clerk, 'console.tenants.manage')).toBe(false);
    expect(permissionGrants([...clerk, 'van_sales.override.approve'], 'console.tenants.manage')).toBe(
      false,
    );
  });
});
