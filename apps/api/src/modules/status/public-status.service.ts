import { Injectable } from '@nestjs/common';
import {
  PUBLIC_STATUS_NOTE_AR,
  PUBLIC_STATUS_NOTE_EN,
  publicComponentKeys,
  publicComponentLabels,
  publicStatusLevelLabels,
  publicStatusRollUp,
  publicStatusRollUpLabels,
  type PlatformHealth,
  type PublicStatus,
  type PublicStatusComponent,
  type PublicStatusLevel,
} from '@erp/contracts';

import { PlatformOperationsService } from '../operations/platform-operations.service.js';

/**
 * P-M9 — **حالة الخدمة العلنية** (`docs/roadmap/MARKETING_SITE_PLAN.md` §5): تُترجم مصفوفة
 * مجسّات P-C9 إلى خمسة مكوّناتٍ يفهمها العميل.
 *
 * **القرار الحاكم: المجسّ الداخلي يُقاس ولا يُنشر.** مجسّات P-C9 تحمل رسالة خطأ القاعدة،
 * واسم دلو التخزين، وسائق الطابور، وحالة مزوّد البريد — وتمريرُها إلى صفحةٍ عامّة تسريبٌ
 * لا شفافية. فالترجمة هنا تُسقط `detail` الداخلي **كلّه** وتضع مكانه جملةً ثابتة من العقد
 * (`publicStatusLevelLabels`)، وتمرّر الحالة وحدها (`up` · `degraded` · `down` ·
 * `not_configured`) وزمناً مقيساً. والسبيك الحيّ يقيس أن الجواب **لا يحمل** أيّاً من هذه
 * الكلمات الداخلية.
 *
 * **وذاكرةُ عشر ثوانٍ قرارٌ لا تحسين**: الصفحة تُقرأ من زوّار كثيرين، وكل نداءٍ يشغّل ستّة
 * مجسّات بعضها يلمس القاعدة. عشرُ ثوانٍ تجعل «صفحة الحالة» لا تُستعمل سلاحَ استنزاف، ولا
 * تُخفي تغيّراً حقيقياً: من يفتح الصفحة بعد حادثٍ يرى انعكاسه خلال ثوانٍ لا دقائق.
 */
@Injectable()
export class PublicStatusService {
  /** مدّة صلاحية اللقطة — بالمللي ثانية. */
  private static readonly MEMO_MS = 10_000;

  /**
   * نسبة أخطاء الخادم التي تجعل «المنصّة والواجهات» تعمل ببطء. ولا تُقاس على عدّادٍ صغير
   * (أقلّ من ٢٠ طلباً): خطأٌ واحد من ثلاثة ليس «تعطّلاً» بل عيّنةً صغيرة.
   */
  private static readonly ERROR_RATE_LIMIT = 0.25;
  private static readonly ERROR_RATE_MIN_REQUESTS = 20;

  private memo: { at: number; value: PublicStatus } | null = null;

  constructor(private readonly operations: PlatformOperationsService) {}

  async snapshot(): Promise<PublicStatus> {
    const now = Date.now();
    if (this.memo && now - this.memo.at < PublicStatusService.MEMO_MS) return this.memo.value;
    const value = this.project(await this.operations.health());
    this.memo = { at: now, value };
    return value;
  }

  private project(health: PlatformHealth): PublicStatus {
    const probeStatus = (name: string): PublicStatusLevel => {
      const probe = health.probes.find((item) => item.name === name);
      return (probe?.status as PublicStatusLevel | undefined) ?? 'down';
    };
    const probeLatency = (name: string): number | null =>
      health.probes.find((item) => item.name === name)?.latencyMs ?? null;

    const requests = health.requests;
    const platformLevel: PublicStatusLevel =
      requests.count >= PublicStatusService.ERROR_RATE_MIN_REQUESTS &&
      requests.errorRate > PublicStatusService.ERROR_RATE_LIMIT
        ? 'degraded'
        : 'up';

    const levels: Record<(typeof publicComponentKeys)[number], PublicStatusLevel> = {
      // المنصّة回答了 الطلب فعلاً — فهي قائمة. ولا تُقاس على المجسّات الأخرى: قاعدةٌ متعطّلة
      // لا تعني أن الواجهة توقّفت، وقولُ العكس يخيف بلا سبب.
      platform: platformLevel,
      database: probeStatus('database'),
      // المهام الخلفية: أسوأ ما في الطابور والعامل — والعميل يهمّه «هل ستُرسل تقاريري؟».
      jobs: publicStatusRollUp([probeStatus('queue'), probeStatus('worker')]),
      email: probeStatus('email'),
      files: probeStatus('storage'),
    };

    const components: PublicStatusComponent[] = publicComponentKeys.map((key) => ({
      key,
      labelAr: publicComponentLabels[key].labelAr,
      labelEn: publicComponentLabels[key].labelEn,
      whatAr: publicComponentLabels[key].whatAr,
      whatEn: publicComponentLabels[key].whatEn,
      status: levels[key],
      noteAr: publicStatusLevelLabels[levels[key]].noteAr,
      noteEn: publicStatusLevelLabels[levels[key]].noteEn,
      latencyMs:
        key === 'platform'
          ? Math.round(requests.p95Ms * 100) / 100
          : key === 'database'
            ? probeLatency('database')
            : null,
    }));

    const status = publicStatusRollUp(components.map((component) => component.status));

    return {
      status,
      statusLabelAr: publicStatusRollUpLabels[status].labelAr,
      statusLabelEn: publicStatusRollUpLabels[status].labelEn,
      statusTone: publicStatusRollUpLabels[status].tone,
      checkedAt: health.checkedAt,
      uptimeSeconds: health.uptimeSeconds,
      // الحادث من `platform.maintenance*` — النصّ الذي كتبه المشغّل ليقرأه العميل، لا سطرُ خطأ.
      incident: health.incident.active ? { message: health.incident.message, since: null } : null,
      components,
      noteAr: PUBLIC_STATUS_NOTE_AR,
      noteEn: PUBLIC_STATUS_NOTE_EN,
    };
  }
}
