import { Injectable, Logger } from '@nestjs/common';
import type { WebhookEvent } from '@erp/contracts';

import { DeveloperService } from './developer.service.js';

/**
 * P-C11 — ناشر الأحداث: الواجهة الوحيدة التي تناديها وحدات العميل.
 *
 * **ولماذا واجهةٌ رقيقة فوق `DeveloperService.dispatch`؟** لأن المطلوب من موضع الاستدعاء أن
 * يقرأ سطراً واحداً لا يفشل: `void this.webhooks.emit('invoice.posted', tenantId, {...})`.
 * الفشل كله (قاعدة، شبكة، عنوان لا يُجيب) يُسجَّل ولا يصعد — فالويب هوك **التزامٌ** لا شرطُ
 * نجاحٍ للعملية التي أنتجته: فاتورةٌ صُدِّرت تبقى مصدَّرةً حتى لو كان عنوان العميل مطفأً.
 */
@Injectable()
export class WebhookPublisher {
  private readonly logger = new Logger(WebhookPublisher.name);

  constructor(private readonly developer: DeveloperService) {}

  /** يُنشئ تسليماً لكل عنوانٍ مشترِك ويحاول أول محاولة. ويعيد عدد العناوين. */
  async emit(event: WebhookEvent, tenantId: string, payload: Record<string, unknown>): Promise<number> {
    try {
      return await this.developer.dispatch(event, tenantId, payload);
    } catch (error) {
      // `dispatch` لا يرمي أصلاً؛ هذا الحزام الثاني يضمن أن خطأً غير متوقّع (حتى في
      // بناء الحمولة أو المصادقة) لا يصل إلى مسار العميل.
      this.logger.warn({ event, tenantId, err: (error as Error).message }, 'webhook emit failed');
      return 0;
    }
  }
}
