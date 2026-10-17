import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTenantFixture } from './fixtures.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * 🔁 ترحيل `0133` — باقات الحزم العمودية الأربع (M7).
 *
 * ترحيل بياناتٍ لا مخطط: يزرع أربع باقاتٍ وحقوقها ولا يعدّل جدولاً قائماً. يُختبر
 * على قاعدة اختبار معزولة:
 *   1. الزرع مطبَّق من الحاضرة: أربع باقاتٍ نشطة، لكلٍّ منها راية حزمتها وحدّ
 *      مستخدميها، وإعادة تطبيق الترحيل لا تغيّر شيئاً؛
 *   2. ما يعدّله المشغّل باقٍٍ على ما هو عليه: الزرع `DO NOTHING` فلا يطغى على
 *      سعرٍ غيّرته اليدُ البشرية؛
 *   3. ملف التراجع يحذف الباقات الأربع وحقوقها — ثم يعود الترحيل فيزرعها من جديد؛
 *      والحذف يفشل بصوتٍ مسموع إن كان على الباقة ترخيصٌ حيّ (قيد المفتاح الأجنبي)؛
 *   4. `0132`…`0133` مطابقة لبصمتها المسجَّلة — لم يُعدَّل ترحيلٌ تاريخي.
 */
const MIGRATIONS = fileURLToPath(new URL('../../../packages/database/migrations', import.meta.url));
const UP_NAME = '0133_vertical_pack_plans.sql';
const DOWN_NAME = 'down/0133_vertical_pack_plans.down.sql';
const PREVIOUS_NAMES = ['0132_bank_line_posting.sql'];
const PACK_CODES = ['pack_wholesale', 'pack_manufacturing', 'pack_food_factory', 'pack_van_sales'] as const;

const readSql = (relative: string): Promise<string> => fs.readFile(`${MIGRATIONS}/${relative}`, 'utf8');
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('migration 0133 — vertical pack plans', () => {
  let ctx: TestApp;
  let pool: Pool;

  const plans = async (): Promise<Map<string, { active: boolean; amount: string }>> => {
    const result = await pool.query(
      `SELECT code, active, amount::text FROM billing_plans WHERE code = ANY($1::text[])`,
      [[...PACK_CODES]],
    );
    return new Map(
      (result.rows as Array<{ code: string; active: boolean; amount: string }>).map((row) => [
        row.code,
        { active: row.active, amount: row.amount },
      ]),
    );
  };

  const entitlementCount = async (): Promise<number> => {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM billing_plan_entitlements e
        JOIN billing_plans p ON p.id = e.plan_id
       WHERE p.code = ANY($1::text[])`,
      [[...PACK_CODES]],
    );
    return (result.rows[0] as { cnt: number }).cnt;
  };

  beforeAll(async () => {
    ctx = await createTestApp('migration_0133');
    pool = new Pool({ connectionString: ctx.db.ownerUrl, max: 1 });
    // مستأجرٌ واحد يجلس عليه الترخيص الذي يُثبت أن الحذف صادق.
    await createTenantFixture(ctx.db.ownerUrl, { code: 'mig-0133', name: 'ترحيل الحزم', status: 'active' });
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await ctx?.close();
  });

  it('is applied by the harness and changes nothing when re-applied', async () => {
    const seeded = await plans();
    expect(seeded.size).toBe(4);
    expect([...seeded.values()].every((plan) => plan.active)).toBe(true);
    expect(seeded.get('pack_van_sales')?.amount).toBe('129.0000');
    expect(seeded.get('pack_food_factory')?.amount).toBe('199.0000');
    // لكل باقةٍ سطران: راية الحزمة وحدّ المستخدمين.
    expect(await entitlementCount()).toBe(8);

    await pool.query(await readSql(UP_NAME));
    expect((await plans()).size).toBe(4);
    expect(await entitlementCount()).toBe(8);
  });

  it('never overrides what the operator edited (ON CONFLICT DO NOTHING)', async () => {
    await pool.query(`UPDATE billing_plans SET amount = 179.0000 WHERE code = 'pack_van_sales'`);
    await pool.query(await readSql(UP_NAME));
    expect((await plans()).get('pack_van_sales')?.amount).toBe('179.0000');
  });

  it('rolls back to an empty catalogue and re-seeds on re-apply', async () => {
    await pool.query(await readSql(DOWN_NAME));
    expect((await plans()).size).toBe(0);
    expect(await entitlementCount()).toBe(0);

    // والحذف صادق: باقةٌ عليها ترخيصٌ لا تُحذف بصمت — القيد الأجنبي يرفض.
    await pool.query(await readSql(UP_NAME));
    expect((await plans()).size).toBe(4);
    const planId = (await pool.query(`SELECT id FROM billing_plans WHERE code = 'pack_wholesale'`)).rows[0] as {
      id: string;
    };
    const tenantId = (await pool.query(`SELECT id FROM tenants LIMIT 1`)).rows[0] as { id: string };
    await pool.query(
      `INSERT INTO tenant_subscriptions (id, tenant_id, plan_id, status) VALUES (gen_random_uuid(), $1, $2, 'active')`,
      [tenantId.id, planId.id],
    );
    await expect(pool.query(await readSql(DOWN_NAME))).rejects.toThrow(/foreign key/i);
    await pool.query(
      `DELETE FROM tenant_subscriptions WHERE plan_id = $1 AND tenant_id = $2`,
      [planId.id, tenantId.id],
    );
  });

  it('keeps the recorded checksums of historical migrations', async () => {
    const result = await pool.query(
      `SELECT name, checksum FROM erp_migrations WHERE name LIKE '012%' OR name LIKE '013%' ORDER BY name`,
    );
    const recorded = new Map(
      (result.rows as Array<{ name: string; checksum: string }>).map((row) => [row.name, row.checksum]),
    );
    for (const name of [...PREVIOUS_NAMES, UP_NAME]) {
      const onDisk = await readSql(name);
      expect(recorded.get(name), `${name} must be recorded as applied`).toBeTruthy();
      expect(recorded.get(name), `${name} must not have been edited`).toBe(sha256(onDisk));
    }
  });
});
