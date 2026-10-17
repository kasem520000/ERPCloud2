import { and, eq, inArray, sql } from 'drizzle-orm';
import { tenantSettings, type DrizzleTx } from '@erp/database';
import { tenantAuditActions } from '@erp/contracts';

import { AuditService } from '../../platform-services/audit/audit.service.js';

/**
 * M7 — فتح ما اشتراه العميل: الحزمة تُفتح حين يصبح الترخيص حيّاً.
 *
 * صفحة الأسعار تقول لكل باقةٍ ما تفتحه (`billing_plan_entitlements`)، لكن قبل M7 لم
 * يكن شيءٌ يفتحه فعلاً: المشغّل كان يقلب `feature.*` بيده بعد التفعيل. هذه الدالة
 * هي الحلقة الناقصة — تُستدعى من كل مسارٍ يصبح فيه ترخيصٌ حيّاً (إصدار يدوي،
 * موافقة على طلب تفعيل، تبديل باقة) وتفتح حزم الباقة على المستأجر:
 *
 *   * **تفتح ولا تغلق أبداً** — سطر `feature.* = true` وحده يُكتب. الباقة الأرخص
 *     لا تسحب حزمةً فتحها المشغّل يدوياً أو اشتراها العميل سابقاً؛ التخفيض قرارٌ
 *     يدويٌّ من لوحة المنصة كما كان.
 *   * **قيمةٌ كانت true تبقى كما هي** — لا صفٌّ يُكتب إذا كان المطلوب حاصلاً فعلاً،
 *     فيبقى `updated_at` و«القيمة الافتراضية» صادقين.
 *   * **لكل حزمةٍ تُفتح سجلّ تدقيق** بنفس فعل التقليب اليدوي (`tenant.flag`) —
 *     من فتحها ولماذا (الباقة) مكتوبان.
 */
export async function applyPlanFeaturePacks(
  tx: DrizzleTx,
  audit: AuditService,
  input: {
    tenantId: string;
    planId: string;
    planCode: string;
    actorUserId: string | null;
    actorLabel: string;
  },
): Promise<string[]> {
  const entitled = await tx.execute(sql`
    SELECT key
      FROM billing_plan_entitlements
     WHERE plan_id = ${input.planId}::uuid
       AND kind = 'module'
       AND key LIKE 'feature.%'
       AND value = 'true'::jsonb
  `);
  const keys = entitled.rows.map((row) => String(row.key));
  if (keys.length === 0) return [];

  const current = await tx
    .select({ key: tenantSettings.key, value: tenantSettings.value })
    .from(tenantSettings)
    .where(and(eq(tenantSettings.tenantId, input.tenantId), inArray(tenantSettings.key, keys)));
  const stored = new Map(current.map((row) => [row.key, row.value]));

  const opened: string[] = [];
  for (const key of keys) {
    const before = stored.get(key);
    if (before === true || before === 'true') continue;

    await tx.execute(sql`
      INSERT INTO tenant_settings (tenant_id, key, value, updated_at)
      VALUES (${input.tenantId}::uuid, ${key}, 'true'::jsonb, now())
      ON CONFLICT (tenant_id, key)
      DO UPDATE SET value = 'true'::jsonb, updated_at = now()
    `);
    opened.push(key);

    await audit.recordInTx(tx, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      actorLabel: input.actorLabel,
      action: tenantAuditActions.FLAG,
      entity: 'tenant_flag',
      entityId: `${input.tenantId}:${key}`,
      before: { enabled: false },
      after: { enabled: true },
      meta: { scope: 'platform_console', via: 'subscription', planCode: input.planCode },
    });
  }
  return opened;
}
