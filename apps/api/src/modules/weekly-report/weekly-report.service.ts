import { Inject, Injectable, Logger } from '@nestjs/common';
import { env } from '@erp/config';
import {
  weeklyRecipients,
  weeklyReportDayLabels,
  weeklyWindow,
  type WeeklyReportPreview,
  type WeeklyReportRecipientOutcome,
  type WeeklyReportRunInput,
  type WeeklyReportRunResult,
} from '@erp/contracts';
import { sql } from 'drizzle-orm';
import { withPlatformAdminTx, withTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { runAsSystem } from '../../request-context/request-context.js';
import { EmailService } from '../email/email.service.js';
import { PlatformAnalyticsService } from '../platform/admin/platform-analytics.service.js';
import { PlatformConsoleService } from '../platform/admin/platform-console.service.js';

/**
 * التقرير الأسبوعي بالبريد — التسليم الدوري المؤجَّل من P-C12
 * (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4: «تقرير أسبوعي بالبريد … يبني على P-C6»).
 *
 * **لا حساب ثانٍ.** الأرقام تُقرأ من `PlatformAnalyticsService.overview()` — نفس ما تعرضه
 * شاشة `/analytics` ونفس ما يقيسه سبيكها — ويُضاف إليها ما لا يوجد في التحليلات بنافذة
 * أسبوع: المنضمّون والمغادرون خلال الأسبوع (تعريفهما هو تعريف التحليلات حرفاً بحرف،
 * والنافذة وحدها أسبوعٌ لا شهر).
 *
 * والقرارات التشغيلية الأربعة التي وقفت حجراً في P-C12 صارت هنا:
 *
 * | السؤال | القرار | لماذا |
 * |---|---|---|
 * | من يستلم؟ | `report.weekly_recipients` (إعداد منصّة، نصٌّ بفواصل) | المشغّل يغيّرها بلا نشر، والقائمة الفارغة تعني «لا تقرير» — لا «أرسل إلى أحد» |
 * | أي يوم وأي ساعة؟ | `report.weekly_day` (0 = الأحد) و`report.weekly_hour` بتوقيت **الخادم** | أسبوع العمل يبدأ بالأحد، والمنصّة كلها تُحسب بتوقيت الخادم؛ منطقة العميل لا تصلح لأرقام المنصّة |
 * | وما فشل الإرسال؟ | لكل مستلم صفُّه: النجاح يُكتب، والخطأ يُسجَّل ويُعاد في النبضة التالية داخل الساعة نفسها، وبعدها يبقى في شاشة البريد لإعادةٍ يدوية | «أُرسل» لا تُعلن إلا عن رسالةٍ لها صفّ في `email_messages` |
 * | ومن يمنع التكرار؟ | سجلّ البريد نفسه: رسالةٌ سابقة بالعنوان نفسه في النافذة نفسها تمنع إرسالاً ثانياً | لا جدولَ حالةٍ جديداً ولا عمودَ «أُرسل»؛ والدليل هو الرسالة |
 *
 * ويُضاف إلى ذلك مساران للمشغّل: **معاينة** (ما سيُرسل ولمن ومتى، بلا إرسال) و**تشغيل
 * يدوي** (لأن انتظار أسبوعٍ كاملٍ لتجربة إعدادٍ ليس تجربة).
 */
@Injectable()
export class WeeklyReportService {
  private readonly logger = new Logger(WeeklyReportService.name);

  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly analytics: PlatformAnalyticsService,
    private readonly console: PlatformConsoleService,
    private readonly email: EmailService,
  ) {}

  // ═══════════════════════════════════════════════════════════ الإعداد

  /**
   * الإعداد الفعّال كما كتبه المشغّل (أو كما في الكتالوج إن لم يُكتب). `listSettings`
   * مصدرها — لا قراءةٌ ثانية لـ`platform_settings` تختلف عنها في التعريف الافتراضي.
   */
  async settings(): Promise<{ enabled: boolean; recipients: string[]; day: number; hour: number }> {
    const { settings } = await this.console.listSettings();
    const value = (key: string): unknown => settings.find((entry) => entry.key === key)?.value;

    const rawDay = Number(value('report.weekly_day') ?? 0);
    const rawHour = Number(value('report.weekly_hour') ?? 7);
    return {
      enabled: value('report.weekly_enabled') === true,
      recipients: weeklyRecipients(String(value('report.weekly_recipients') ?? '')),
      day: Number.isInteger(rawDay) && rawDay >= 0 && rawDay <= 6 ? rawDay : 0,
      hour: Number.isInteger(rawHour) && rawHour >= 0 && rawHour <= 23 ? rawHour : 7,
    };
  }

  /** الرابط داخل البريد: نطاق اللوحة إن كان مُعدّاً، وإلا مسارٌ نسبيّ لا رابط ميت. */
  private link(): string {
    const base = (env.CONSOLE_PUBLIC_URL ?? '').replace(/\/+$/, '');
    return `${base}/analytics`;
  }

  /** النبضة القادمة للجدول: أول (يوم الساعة) قادمٍ بعد الآن — بتوقيت الخادم. */
  nextRunAt(now: Date, day: number, hour: number): Date {
    const next = new Date(now.getTime());
    next.setHours(hour, 0, 0, 0);
    const shift = (day - next.getDay() + 7) % 7;
    next.setDate(next.getDate() + shift);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 7);
    return next;
  }

  /** هل نحن في ساعة الإرسال بالضبط؟ (نبضة المؤقّت — رخيصةٌ بلا استعلام) */
  isDue(now: Date, day: number, hour: number): boolean {
    return now.getDay() === day && now.getHours() === hour;
  }

  /**
   * موعد الإرسال الخاص بالنافذة الجارية: إغلاق النافذة + يوم الجدول + ساعته.
   *
   * النافذة تُغلق صبيحة الأحد (`weeklyWindow`)، فإضافة `day` يوماً تُوصل إلى يوم الجدول
   * (0 = الأحد)، و`hour` إلى ساعته. وهذا — لا «آخر موعد مرّ» — هو ما يقيس اللحاق: خادمٌ
   * يقلع الأربعاء 06:20 قبل موعده بساعة لا يُرسل تقريراً مبكراً، وإنما ينتظر ساعته.
   */
  occurrenceForWindow(windowEnd: Date, day: number, hour: number): Date {
    const at = new Date(windowEnd.getTime());
    at.setDate(at.getDate() + day);
    at.setHours(hour, 0, 0, 0);
    return at;
  }

  /** هل حان موعد هذه النافذة (أو تأخّرنا عنه)؟ — يُستعمل في لحاق الإقلاع فقط. */
  isDueSinceStartup(now: Date, day: number, hour: number): boolean {
    return now.getTime() >= this.occurrenceForWindow(weeklyWindow(now).end, day, hour).getTime();
  }

  // ═══════════════════════════════════════════════════════════ المعاينة

  async preview(now = new Date()): Promise<WeeklyReportPreview> {
    const config = await this.settings();
    const window = weeklyWindow(now);
    const sentTo = await this.sentTo(window.end);
    const variables = this.overviewVariables(await this.analytics.overview(), window, await this.weekCounts(window.start, window.end));

    return {
      enabled: config.enabled,
      recipients: config.recipients,
      schedule: {
        day: config.day,
        dayLabelAr: weeklyReportDayLabels[config.day] ?? weeklyReportDayLabels[0],
        hour: config.hour,
        timezone: 'server',
        nextRunAt: this.nextRunAt(now, config.day, config.hour).toISOString(),
      },
      window: {
        start: window.start.toISOString(),
        end: window.end.toISOString(),
        label: windowLabel(window.start, window.end),
      },
      sentTo,
      pending: config.recipients.filter((address) => !sentTo.includes(address)),
      link: this.link(),
      variables,
    };
  }

  // ═══════════════════════════════════════════════════════════ الإرسال

  /**
   * التسليم — من المجدول ومن التشغيل اليدوي ومن الطابور، بمسارٍ واحد. لا يُرمى خطأٌ من
   * مستلمٍ على الآخرين: كل عنوانٍ نتيجته في `outcomes`، والموجَّه إلى الشاشة يقرأها.
   */
  async run(input: WeeklyReportRunInput, now = new Date()): Promise<WeeklyReportRunResult> {
    const config = await this.settings();
    const window = weeklyWindow(now);
    const targets = input.to && input.to.length > 0 ? input.to : config.recipients;
    const windowInfo = {
      start: window.start.toISOString(),
      end: window.end.toISOString(),
      label: windowLabel(window.start, window.end),
    };

    const outcomes: WeeklyReportRecipientOutcome[] = [];
    if (targets.length === 0) {
      this.logger.warn(
        { window: windowInfo.label },
        'weekly report skipped: no recipients (report.weekly_recipients is empty)',
      );
      return tally(windowInfo, outcomes);
    }

    const overview = await this.analytics.overview();
    const variables = this.overviewVariables(overview, window, await this.weekCounts(window.start, window.end));

    for (const to of targets) {
      if (!input.force && (await this.sentTo(window.end, to)).length > 0) {
        outcomes.push({ to, messageId: null, status: 'skipped', detail: 'رسالةٌ لهذه النافذة بالعنوان نفسه موجودة' });
        continue;
      }
      try {
        const message = await this.email.send({
          event: 'report.weekly',
          to,
          locale: input.locale,
          variables,
          // تقرير المنصة لا يخصّ عميلاً: بلا مستأجرٍ لا يُحتسب على حصّة أحد (`scope: 'platform'`).
          tenantId: null,
        });
        outcomes.push({
          to,
          messageId: message.id,
          // النتيجة تُقرأ من الرسالة نفسها لا من نجاة النداء: حجرٌ يُنتج صفًّا بحالة
          // `suppressed` وليس «أُرسل»، وطابورٌ بلا عامل يبقى `queued` — ويُقال ذلك.
          status: outcomeOf(message.status),
          detail: outcomeDetail(message.status),
        });
      } catch (error) {
        const detail = (error instanceof Error ? error.message : String(error)).slice(0, 300);
        this.logger.error({ to, err: detail }, 'weekly report delivery failed for a recipient');
        outcomes.push({ to, messageId: null, status: 'failed', detail });
      }
    }

    const result = tally(windowInfo, outcomes);
    this.logger.log(
      { window: windowInfo.label, sent: result.sentCount, skipped: result.skippedCount, failed: result.failedCount },
      'weekly report run finished',
    );
    return result;
  }

  /** معالج الطابور (`maintenance:report.weekly`) — نفس المسار، والنبضة شبكةُ أمانٍ له. */
  async runFromJob(context: { payload: Record<string, unknown> }): Promise<void> {
    const to = Array.isArray(context.payload.to) ? (context.payload.to as string[]) : undefined;
    // المعالج يعمل بلا طلب: سياق النظام، فلا جلسةَ مصطنعة ولا فاعلَ مُخترع.
    await runAsSystem('report.weekly', () =>
      this.run({ locale: 'ar', force: false, ...(to ? { to } : {}) }),
    );
  }

  // ═══════════════════════════════════════════════════════════ القراءات

  /**
   * من له رسالةٌ مسجَّلة لهذه النافذة (وبعنوانٍ محدّد إن أُعطي). الدليل صفُّ البريد نفسه،
   * فيُقرأ من `email_messages` — لا من عمود حالةٍ ثانٍ يمكن أن يكذب.
   *
   * والمقارنة بـ**نهاية** النافذة لا ببدايتها: التقرير عن نافذةٍ يُرسل بعد إغلاقها، فالمقارنة
   * بالبداية كانت تُدخل رسالةَ الأحد 07:00 في نافذة الأسبوع **التالي** (التي تبدأ الأحد 00:00
   * — أي قبلها بسبع ساعات) فيُتخطّى تقريرُ الأسبوع القادم كأنه أُرسل وهو لم يُرسل.
   */
  private async sentTo(windowEnd: Date, address?: string): Promise<string[]> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const result = await tx.execute(sql`
        SELECT DISTINCT to_email
          FROM email_messages
         WHERE event = 'report.weekly'
           AND tenant_id IS NULL
           AND created_at >= ${windowEnd}
           ${address ? sql`AND to_email = ${address}` : sql``}
      `);
      return (result.rows as Array<{ to_email: string }>).map((row) => row.to_email);
    });
  }

  /**
   * المنضمّون والمغادرون في الأسبوع: تعريف التحليلات نفسه (`tenants.created_at`،
   * `tenant_subscriptions.canceled_at`) بنافذة `[start, end)` لا بشهر.
   */
  private async weekCounts(start: Date, end: Date): Promise<{ joined: number; churned: number }> {
    const rows = await withTx(this.database.db, async (tx) => {
      const result = await tx.execute(sql`
        SELECT
          (SELECT count(*) FROM tenants WHERE created_at >= ${start} AND created_at < ${end})::int AS joined,
          (SELECT count(*) FROM tenant_subscriptions
            WHERE canceled_at IS NOT NULL AND canceled_at >= ${start} AND canceled_at < ${end})::int AS churned
      `);
      return result.rows as Array<{ joined: number; churned: number }>;
    });
    return { joined: Number(rows[0]?.joined ?? 0), churned: Number(rows[0]?.churned ?? 0) };
  }

  /** المتغيّرات التي يقبلها القالب — أسماؤها في `emailEventRegistry` لا تُخترع هنا. */
  private overviewVariables(
    overview: Awaited<ReturnType<PlatformAnalyticsService['overview']>>,
    window: { start: Date; end: Date },
    counts: { joined: number; churned: number },
  ): Record<string, string> {
    const alerts =
      overview.alerts.length === 0
        ? 'لا تنبيهات'
        : overview.alerts
            .slice(0, 5)
            .map((alert) => `• ${alert.title}${alert.count > 0 ? ` (${alert.count})` : ''}`)
            .join('\n');

    return {
      week: windowLabel(window.start, window.end),
      tenants: String(overview.counts.total),
      active: String(overview.counts.active),
      trialing: String(overview.counts.trialing),
      new_this_week: String(counts.joined),
      churned_this_week: String(counts.churned),
      mrr: overview.mrr,
      outstanding: overview.collection.outstanding,
      overdue: overview.collection.overdue,
      trials_ending: String(overview.trials.endingInSevenDays),
      alerts,
      link: this.link(),
    };
  }
}

/** `2026-09-06 → 2026-09-12` — والنهاية تُعرض بيومها الأخير المشمول لا بيوم البداية التالي. */
export function windowLabel(start: Date, end: Date): string {
  const last = new Date(end.getTime() - 86_400_000);
  return `${isoDate(start)} → ${isoDate(last)}`;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** حالة الرسالة → نتيجة المستلم في التقرير. */
function outcomeOf(status: string): WeeklyReportRecipientOutcome['status'] {
  if (status === 'queued' || status === 'sent') return 'sent';
  if (status === 'suppressed') return 'skipped';
  return 'failed';
}

function outcomeDetail(status: string): string | null {
  if (status === 'queued') return 'في الطابور (لا مُسلِّم بعد)';
  if (status === 'suppressed') return 'محجوب بقائمة الحجر';
  return null;
}

function tally(
  window: WeeklyReportRunResult['window'],
  outcomes: WeeklyReportRecipientOutcome[],
): WeeklyReportRunResult {
  return {
    window,
    outcomes,
    sentCount: outcomes.filter((entry) => entry.status === 'sent').length,
    skippedCount: outcomes.filter((entry) => entry.status === 'skipped').length,
    failedCount: outcomes.filter((entry) => entry.status === 'failed').length,
  };
}
