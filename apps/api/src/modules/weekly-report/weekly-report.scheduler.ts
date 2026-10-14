import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { env } from '@erp/config';

import { runAsSystem } from '../../request-context/request-context.js';
import { QUEUE_PORT, type QueuePort } from '../platform-services/jobs/queue.service.js';

import { WeeklyReportService } from './weekly-report.service.js';

/**
 * مجدول التقرير الأسبوعي — النبضة التي كانت ناقصةً في P-C12.
 *
 * | السؤال | القرار |
 * |---|---|
 * | كم مرّة ينبض؟ | كل دقيقة. النافذة ساعةٌ واحدة، فلا معنى لنبضةٍ أدقّ، ولا ضرر من أخصّ |
 * | من يشتغل؟ | **عاملٌ واحد**: العامل (`WORKER=true`) إن كان ثمة طابور، وإلا العملية نفسها — لأن جوّاً بلا Redis بلا مستهلكين أبداً |
 * | وماذا ينبض؟ | قراءة الإعداد أوّلاً (سؤالٌ واحد)، فإن لم يكن اليوم/الساعة فلاشيء — لا استعلام تحليلاتٍ في كل دقيقة |
 * | والتكرار؟ | يمنعه سجلّ البريد: رسالةُ النافذة نفسها بالعنوان نفسه تمنع إرسالاً ثانياً |
 *
 * ولا يعمل في `NODE_ENV=test`: السبكات لا تنتظر تقويمًا، ولا يصحّ أن ترسل بريداً بالصدفة
 * لأن اختباراً استغرق دقيقة.
 */
@Injectable()
export class WeeklyReportScheduler implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(WeeklyReportScheduler.name);
  private timer: ReturnType<typeof setInterval> | undefined;

  /** نبضة كل دقيقة — ثابتٌ لا إعداد: لا أحد يحتاج ضبطها، ومَن ضبطها سيضبطها خطأً. */
  private static readonly TICK_MS = 60_000;

  constructor(
    private readonly report: WeeklyReportService,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
  ) {}

  async onModuleInit(): Promise<void> {
    if (env.NODE_ENV === 'test') return;
    if (!(await this.ownsSchedule())) {
      this.logger.log('weekly report ticker not started: the worker owns the schedule in this deployment');
      return;
    }
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.logger.error(
          { err: error instanceof Error ? error.message : String(error) },
          'weekly report tick failed',
        );
      });
    }, WeeklyReportScheduler.TICK_MS);
    this.timer.unref?.();
    this.logger.log({ tickMs: WeeklyReportScheduler.TICK_MS }, 'weekly report ticker started');

    // **لحاق الإقلاع**: نبضةٌ واحدة الآن بنمط «مرّ الموعد ولم يُرسل». بلاها، خادمٌ أُعيد
    // تشغيله بعد ساعة الإرسال يفوته الأسبوع كله؛ والحجرُ على سجلّ البريد يجعلها آمنة.
    void this.tick(new Date(), true).catch((error: unknown) => {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'weekly report catch-up tick failed',
      );
    });
  }

  /**
   * من يملك الجدول؟ ثلاثة أسئلة بالترتيب، وكلٌّ منها يُقاس لا يُفترض:
   *
   *   1. **لا طابور مُعلَن** (`REDIS_URL` غائب أو `JOBS_ENABLED=false`): لا مستهلكين في أي
   *      عملية، فالعملية الحاضرة هي المجدول.
   *   2. **مُعلَنٌ ولا يسمع** (هذه البيئة: `REDIS_URL` مكتوب ولا خادم): الحكم نفسه — عاملٌ
   *      لا يمكن أن يوجد، فالعملية الحاضرة هي المجدول.
   *   3. **طابورٌ حيّ**: العامل وحده (`WORKER=true`) — فلا تُرسل نسختان التقرير نفسه.
   *
   * ولو قال المنطق «العامل» وليس ثمة عامل، لبقي التقرير صامتاً أسبوعاً بعد أسبوع بلا أن
   * يشكو أحد؛ ولهذا يُسجَّل القرار في الإقلاع صراحةً.
   */
  private async ownsSchedule(): Promise<boolean> {
    if (!this.queue.isEnabled()) return true;
    if (!(await this.queue.ping())) return true;
    return env.WORKER;
  }

  /**
   * نبضةٌ واحدة — تُستدعى من المؤقّت، ويستدعيها السبيك مباشرةً بلا انتظار.
   * و`catchUp` (لحاق الإقلاع) يوسّع الشرط من «نحن في الساعة» إلى «مرّ الموعد ولم يُرسل».
   */
  async tick(
    now = new Date(),
    catchUp = false,
  ): Promise<{ due: boolean; sent: number; skipped: number; failed: number }> {
    const config = await this.report.settings();
    if (!config.enabled) return { due: false, sent: 0, skipped: 0, failed: 0 };
    const due = catchUp
      ? this.report.isDueSinceStartup(now, config.day, config.hour)
      : this.report.isDue(now, config.day, config.hour);
    if (!due) return { due: false, sent: 0, skipped: 0, failed: 0 };

    // سياق النظام: المهمّة خلفية ولا جلسةَ مشغّل لها، وبعض ما تُنادى به خدماتٌ تشترط سياقاً.
    const result = await runAsSystem('report.weekly', () => this.report.run({ locale: 'ar', force: false }, now));
    return { due: true, sent: result.sentCount, skipped: result.skippedCount, failed: result.failedCount };
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
