import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withOwnerClient } from '@erp/testing';
import { Decimal } from 'decimal.js';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';


/**
 * AUD-11 — استبدال سطور مسودّة فاتورة المبيعات كان غير ذري.
 *
 * ما كان: `updateDraft` يحذف السطور في معاملة، ثم يستدعي `create()` فينشئ فاتورة
 * **بمعرّف جديد** في معاملة ثانية. فشلُ الإنشاء (قيد، خطأ، انقطاع) يترك المسودّة الأصلية
 * بلا سطور — تلفٌ ظاهر — ونجاحه يبدّل المعرّف فيكسر المرفقات وسجلّ التدقيق والمراجع.
 *
 * تُثبت هذه المواصفة: (1) حقن فشلٍ بعد الحذف وقبل الإدراج يُبقي السطور الأصلية كما هي،
 * (2) الهوية والمجاميع تُحفظ بعد الاستبدال الناجح، (3) تعديلان متزامنان يتسلسلان ولا
 * يتركان سطوراً يتيمة أو مجاميع لا تطابق السطور، (4) فاتورة مرحَّلة لا تُقبل تعديلاً.
 */

describe('AUD-11 — استبدال سطور المسودّة ذرّي بهوية ثابتة', () => {
  let ctx: TestApp;
  let actor: Actor;
  let branchId = '';
  let warehouseId = '';
  let itemId = '';

  const post = (path: string, body: Record<string, unknown> = {}) =>
    api(ctx.server, 'post', `/api/v1${path}`, { token: actor.token, body });
  const patch = (path: string, body: Record<string, unknown> = {}) =>
    api(ctx.server, 'patch', `/api/v1${path}`, { token: actor.token, body });
  const get = (path: string) => api(ctx.server, 'get', `/api/v1${path}`, { token: actor.token });

  const line = (description: string, quantity: string, unitPrice: string) => ({
    itemId,
    description,
    quantity,
    unitPrice,
  });

  const createDraft = async (lines: ReturnType<typeof line>[], options: { warehouse?: boolean } = {}) => {
    const response = await post('/sales/invoices', {
      branchId,
      ...(options.warehouse ? { warehouseId } : {}),
      kind: 'sale',
      orderType: 'counter',
      cashCustomerName: 'عميل نقدي',
      lines,
    });
    expect(response.status).toBe(201);
    return (response.body.data ?? response.body) as { id: string; total: string; lines: Array<{ id: string; description: string }> };
  };

  const linesOf = (invoiceId: string) =>
    withOwnerClient(ctx.db.ownerUrl, async (client) => {
      const result = await client.query(
        `SELECT id, line_no, description, quantity, total FROM sales_invoice_lines
          WHERE invoice_id = $1 ORDER BY line_no`,
        [invoiceId],
      );
      return result.rows as Array<{ id: string; line_no: number; description: string; quantity: string; total: string }>;
    });

  beforeAll(async () => {
    ctx = await createTestApp('audit-sales-replace');
    actor = await createActor(ctx, {
      tenantCode: 'audit-sales-replace',
      email: 'owner@audit-sales-replace.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        ...ALL_ORGANIZATION_PERMISSIONS,
        'catalog.item.view',
        'catalog.item.manage',
        'catalog.category.manage',
        'catalog.unit.manage',
        'sales.view',
        'sales.invoice.create',
        'sales.invoice.post',
        'organization.warehouse.manage',
        'inventory.view',
        'inventory.adjust',
        'accounting.period.view',
        'accounting.period.close',
      ],
    });

    const branch = await post('/branches', { code: 'MAIN', nameAr: 'الفرع الرئيسي' });
    branchId = ((branch.body.data ?? branch.body) as { id: string }).id;

    const warehouse = await post('/warehouses', { branchId, code: 'MAIN-WH', name: 'المخزن الرئيسي' });
    expect(warehouse.status, JSON.stringify(warehouse.body)).toBe(201);
    warehouseId = ((warehouse.body.data ?? warehouse.body) as { id: string }).id;

    const category = await post('/organization/catalog/categories', { code: 'GEN', nameAr: 'عام' });
    const unit = await post('/organization/catalog/units', { code: 'PCS', nameAr: 'حبة' });
    const item = await post('/organization/catalog/items', {
      sku: 'SKU-AUD11',
      nameAr: 'صنف AUD-11',
      categoryId: ((category.body.data ?? category.body) as { id: string }).id,
      baseUnitId: ((unit.body.data ?? unit.body) as { id: string }).id,
      salePrice: '100.0000',
    });
    itemId = ((item.body.data ?? item.body) as { id: string }).id;

    // رصيد افتتاحي: الترحيل يحرّك المخزون، وبلاه يفشل بـ`STOCK_INSUFFICIENT` — وهذا
    // فحصٌ صحيح لا علاقة له بذرّية تعديل المسودّة التي نقيسها هنا.
    // ملفات الترحيل الافتراضية: ترحيل فاتورة البيع يطلب `sales_invoice`، والفترة المالية
    // المفتوحة للتاريخ الحالي — بوّابتان محاسبيتان قائمتان لا علاقة لهما بما نقيسه.
    await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(actor.tenantId);
    const year = new Date().getUTCFullYear();
    const fiscalYear = await post('/fiscal-years', {
      name: `FY${year}`,
      startDate: `${year}-01-01`,
      endDate: `${year + 1}-12-31`,
    });
    expect(fiscalYear.status).toBe(201);

    const opening = await post('/inventory/ledger/record', {
      lines: [
        { itemId, warehouseId, qty: '100', unitCost: '40', direction: 'in', docType: 'opening', docId: '00000000-0000-0000-0000-000000000011' },
      ],
    });
    expect([200, 201]).toContain(opening.status);
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('موجبة: الاستبدال يُحدّث السطور والمجاميع ويُبقي المعرّف نفسه', async () => {
    const draft = await createDraft([line('قديم ١', '2', '100.0000')]);
    expect(Number(draft.total)).toBe(200);

    const updated = await patch(`/sales/invoices/${draft.id}`, {
      lines: [line('جديد ١', '3', '100.0000'), line('جديد ٢', '1', '50.0000')],
    });
    expect(updated.status).toBe(200);
    const body = (updated.body.data ?? updated.body) as { id: string; total: string; lines: Array<{ description: string }> };
    expect(body.id, 'the draft keeps its identity — links and audit stay valid').toBe(draft.id);
    expect(body.lines.map((row) => row.description)).toEqual(['جديد ١', 'جديد ٢']);
    expect(Number(body.total)).toBe(350);

    const stored = await linesOf(draft.id);
    expect(stored.filter((row) => row.description === 'قديم ١')).toHaveLength(0);
    expect(stored).toHaveLength(2);
  });

  it('حقن فشلٍ بين الحذف والإدراج: السطور الأصلية تبقى — لا مسودّة بلا سطور', async () => {
    const draft = await createDraft([line('أصلي ١', '5', '100.0000')]);
    const before = await linesOf(draft.id);
    expect(before).toHaveLength(1);

    // الفشل يُحقن في طبقة القاعدة نفسها: أي إدراج لسطرٍ جديد لهذه الفاتورة يفشل.
    await withOwnerClient(ctx.db.ownerUrl, async (client) => {
      await client.query(`
        CREATE OR REPLACE FUNCTION audit11_block_line_insert() RETURNS trigger AS $$
        BEGIN
          IF NEW.invoice_id = '${draft.id}'::uuid THEN
            RAISE EXCEPTION 'audit11 injected failure';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql;
      `);
      await client.query(`
        CREATE TRIGGER audit11_block_line_insert_trigger
        BEFORE INSERT ON sales_invoice_lines
        FOR EACH ROW EXECUTE FUNCTION audit11_block_line_insert();
      `);
    });

    try {
      const failed = await patch(`/sales/invoices/${draft.id}`, { lines: [line('بديل', '1', '100.0000')] });
      expect(failed.status).toBeGreaterThanOrEqual(500);

      const after = await linesOf(draft.id);
      expect(after, 'the delete must roll back with the failed insert').toHaveLength(1);
      expect(after[0]!.description).toBe('أصلي ١');

      const header = await get(`/sales/invoices/${draft.id}`);
      expect(Number(((header.body.data ?? header.body) as { total: string }).total)).toBe(500);
    } finally {
      await withOwnerClient(ctx.db.ownerUrl, async (client) => {
        await client.query(`DROP TRIGGER IF EXISTS audit11_block_line_insert_trigger ON sales_invoice_lines`);
        await client.query(`DROP FUNCTION IF EXISTS audit11_block_line_insert()`);
      });
    }
  });

  it('تعديلان متزامنان: يتسلسلان فلا سطور يتيمة ولا مجاميع لا تطابقها', async () => {
    const draft = await createDraft([line('بداية', '1', '100.0000')]);

    const [a, b] = await Promise.all([
      patch(`/sales/invoices/${draft.id}`, { lines: [line('متزامن أ', '2', '100.0000')] }),
      patch(`/sales/invoices/${draft.id}`, { lines: [line('متزامن ب', '3', '100.0000')] }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);

    const stored = await linesOf(draft.id);
    expect(stored, 'exactly one replacement wins; no orphan row survives').toHaveLength(1);
    const winner = stored[0]!;

    const header = await get(`/sales/invoices/${draft.id}`);
    const headerTotal = ((header.body.data ?? header.body) as { total: string }).total;
    // المجموع في الرأس يطابق السطر الفائز — لا رأسٌ يحمل مجموع الخاسر.
    expect(new Decimal(headerTotal).toFixed(4)).toBe(new Decimal(winner.quantity).times('100').toFixed(4));
  });

  it('فاتورة غير مسودّة: 409 ولا تُمسّ السطور', async () => {
    const draft = await createDraft([line('للترحيل', '1', '100.0000')], { warehouse: true });
    const periods = ((await get('/fiscal-periods')).body.data ?? []) as Array<Record<string, unknown>>;
    const month = new Date().toISOString().slice(0, 7);
    const openPeriod = periods.find((row) => row.status === 'open' && String(row.startDate ?? '').startsWith(month));
    expect(openPeriod?.id).toBeTruthy();

    const posted = await post(`/sales/invoices/${draft.id}/post`, { warehouseId, fiscalPeriodId: openPeriod!.id });
    expect([200, 201], JSON.stringify(posted.body)).toContain(posted.status);

    const rejected = await patch(`/sales/invoices/${draft.id}`, { lines: [line('ممنوع', '9', '100.0000')] });
    expect(rejected.status).toBe(409);
    const stored = await linesOf(draft.id);
    expect(stored.map((row) => row.description)).toEqual(['للترحيل']);
  });

  it('تعديل الرأس وحده لا يلمس السطور', async () => {
    const draft = await createDraft([line('ثابت', '1', '100.0000')]);
    const patched = await patch(`/sales/invoices/${draft.id}`, { cashCustomerName: 'عميل مُسمّى' });
    expect(patched.status).toBe(200);
    expect(((patched.body.data ?? patched.body) as { cashCustomerName: string }).cashCustomerName).toBe('عميل مُسمّى');
    const stored = await linesOf(draft.id);
    expect(stored.map((row) => row.description)).toEqual(['ثابت']);
  });
});
