import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  SITE_ANALYTICS_COLLECTED,
  SITE_ANALYTICS_NEVER,
  SITE_ANALYTICS_PRIVACY_NOTE_AR,
  SITE_EVENTS_RETENTION_DAYS,
  siteAnalyticsDefinitions,
  siteConversionPct,
  siteEventLabelsAr,
  siteGoalNames,
  type PublicEventsBatch,
  type SiteAnalytics,
  type SiteGoalName,
  type SiteGoalRow,
  type SitePathRow,
  type SiteReferrerRow,
  type SiteSeriesPoint,
  type SiteVariantRow,
} from '@erp/contracts';
import { newId, withPlatformAdminTx, type DatabaseHandle, type DrizzleTx } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';

/**
 * P-M10 — **قياس الموقع** (`docs/roadmap/MARKETING_SITE_PLAN.md` §5): «أن يُقاس أثر الموقع لا
 * أن يُخمَّن».
 *
 * وستة قرارات تسكن هذا الملف:
 *
 *   1. **القياس في قاعدتنا لا في طرفٍ ثالث.** لا وسوم تعبر إلى نطاقٍ آخر: الأحداث تُكتب في
 *      `site_events` عبر نقطتنا، وتُقرأ مجمَّعةً في اللوحة. وثمن هذا القرار أننا نبني ما كان
 *      يُشترى — ومكسبه أن بيانات زوّار موقع نظامٍ يُخزّن فواتير الناس لا تخرج من نطاقنا.
 *   2. **الكتابة تفترض سيّئاً**: أسماء الأحداث ومفاتيح الوصف مقيَّدة في العقد، ومهما أُرسل غريباً
 *      يُردّ 400 قبل القاعدة؛ والصفّ المكتوب لا يحمل هويةً لأن العمود غير موجود أصلاً (0084).
 *   3. **الاحتفاظ ١٨٠ يوماً، ويُنفَّذ فعلاً.** الحذف يجري **عند الكتابة** لا في مهمّةٍ متفرّقة
 *      (لا عامل في بيئة التطوير): علامةٌ مائية في `platform_settings` (`site.events.pruned_at`)
 *      تمنع تكرار الحذف أكثر من مرّةٍ كل يوم — فالحدث العادي لا يدفع ثمن تنظيفٍ لا يحتاجه.
 *   4. **القمع يُقاس بالزوّار لا بالنقرات.** كل خطوةٍ تُقرأ بـ`count(DISTINCT visitor)`: زرٌّ
 *      يُنقر مرّتين من شخصٍ واحد ليس «اشتراكين»، والنسبة من زوّار النافذة لا من مشاهدات الصفحة.
 *   5. **العائل لا الرابط.** المُحيل يُخزَّن ويُعرض بعائله وحده (`example.com`)، لأن الرابط
 *      الكامل يحمل نصوص بحثٍ ومعاملاتٍ قد تحمل ما لا نريد حفظه.
 *   6. **أ/ب يُقاس بالعرض لا بالتحزين**: من رأى نسخةً هو من أرسل `experiment_exposure`، والتحويل
 *      من بعدها لنفس الزائر — فلا نحتاج تخزين «من رأى ماذا» في القاعدة أصلاً (التوزيع يقع في
 *      المتصفّح بدالّة العقد `pickContentVariant`).
 */

/** مفتاح العلامة المائية للاحتفاظ — في إعدادات المنصّة كما في بقيّة أعلام التشغيل. */
const PRUNE_MARKER_KEY = 'site.events.pruned_at';

