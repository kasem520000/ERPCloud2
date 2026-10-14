import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  buildPlatformEntitlementKeys,
  findPlatformSettingDefinition,
  platformAnnualAmount,
  platformFormatAmount,
  platformMonthlyAmount,
  platformParseAmount,
  publicPlanSchema,
  type PublicPlan,
  type PublicPlanEntitlement,
} from '@erp/contracts';
import { tenantSettingsRegistry } from '@erp/config';
import { withPlatformAdminTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.tokens.js';

/**
 * P-M3 — «الباقات والأسعار»: مصدر صفحة `/pricing` العامة
 * (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * **لماذا خدمةٌ ثانية تقرأ نفس الجدول؟** لأن القارئ الثاني مختلف تماماً. `PlatformBillingService`
 * يقرأ للوحة المنصة: يجلس خلف `console.billing.*`، ويكتب تدقيقاً، ويرى كل باقة — النشطة
 * والموقوفة — مع `stripePriceId` وعدّاد التراخيص. وهذا القارئ للعالم: بلا جلسة، والنشطة وحدها،
 * وبلا معرّف مزوّد الدفع. لو استُعمل المسار الإداري هنا لَاحتاج الزائر رمز منصة، أو لَظهر في
 * الردّ ما لا يجوز أن يظهر؛ ولو نُسخ الاستعلام في الاثنين لَتفرّق Definitionُ «باقةٍ معروضة».
 *
 * وثلاث تفاصيل تنفيذية مقصودة:
 *
 *   1. **الحقوق تُقرأ مع الباقة في استعلامٍ واحد** (`jsonb_agg` مضمَّن): باقةٌ بلا حقوقها نصف
 *      جواب، ونداءان لجدولين متجاورين يجعلان صفحة الأسعار تفترق في منتصفها إن تأخّر أحدهما.
 *   2. **التسميات من فهرس المنتج** (`buildPlatformEntitlementKeys`) لا من صفّ الحقّ وحده: مفتاحٌ
 *      عُرف في السجلّ يحمل اسمه العربي والإنجليزي، ومفتاحٌ خرج من المنتج يبقى بمعرّفه بدل أن
 *      يُسقط الصفحة — قاعدةٌ نفسها في `PlatformBillingService.planView`.
 *   3. **الترتيب هنا لا في الواجهة**: الأرخص أولاً، والشهري قبل السنوي عند التساوي بالسعر —
 *      ترتيبٌ يقيسه `public-plans.spec.ts` ولا يعتمد على مزاج قاعدة البيانات.
 */
@Injectable()
export class PublicPlansService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  /**
   * `GET /public/plans` — الباقات النشطة، الأرخص أولاً، بحقوقها بلغتين، ومعها نسبة الضريبة.
   *
   * **ولماذا الضريبة مع الباقات؟** لأن صفحة الأسعار لا يجوز أن تعرض سعراً صامتاً عن الضريبة:
   * ملاحظة «الأسعار لا تشمل ضريبة القيمة المضافة» رقمُها من إعدادات المنصّة
   * (`billing.tax_rate`، افتراضه 15٪) لا من نصٍّ مكتوب في الموقع — فإن غيّر المشغّل النسبة
   * تغيّرت الصفحة، وإن كانت الجملة مكتوبة في الكود لكذبت.
   */
  async publicPricing(): Promise<{ plans: PublicPlan[]; vatRatePercent: number }> {
    const [plans, vatRatePercent] = await Promise.all([this.listActive(), this.vatRatePercent()]);
    return { plans, vatRatePercent };
  }

  /** الباقات النشطة وحدها — بلا مرشّحٍ في الواجهة يمكن نسيانه. */
  async listActive(): Promise<PublicPlan[]> {
    const rows = await this.database.db
      .execute(sql`
        SELECT p.id, p.code, p.name, p.interval, p.amount::text, p.currency,
               COALESCE((
                 SELECT jsonb_agg(jsonb_build_object('kind', e.kind, 'key', e.key, 'value', e.value) ORDER BY e.key)
                   FROM billing_plan_entitlements e
                  WHERE e.plan_id = p.id
               ), '[]'::jsonb) AS entitlements
          FROM billing_plans p
         WHERE p.active = true
         ORDER BY p.code ASC
      `)
      .then((result) => result.rows as Array<Record<string, unknown>>);

    // الترتيب بالمكافئ الشهري **في الكود** لا في SQL: `interval` نصٌّ (`'month' > 'year'`)،
    // والاعتماد على مقارنة نصوص في ترتيبٍ يقيسه الزائر مصادفةٌ لا قرار؛ وهذا الترتيب صريحٌ
    // وقابل للقياس (والسعر الأرخص أولاً هو ما يتوقّعه من يفتح صفحة الأسعار).
    return rows
      .map((row) => this.planView(row))
      .sort((a, b) => {
        const left = platformParseAmount(a.monthlyAmount);
        const right = platformParseAmount(b.monthlyAmount);
        if (left !== right) return left < right ? -1 : 1;
        if (a.interval !== b.interval) return a.interval === 'month' ? -1 : 1;
        return a.code.localeCompare(b.code);
      });
  }

  /** صفٌّ واحد → باقةٌ معروضة، مُتحقَّقٌ منها بالعقد قبل أن تُرسل (فلا يخرج شكلٌ لا يفهمه الموقع). */
  private planView(row: Record<string, unknown>): PublicPlan {
    const keys = new Map(this.entitlementKeys().map((entry) => [entry.key, entry]));
    const raw = (row.entitlements as Array<{ kind: string; key: string; value: unknown }> | null) ?? [];
    const entitlements: PublicPlanEntitlement[] = raw
      .map((entry) => {
        const definition = keys.get(entry.key);
        return {
          kind: (definition?.kind ?? entry.kind) as PublicPlanEntitlement['kind'],
          key: entry.key,
          value: entry.value as PublicPlanEntitlement['value'],
          // مفتاحٌ خرج من المنتج يُقرأ بمعرّفه: باقةٌ كُتبت أمس لا تُسقط صفحة اليوم.
          labelAr: definition?.labelAr ?? entry.key,
          labelEn: definition?.labelEn ?? entry.key,
        };
      })
      .sort((a, b) => a.key.localeCompare(b.key));

    const interval = String(row.interval) === 'year' ? ('year' as const) : ('month' as const);
    // `numeric` يصل من السائق نصّاً وقد يحمل أصفاراً زائدة (`199.0000`) — والعرض يريد `199.00`،
    // فيُمرَّر على مقياس المال المُعلَن في العقود بدل قصٍّ محلّي.
    // (الاسم `amountText` لا `amount`: قاعدة `MONEY_IDENTIFIER` في eslint تمنع معرّفاً باسم
    // مالٍ يحمل `number` — وهنا القيمة نصٌّ من مقياس العقود، فالتسمية صريحة لا مُلتبسة.)
    const amountText = platformFormatAmount(platformParseAmount(String(row.amount)));

    return publicPlanSchema.parse({
      id: String(row.id),
      code: String(row.code),
      name: String(row.name),
      interval,
      amount: amountText,
      currency: String(row.currency).trim(),
      monthlyAmount: platformMonthlyAmount(amountText, interval),
      annualAmount: interval === 'year' ? amountText : platformAnnualAmount(amountText),
      entitlements,
    });
  }

  /**
   * نسبة الضريبة من صفّ المنصة (`tenant_id IS NULL`). وقراءته تحتاج سياق مشغّل المنصة لأن
   * سياسة `platform_settings` تفتح صفوف المنصة له وحده — والقراءة هنا **قراءةٌ لا كتابة**،
   * بلا تدقيقٍ وبلا مفتاح، وتُترك للافتراضي المُعلَن في السجلّ إن لم يكن للصف وجود.
   */
  private async vatRatePercent(): Promise<number> {
    const row = await withPlatformAdminTx(this.database.db, (tx) =>
      tx.execute(sql`
        SELECT value::text AS raw FROM platform_settings
         WHERE key = 'billing.tax_rate' AND tenant_id IS NULL
         LIMIT 1
      `),
    );
    const raw = (row.rows[0] as { raw?: string } | undefined)?.raw;
    const stored = raw === undefined ? undefined : (JSON.parse(raw) as unknown);
    const definition = findPlatformSettingDefinition('billing.tax_rate');
    // (نسبةٌ لا مبلغ: الاسم `taxPercent` لا `rate` — قاعدة `MONEY_IDENTIFIER` تقرأ `rate` مالاً.)
    const taxPercent = Number(stored ?? definition?.defaultValue ?? 15);
    return Number.isFinite(taxPercent) ? taxPercent : 15;
  }

  private entitlementKeys() {
    return buildPlatformEntitlementKeys(
      tenantSettingsRegistry.map((definition) => ({
        key: definition.key,
        description: definition.description,
        defaultValue: definition.defaultValue,
      })),
    );
  }
}