/** الفاصل الأدنى بين حذفين — مرّةً كل يوم: الأحداث المجمَّدة تُنظَّف دون أن يدفع كل حدثٍ ثمنها. */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class SiteAnalyticsService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  // ================================================================ الكتابة

  /**
   * تسجيل دفعةِ أحداث. **بلا إرجاع ما كُتب**: الجواب عددٌ مقبول فقط، فلا يتحوّل المسار إلى
   * قناة قراءةٍ لما في القاعدة.
   *
   * والدفعة تُختصر داخل المعاملة نفسها: الصفوف المتطابقة تماماً (نفس الزائر ونفس الاسم ونفس
   * المسار في النافذة نفسها) تُكتب مرّة — فإعادة إرسال طلبٍ فشل ردّه ليس حدثاً ثانياً.
   */
  async record(batch: PublicEventsBatch, referrerHost: string | null): Promise<number> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const seen = new Set<string>();
      let accepted = 0;
      for (const event of batch.events) {
        const dedupeKey = `${event.visitor}|${event.name}|${event.path}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        await tx.execute(sql`
          INSERT INTO site_events (id, name, path, locale, referrer_host, visitor, meta)
          VALUES (${newId()}, ${event.name}, ${event.path}, ${event.locale}, ${referrerHost},
                  ${event.visitor}, ${JSON.stringify(event.meta ?? {})}::jsonb)
        `);
        accepted += 1;
      }
      await this.pruneIfDue(tx);
      return accepted;
    });
  }

  /**
   * الاحتفاظ: حذف ما تجاوز المدّة، مرّةً كل يوم على الأكثر.
   *
   * والعلامة المائية **قراءةٌ قبل الحذف** لا عدّادٌ في الذاكرة: لو تعدّدت النسخ من الخدمة
   * لكان العدّاد المحلّي يعني حذفاً بعدد النسخ، وصفٌّ في القاعدة يعني حذفاً واحداً للجميع.
   */
  private async pruneIfDue(tx: DrizzleTx): Promise<void> {
    const marker = (
      await tx.execute(sql`
        SELECT value::text AS value FROM platform_settings
         WHERE tenant_id IS NULL AND key = ${PRUNE_MARKER_KEY}
      `)
    ).rows as unknown as Array<{ value: string }>;
    const last = marker[0]?.value ? Date.parse(JSON.parse(marker[0].value) as string) : NaN;
    if (Number.isFinite(last) && Date.now() - last < PRUNE_INTERVAL_MS) return;

    await tx.execute(sql`
      DELETE FROM site_events
       WHERE occurred_at < now() - ${`${SITE_EVENTS_RETENTION_DAYS} days`}::interval
    `);
    await tx.execute(sql`
      INSERT INTO platform_settings (id, tenant_id, key, value, updated_at)
      VALUES (${newId()}, NULL, ${PRUNE_MARKER_KEY}, ${JSON.stringify(new Date().toISOString())}::jsonb, now())
      ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `);
  }

  // ================================================================ القراءة

  /**
   * اللوحة: كل ما تحتاجه شاشة `/analytics/site` في نداءٍ واحد — الزوّار والأهداف والمنحنى
   * والمصادر والمسارات والتجارب — مع التعريفات والوعد في الجسم نفسه.
   */
  async analytics(windowDays: number): Promise<SiteAnalytics> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = (
        await tx.execute(sql`
          SELECT
            (SELECT count(DISTINCT visitor)::int FROM site_events
              WHERE occurred_at >= now() - ${`${windowDays} days`}::interval) AS visitors_all,
            (SELECT count(DISTINCT visitor)::int FROM site_events
              WHERE name = 'page_view' AND occurred_at >= now() - ${`${windowDays} days`}::interval) AS viewers_all,
            (SELECT count(DISTINCT visitor)::int FROM site_events
              WHERE occurred_at >= date_trunc('day', now())) AS visitors_today,
            (SELECT count(*)::int FROM site_events
              WHERE name = 'page_view' AND occurred_at >= now() - ${`${windowDays} days`}::interval) AS views_all,
            (SELECT count(*)::int FROM site_events
              WHERE name = 'page_view' AND occurred_at >= date_trunc('day', now())) AS views_today
        `)
      ).rows as unknown as Array<{
        visitors_all: number;
        viewers_all: number;
        visitors_today: number;
        views_all: number;
        views_today: number;
      }>;
      const counts = rows[0] ?? {
        visitors_all: 0,
        viewers_all: 0,
        visitors_today: 0,
        views_all: 0,
        views_today: 0,
      };

      const goalRows = (
        await tx.execute(sql`
          SELECT name,
                 count(DISTINCT visitor)::int AS visitors,
                 count(*)::int AS events
            FROM site_events
           WHERE occurred_at >= now() - ${`${windowDays} days`}::interval
             AND name IN ('signup_start', 'signup_complete', 'request_demo', 'newsletter_subscribe')
           GROUP BY name
        `)
      ).rows as unknown as Array<{ name: string; visitors: number; events: number }>;
      const goalByName = new Map(goalRows.map((row) => [row.name, row]));

      const goals: SiteGoalRow[] = siteGoalNames.map((name: SiteGoalName) => {
        const row = goalByName.get(name);
        const visitors = row?.visitors ?? 0;
        return {
          name,
          labelAr: siteEventLabelsAr[name],
          visitors,
          events: row?.events ?? 0,
          ratePct: siteConversionPct(visitors, counts.viewers_all),
        };
      });

      const series = (
        await tx.execute(sql`
          SELECT to_char(day, 'YYYY-MM-DD') AS day,
                 count(DISTINCT e.visitor)::int AS visitors,
                 count(*) FILTER (WHERE e.name = 'page_view')::int AS views
            FROM generate_series(date_trunc('day', now()) - ${`${windowDays - 1} days`}::interval,
                                 date_trunc('day', now()), '1 day') AS day
            LEFT JOIN site_events e ON e.occurred_at >= day AND e.occurred_at < day + interval '1 day'
           GROUP BY day
           ORDER BY day ASC
        `)
      ).rows as unknown as Array<{ day: string; visitors: number; views: number }>;

      const sources = (
        await tx.execute(sql`
          SELECT COALESCE(NULLIF(btrim(referrer_host), ''), 'مباشر') AS host,
                 count(DISTINCT visitor)::int AS visitors
            FROM site_events
           WHERE occurred_at >= now() - ${`${windowDays} days`}::interval
           GROUP BY 1
           ORDER BY visitors DESC, host ASC
           LIMIT 8
        `)
      ).rows as unknown as SiteReferrerRow[];

      const paths = (
        await tx.execute(sql`
          SELECT path,
                 count(DISTINCT visitor)::int AS visitors,
                 count(*) FILTER (WHERE name = 'page_view')::int AS views
            FROM site_events
           WHERE occurred_at >= now() - ${`${windowDays} days`}::interval
           GROUP BY path
           ORDER BY visitors DESC, path ASC
           LIMIT 10
        `)
      ).rows as unknown as SitePathRow[];

      const experimentRows = (
        await tx.execute(sql`
          WITH exposures AS (
            SELECT meta->>'experiment' AS experiment,
                   meta->>'variant' AS variant,
                   visitor
              FROM site_events
             WHERE name = 'experiment_exposure'
               AND occurred_at >= now() - ${`${windowDays} days`}::interval
               AND meta->>'experiment' IS NOT NULL AND meta->>'variant' IS NOT NULL
          ), starters AS (
            SELECT DISTINCT visitor FROM site_events
             WHERE name = 'signup_start' AND occurred_at >= now() - ${`${windowDays} days`}::interval
          )
          SELECT experiment,
                 variant,
                 count(DISTINCT visitor)::int AS exposures,
                 count(DISTINCT visitor) FILTER (WHERE visitor IN (SELECT visitor FROM starters))::int AS converters
            FROM exposures
           GROUP BY experiment, variant
           ORDER BY experiment ASC, variant ASC
        `)
      ).rows as unknown as Array<{
        experiment: string;
        variant: string;
        exposures: number;
        converters: number;
      }>;

      const experiments = new Map<string, SiteVariantRow[]>();
      for (const row of experimentRows) {
        const list = experiments.get(row.experiment) ?? [];
        list.push({
          key: row.variant,
          exposures: row.exposures,
          converters: row.converters,
          ratePct: siteConversionPct(row.converters, row.exposures),
        });
        experiments.set(row.experiment, list);
      }

      const now = new Date();
      const from = new Date(now.getTime() - (windowDays - 1) * 24 * 60 * 60 * 1000);
      return {
        window: { days: windowDays, from: from.toISOString(), to: now.toISOString() },
        visitors: { all: counts.visitors_all, today: counts.visitors_today },
        views: { all: counts.views_all, today: counts.views_today },
        goals,
        series: series as SiteSeriesPoint[],
        sources,
        paths,
        experiments: [...experiments.entries()].map(([experiment, variants]) => ({ experiment, variants })),
        privacy: {
          noteAr: SITE_ANALYTICS_PRIVACY_NOTE_AR,
          retentionDays: SITE_EVENTS_RETENTION_DAYS,
          collected: [...SITE_ANALYTICS_COLLECTED],
          never: [...SITE_ANALYTICS_NEVER],
        },
        definitions: siteAnalyticsDefinitions,
        generatedAt: now.toISOString(),
      };
    });
  }

}