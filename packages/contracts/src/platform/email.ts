import { z } from 'zod';

import { errorCodes } from '../errors.js';
import { DomainError } from '../problem.js';
import { uuidSchema } from '../ids.js';

/**
 * P-C6 — «خدمة البريد» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §7).
 *
 * هذا الملف يحمل **ما لا يتغيّر**: فهرس الأحداث، ومتغيّرات كل حدث، ونصوص القوالب
 * الافتراضية بلغتين، ودالّة التصيير النقيّة (`renderEmailTemplate`). أما ما يتغيّر بالتشغيل
 * — نصٌّ عدّله مشغّل، أو تجاوزٌ كتبه عميل، أو سجلُّ رسالة — ففي الجداول.
 *
 * **لماذا الفهرس ثابت في الكود لا في جدول:** حدثٌ بلا مرسلٍ في الكود لا يُرسَل أبداً؛ فلو
 * كان الحدث صفّاً في جدول لأمكن إنشاء «حدث» لا يقرؤه أحد. الكود هنا هو المصدر، والجدول
 * يحمل النسخ القابلة للتحرير (`email_templates`) والسجلّ (`email_messages`).
 */

/** الأحداث — الفهرس الثابت المذكور في §7.2 من الخطة (نفس الترتيب ونفس المفردات). */
export const emailEvents = [
  'user.invite',
  'password.reset',
  'mfa.recovery',
  'portal.access.grant',
  'invoice.created',
  'payment.received',
  'statement.ready',
  'einvoice.rejected',
  'stock.below_min',
  'shift.close.variance',
  'subscription.created',
  'subscription.renewed',
  'subscription.expiring',
  'subscription.payment_failed',
  'activation.approved',
  'activation.rejected',
  'announcement',
  // P-C6 المؤجَّل — التقرير الأسبوعي: الحدث الوحيد الذي **لا يخصّ عميلاً**، ووجهته مشغّلو
  // المنصة. ولذلك نطاقه `platform` فلا يُحتسب على حصّة أي منشأة.
  'report.weekly',
  // P-M4 — رمز تحقّق التسجيل: يُرسل إلى زائرٍ **لا عميلَ له** بعد (لا منشأة ولا حصّة)،
  // ونطاقه `platform` لذلك. ومتغيّره `code` سرٌّ لا يُخزَّن في أي جدول.
  'signup.verify',
  // P-M6 — حدثان لزائرَين لا عميلَين: تأكيد استلام طلبٍ من الموقع، ورابطُ تأكيد النشرة.
  // وكلاهما `platform` لأن كليهما يُرسل إلى من ليس له منشأة — فلا يُحتسب على حصّة أحد.
  'lead.received',
  'subscriber.confirm',
  // P-M7 — رسالة حملة: النصّ يكتبه المشغّل في اللوحة، والقالب هنا **ظرفٌ لا محتوى**
  // (`{{subject}}` و`{{body}}`)، لأن نصّ الحملة محتوى تحريري يُحفظ في صفّ الحملة نفسه.
  // ونطاقه `platform` كما حدثا P-M6: لا يُحتسب على حصّة عميل، والمرسل إليه قد لا يكون عميلاً.
  'campaign.message',
  // FE-15 — إشارة زميل داخل تعليق على مستند. نطاقه tenant فيُحتسب على حصّة المنشأة.
  'comment.mention',
] as const;

export type EmailEvent = (typeof emailEvents)[number];

/** من يُرسل الحدث: سطح عميلٍ (يُحسب على حصته) أم المنصة (لا يُحسب على العميل). */
export const emailEventScopes = ['tenant', 'platform'] as const;
export type EmailEventScope = (typeof emailEventScopes)[number];

export const emailLocales = ['ar', 'en'] as const;
export type EmailLocale = (typeof emailLocales)[number];

export const emailMessageStatuses = ['queued', 'sent', 'failed', 'suppressed', 'bounced'] as const;
export type EmailMessageStatus = (typeof emailMessageStatuses)[number];

export const emailSuppressionReasons = ['bounce', 'complaint', 'unsubscribe', 'manual'] as const;
export type EmailSuppressionReason = (typeof emailSuppressionReasons)[number];

/** `console` للتطوير، و`smtp` لبروتوكول SMTP، و`resend` لخدمة Resend API، و`http` لأي بوابة بريد HTTP/Webhook. */
export const emailProviders = ['console', 'smtp', 'resend', 'http'] as const;
export type EmailProvider = (typeof emailProviders)[number];

/** مخططات القيم المفردة — تُستعمل في الاستعلامات (`?locale=ar`) لا في الجسم وحده. */
export const emailEventSchema = z.enum(emailEvents);
export const emailLocaleSchema = z.enum(emailLocales);
export const emailMessageStatusSchema = z.enum(emailMessageStatuses);
export const emailSuppressionReasonSchema = z.enum(emailSuppressionReasons);
export const emailProviderSchema = z.enum(emailProviders);

export type EmailEventDefinition = {
  readonly event: EmailEvent;
  readonly labelAr: string;
  readonly labelEn: string;
  readonly scope: EmailEventScope;
  /** المتغيّرات التي يقبلها القالب — أي `{{var}}` خارجها يُرفض عند الحفظ وعند التصيير. */
  readonly variables: readonly string[];
  readonly descriptionAr: string;
};

export const emailEventRegistry: readonly EmailEventDefinition[] = [
  {
    event: 'user.invite',
    labelAr: 'دعوة مستخدم',
    labelEn: 'User invitation',
    scope: 'tenant',
    variables: ['name', 'tenant', 'link'],
    descriptionAr: 'تُرسل حين يدعو مسؤول المنشأة مستخدماً جديداً.',
  },
  {
    event: 'password.reset',
    labelAr: 'استعادة كلمة المرور',
    labelEn: 'Password reset',
    scope: 'tenant',
    variables: ['name', 'link', 'expires'],
    descriptionAr: 'رابط استعادة كلمة المرور بصلاحيةٍ مؤقّتة.',
  },
  {
    event: 'mfa.recovery',
    labelAr: 'رموز استرداد 2FA',
    labelEn: 'Two-factor recovery codes',
    scope: 'tenant',
    variables: ['name', 'code'],
    descriptionAr: 'يُرسل عند إعادة توليد رموز الاسترداد.',
  },
  {
    event: 'portal.access.grant',
    labelAr: 'منح وصول البوابة',
    labelEn: 'Portal access granted',
    scope: 'tenant',
    variables: ['name', 'link', 'expires'],
    descriptionAr: 'الرسالة الوحيدة المُنفَّذة اليوم (`modules/portal`) — وتُبنى الآن من القالب.',
  },
  {
    event: 'invoice.created',
    labelAr: 'فاتورة جديدة',
    labelEn: 'New invoice',
    scope: 'tenant',
    variables: ['name', 'invoice_no', 'amount', 'due'],
    descriptionAr: 'إشعار الفاتورة للعميل مع رقمها ومبلغها وتاريخ استحقاقها.',
  },
  {
    event: 'payment.received',
    labelAr: 'دفعة مستلمة',
    labelEn: 'Payment received',
    scope: 'tenant',
    variables: ['name', 'invoice_no', 'amount'],
    descriptionAr: 'تأكيد تحصيل دفعة على فاتورة.',
  },
  {
    event: 'statement.ready',
    labelAr: 'كشف حساب جاهز',
    labelEn: 'Statement ready',
    scope: 'tenant',
    variables: ['name', 'period', 'link'],
    descriptionAr: 'كشف حساب الفترة جاهز للتنزيل.',
  },
  {
    event: 'einvoice.rejected',
    labelAr: 'رفض/فشل زاتكا',
    labelEn: 'ZATCA rejection or failure',
    scope: 'tenant',
    variables: ['name', 'invoice_no', 'reason'],
    descriptionAr: 'فشل إرسال فاتورة إلى زاتكا — مع سبب الرفض.',
  },
  {
    event: 'stock.below_min',
    labelAr: 'مخزون تحت الحد',
    labelEn: 'Stock below minimum',
    scope: 'tenant',
    variables: ['name', 'item', 'on_hand', 'min'],
    descriptionAr: 'تنبيه أن صنفاً نزل تحت حدّه الأدنى.',
  },
  {
    event: 'shift.close.variance',
    labelAr: 'فرق إغلاق وردية',
    labelEn: 'Shift close variance',
    scope: 'tenant',
    variables: ['name', 'branch', 'date', 'variance'],
    descriptionAr: 'فرقٌ بين النقد المعدود والمتوقّع عند إغلاق الوردية.',
  },
  {
    event: 'subscription.created',
    labelAr: 'اشتراك جديد',
    labelEn: 'Subscription created',
    scope: 'platform',
    variables: ['name', 'plan', 'period_end', 'amount'],
    descriptionAr: 'ترخيص جديد لعلم عميل — يُرسل من المنصة لا من العميل.',
  },
  {
    event: 'subscription.renewed',
    labelAr: 'اشتراك متجدّد',
    labelEn: 'Subscription renewed',
    scope: 'platform',
    variables: ['name', 'plan', 'period_end', 'amount'],
    descriptionAr: 'تجديد فترة ترخيص.',
  },
  {
    event: 'subscription.expiring',
    labelAr: 'ترخيص قاربٌ على الانتهاء',
    labelEn: 'Subscription expiring',
    scope: 'platform',
    variables: ['name', 'plan', 'days', 'period_end'],
    descriptionAr: 'تنبيه قبل انتهاء الترخيص بعدد أيام.',
  },
  {
    event: 'subscription.payment_failed',
    labelAr: 'فشل دفع الاشتراك',
    labelEn: 'Subscription payment failed',
    scope: 'platform',
    variables: ['name', 'plan', 'amount', 'retry'],
    descriptionAr: 'فشل تحصيل اشتراك — مرشّحٌ مباشر لمتابعة P-C4.',
  },
  {
    event: 'activation.approved',
    labelAr: 'تفعيل مقبول',
    labelEn: 'Activation approved',
    scope: 'platform',
    variables: ['name', 'tenant', 'link'],
    descriptionAr: 'قبول طلب تفعيل منشأة.',
  },
  {
    event: 'activation.rejected',
    labelAr: 'تفعيل مرفوض',
    labelEn: 'Activation rejected',
    scope: 'platform',
    variables: ['name', 'tenant', 'reason'],
    descriptionAr: 'رفض طلب تفعيل — مع السبب المكتوب.',
  },
  {
    event: 'announcement',
    labelAr: 'إعلان',
    labelEn: 'Announcement',
    scope: 'platform',
    variables: ['name', 'title', 'body', 'link'],
    descriptionAr: 'رسالة إعلانية عامة — مصدرها P-C7.',
  },

  {
    event: 'signup.verify',
    labelAr: 'رمز تحقّق التسجيل',
    labelEn: 'Signup verification code',
    scope: 'platform',
    variables: ['name', 'company', 'code', 'expires'],
    descriptionAr: 'رمزٌ بالبريد يُثبت أن من بدأ التسجيل يملك العنوان (P-M4).',
  },

  {
    event: 'report.weekly',
    labelAr: 'التقرير الأسبوعي للمنصة',
    labelEn: 'Weekly platform report',
    scope: 'platform',
    variables: [
      'week',
      'tenants',
      'active',
      'trialing',
      'new_this_week',
      'churned_this_week',
      'mrr',
      'outstanding',
      'overdue',
      'trials_ending',
      'alerts',
      'link',
    ],
    descriptionAr: 'تقريرٌ أسبوعي بأرقام المنصة يُرسل إلى عناوين المشغّلين من شاشة الإعدادات.',
  },

  {
    event: 'campaign.message',
    labelAr: 'رسالة حملة بريدية',
    labelEn: 'Marketing campaign message',
    scope: 'platform',
    // بلا `name`: التحية تُبنى في **متن الحملة نفسه** (`{{name}}` في نصّ المشغّل)، والقالب
    // هنا ظرفٌ لا يخاطب أحداً باسمه — ولو أضاف تحيةً لَظهرت مرّتين (كشفه الاختبار الحيّ).
    variables: ['subject', 'body', 'unsubscribe_url'],
    descriptionAr:
      'رسالة حملةٍ بريدية (P-M7): النصوص تأتي من صفّ الحملة، والقالب ظرفٌ يضيف رابط إلغاء الاشتراك.',
  },
  {
    event: 'lead.received',
    labelAr: 'تأكيد استلام طلب',
    labelEn: 'Lead acknowledgement',
    scope: 'platform',
    variables: ['name', 'company', 'reference'],
    descriptionAr:
      'رسالةٌ إلى من ملأ استمارة التواصل أو طلب العرض: وصلنا طلبك، وهذا رقمه (P-M6).',
  },

  {
    event: 'subscriber.confirm',
    labelAr: 'تأكيد الاشتراك في النشرة',
    labelEn: 'Newsletter confirmation',
    scope: 'platform',
    // `name` مطلوبة كغيرها من الأحداث: هذا الفهرس عقدُ «كل حدثٍ يخاطب إنساناً باسمه»،
    // والنشرة تُخاطب مشتركاً بلا اسمٍ معلوم — فيُصيَّر بالبريد نفسه (`toName`).
    variables: ['name', 'email', 'link'],
    descriptionAr:
      'رابطُ التأكيد المزدوج للاشتراك في النشرة: لا يُضاف عنوانٌ إلى القائمة قبل أن يفتحه صاحبه (P-M6).',
  },
  {
    event: 'comment.mention',
    labelAr: 'إشارة في تعليق',
    labelEn: 'Comment mention',
    scope: 'tenant',
    variables: ['name', 'author', 'excerpt', 'link'],
    descriptionAr: 'زميلٌ أشار إليك في تعليق على مستند. الإشعار داخل التطبيق يُرسل حتى لو تعذر البريد.',
  },] as const;

const eventByKey = new Map(emailEventRegistry.map((entry) => [entry.event, entry]));

export function emailEventDefinition(event: EmailEvent): EmailEventDefinition {
  const definition = eventByKey.get(event);
  if (!definition) throw new Error(`Unknown email event '${event}'`);
  return definition;
}

export function isEmailEvent(value: string): value is EmailEvent {
  return eventByKey.has(value as EmailEvent);
}

/** متغيّرات في نصّ القالب على شكل `{{name}}` — بلا مسافاتٍ زائدة وبلا أقواسٍ متداخلة. */
export const EMAIL_VARIABLE_PATTERN = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

/** المتغيّرات المستعملة فعلاً في نصٍّ ما (بترتيب الظهور، بلا تكرار). */
export function emailVariablesIn(...parts: readonly string[]): string[] {
  const found: string[] = [];
  for (const part of parts) {
    for (const match of part.matchAll(EMAIL_VARIABLE_PATTERN)) {
      const name = (match[1] ?? '').toLowerCase();
      if (name && !found.includes(name)) found.push(name);
    }
  }
  return found;
}

/**
 * تصيير نصّ قالب — دالّة **نقيّة** (لا قاعدة، لا وقت، لا عشوائية) لتستعملها الخدمة
 * والاختبار والسكربت الحيّ بالنتيجة نفسها.
 *
 * متغيّرٌ ناقص **خطؤه صريح** (`400`): رسالةٌ تصل بنصّ `{{amount}}` أسوأ من رسالةٍ لا تصل،
 * لأن العميل يقرأ خطأنا ثم يتّصل. والمتغيّرات التي لا يعرفها الحدث تُرفض قبل الحفظ أيضاً.
 */
export function renderEmailTemplate(
  text: string,
  variables: Record<string, string | number | null | undefined>,
  event?: EmailEvent,
): string {
  const allowed = event ? new Set(emailEventDefinition(event).variables) : undefined;
  const missing: string[] = [];
  const rendered = text.replace(EMAIL_VARIABLE_PATTERN, (_match, rawName: string) => {
    const name = rawName.toLowerCase();
    if (allowed && !allowed.has(name)) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        `المتغيّر {{${name}}} ليس من متغيّرات هذا الحدث (${[...allowed].join(' · ')})`,
        400,
        { variable: name, event },
      );
    }
    const value = variables[name];
    if (value === undefined || value === null || value === '') {
      missing.push(name);
      return '';
    }
    return String(value);
  });
  if (missing.length > 0) {
    throw new DomainError(
      errorCodes.VALIDATION_FAILED,
      `متغيّرات ناقصة في القالب: ${[...new Set(missing)].map((name) => `{{${name}}}`).join(' · ')}`,
      400,
      { missing: [...new Set(missing)], event },
    );
  }
  return rendered;
}

/** قالبٌ افتراضي بلغة — المصدر الذي تُزرع منه الصفوف ويُرجَع إليه إن غاب الصفّ. */
export type EmailTemplateSeed = {
  readonly event: EmailEvent;
  readonly locale: EmailLocale;
  readonly subject: string;
  readonly body: string;
};

/**
 * النصوص الافتراضية. تُزرع في الجداول عند إقلاع الوحدة (insert idempotent) لأنها **نصٌّ
 * يتطوّر مع الكود**؛ ولو كانت في ملف الترحيل لتقادمت في أول تعديل. وتُقرأ كاحتياطٍ أخير إن
 * غاب الصفّ، فلا تُرسل رسالةٌ بلا نصّ أبداً.
 */
export const emailTemplateSeeds: readonly EmailTemplateSeed[] = [
  {
    event: 'signup.verify',
    locale: 'ar',
    subject: 'رمز التحقّق لتسجيل {{company}}',
    body: 'مرحباً {{name}},\n\nرمز التحقّق الخاص بك:\n{{code}}\n\nأدخله في صفحة التسجيل لإكمال إنشاء منشأة «{{company}}». الرمز صالح حتى {{expires}}.\n\nإن لم تبدأ تسجيلاً فتجاهل هذه الرسالة — لا يوجد حسابٌ بلا هذا الرمز.',
  },
  {
    event: 'signup.verify',
    locale: 'en',
    subject: 'Verification code for {{company}}',
    body: 'Hello {{name}},\n\nYour verification code:\n{{code}}\n\nEnter it on the signup page to finish creating “{{company}}”. The code is valid until {{expires}}.\n\nIf you did not start a signup, ignore this message — no account exists without this code.',
  },
  {
    event: 'lead.received',
    locale: 'ar',
    subject: 'وصلنا طلبك — {{reference}}',
    body: 'مرحباً {{name}},\n\nوصلنا طلبك من {{company}} وسيتواصل معك فريقنا في أقرب وقت.\nرقم الطلب: {{reference}}\n\nإن لم ترسل هذا الطلب فتجاهل الرسالة — لا حساب يُنشأ بلا موافقتك.',
  },
  {
    event: 'lead.received',
    locale: 'en',
    subject: 'We received your request — {{reference}}',
    body: 'Hello {{name}},\n\nWe received your request from {{company}} and our team will get back to you shortly.\nReference: {{reference}}\n\nIf you did not send this request, ignore this message — no account is created without you.',
  },
  {
    event: 'subscriber.confirm',
    locale: 'ar',
    subject: 'أكّد اشتراكك في النشرة',
    body: 'مرحباً {{name}},\n\nلتأكيد اشتراك {{email}} في نشرة المنصة افتح الرابط:\n{{link}}\n\nوإن لم تطلب الاشتراك فتجاهل الرسالة — لن نُرسل شيئاً إلى هذا العنوان بلا هذه الخطوة.',
  },
  {
    event: 'subscriber.confirm',
    locale: 'en',
    subject: 'Confirm your newsletter subscription',
    body: 'Hello {{name}},\n\nTo confirm {{email}} on the platform newsletter, open:\n{{link}}\n\nIf you did not ask to subscribe, ignore this message — nothing is sent to this address without this step.',
  },
  {
    event: 'user.invite',
    locale: 'ar',
    subject: 'دعوة للانضمام إلى {{tenant}}',
    body: 'مرحباً {{name}},\n\nدعاك فريق {{tenant}} للانضمام إلى النظام. لتفعيل حسابك افتح الرابط:\n{{link}}\n\nإن لم تكن تتوقّع هذه الرسالة فتجاهلها.',
  },
  {
    event: 'user.invite',
    locale: 'en',
    subject: 'You are invited to join {{tenant}}',
    body: 'Hello {{name}},\n\nThe {{tenant}} team invited you to join the system. Activate your account here:\n{{link}}\n\nIf you did not expect this message, ignore it.',
  },
  {
    event: 'password.reset',
    locale: 'ar',
    subject: 'استعادة كلمة المرور',
    body: 'مرحباً {{name}},\n\nلإعادة تعيين كلمة المرور افتح الرابط:\n{{link}}\n\nالرابط صالح حتى {{expires}}. إن لم تطلبه فتجاهل الرسالة — كلمة مرورك لم تتغيّر.',
  },
  {
    event: 'password.reset',
    locale: 'en',
    subject: 'Password reset',
    body: 'Hello {{name}},\n\nReset your password here:\n{{link}}\n\nThe link is valid until {{expires}}. If you did not ask for it, ignore this message — your password has not changed.',
  },
  {
    event: 'mfa.recovery',
    locale: 'ar',
    subject: 'رموز استرداد المصادقة الثنائية',
    body: 'مرحباً {{name}},\n\nرمز الاسترداد الجديد:\n{{code}}\n\nاحفظه في مكانٍ آمن، وكل رمزٍ يُستعمل مرة واحدة.',
  },
  {
    event: 'mfa.recovery',
    locale: 'en',
    subject: 'Two-factor recovery codes',
    body: 'Hello {{name}},\n\nYour recovery code:\n{{code}}\n\nKeep it somewhere safe; each code works once.',
  },
  {
    event: 'portal.access.grant',
    locale: 'ar',
    subject: 'وصولك إلى بوابة العملاء',
    body: 'مرحباً {{name}},\n\nمُنح لك وصول إلى البوابة. افتح الرابط:\n{{link}}\n\nالرابط صالح حتى {{expires}}.',
  },
  {
    event: 'portal.access.grant',
    locale: 'en',
    subject: 'Your customer portal access',
    body: 'Hello {{name}},\n\nYou were granted portal access. Open this link:\n{{link}}\n\nThe link is valid until {{expires}}.',
  },
  {
    event: 'invoice.created',
    locale: 'ar',
    subject: 'فاتورة {{invoice_no}}',
    body: 'مرحباً {{name}},\n\nصدرت فاتورتك رقم {{invoice_no}} بمبلغ {{amount}}، وتستحق في {{due}}.\n\nشكراً لتعاملك معنا.',
  },
  {
    event: 'invoice.created',
    locale: 'en',
    subject: 'Invoice {{invoice_no}}',
    body: 'Hello {{name}},\n\nInvoice {{invoice_no}} was issued for {{amount}}, due {{due}}.\n\nThank you.',
  },
  {
    event: 'payment.received',
    locale: 'ar',
    subject: 'استلمنا دفعتك — {{invoice_no}}',
    body: 'مرحباً {{name}},\n\nاستلمنا دفعة بمبلغ {{amount}} على الفاتورة {{invoice_no}}. شكراً لك.',
  },
  {
    event: 'payment.received',
    locale: 'en',
    subject: 'Payment received — {{invoice_no}}',
    body: 'Hello {{name}},\n\nWe received a payment of {{amount}} for invoice {{invoice_no}}. Thank you.',
  },
  {
    event: 'statement.ready',
    locale: 'ar',
    subject: 'كشف حساب {{period}} جاهز',
    body: 'مرحباً {{name}},\n\nكشف حساب الفترة {{period}} جاهز للتنزيل:\n{{link}}',
  },
  {
    event: 'statement.ready',
    locale: 'en',
    subject: 'Statement for {{period}} is ready',
    body: 'Hello {{name}},\n\nThe statement for {{period}} is ready to download:\n{{link}}',
  },
  {
    event: 'einvoice.rejected',
    locale: 'ar',
    subject: 'لم تُقبل الفاتورة {{invoice_no}} في زاتكا',
    body: 'مرحباً {{name}},\n\nفشل إرسال الفاتورة {{invoice_no}} إلى زاتكا.\nالسبب: {{reason}}\n\nراجع بيانات الفاتورة ثم أعد الإرسال.',
  },
  {
    event: 'einvoice.rejected',
    locale: 'en',
    subject: 'Invoice {{invoice_no}} was not accepted by ZATCA',
    body: 'Hello {{name}},\n\nInvoice {{invoice_no}} failed to reach ZATCA.\nReason: {{reason}}\n\nReview the invoice and retry.',
  },
  {
    event: 'stock.below_min',
    locale: 'ar',
    subject: 'المخزون تحت الحدّ: {{item}}',
    body: 'مرحباً {{name}},\n\nالصنف {{item}} نزل إلى {{on_hand}} والحدّ الأدنى {{min}}.\n\nيُنصح بإعادة الطلب.',
  },
  {
    event: 'stock.below_min',
    locale: 'en',
    subject: 'Stock below minimum: {{item}}',
    body: 'Hello {{name}},\n\nItem {{item}} is at {{on_hand}}, below the minimum of {{min}}.\n\nConsider replenishing.',
  },
  {
    event: 'shift.close.variance',
    locale: 'ar',
    subject: 'فرق إغلاق وردية {{branch}}',
    body: 'مرحباً {{name}},\n\nأُغلقت وردية {{branch}} بتاريخ {{date}} بفرق {{variance}}.\n\nراجع حركات الصندوق.',
  },
  {
    event: 'shift.close.variance',
    locale: 'en',
    subject: 'Shift close variance — {{branch}}',
    body: 'Hello {{name}},\n\nShift {{branch}} closed on {{date}} with a variance of {{variance}}.\n\nReview the cash movements.',
  },
  {
    event: 'subscription.created',
    locale: 'ar',
    subject: 'ترخيصك على باقة {{plan}}',
    body: 'مرحباً {{name}},\n\nفُعّل ترخيصك على باقة {{plan}} حتى {{period_end}} بمبلغ {{amount}}.\n\nشكراً لثقتك.',
  },
  {
    event: 'subscription.created',
    locale: 'en',
    subject: 'Your {{plan}} licence',
    body: 'Hello {{name}},\n\nYour {{plan}} licence is active until {{period_end}} for {{amount}}.\n\nThank you.',
  },
  {
    event: 'subscription.renewed',
    locale: 'ar',
    subject: 'تم تجديد اشتراكك — {{plan}}',
    body: 'مرحباً {{name}},\n\nجُدّد اشتراكك على باقة {{plan}} حتى {{period_end}} بمبلغ {{amount}}.',
  },
  {
    event: 'subscription.renewed',
    locale: 'en',
    subject: 'Subscription renewed — {{plan}}',
    body: 'Hello {{name}},\n\nYour {{plan}} subscription is renewed until {{period_end}} for {{amount}}.',
  },
  {
    event: 'subscription.expiring',
    locale: 'ar',
    subject: 'اشتراكك ينتهي بعد {{days}} يوماً',
    body: 'مرحباً {{name}},\n\nينتهي اشتراكك على باقة {{plan}} في {{period_end}} (بعد {{days}} يوماً).\n\nجدّد مبكراً لتجنّب توقّف الخدمة.',
  },
  {
    event: 'subscription.expiring',
    locale: 'en',
    subject: 'Your subscription ends in {{days}} days',
    body: 'Hello {{name}},\n\nYour {{plan}} subscription ends on {{period_end}} (in {{days}} days).\n\nRenew early to avoid interruption.',
  },
  {
    event: 'subscription.payment_failed',
    locale: 'ar',
    subject: 'تعذّر تحصيل اشتراكك',
    body: 'مرحباً {{name}},\n\nتعذّر تحصيل مبلغ {{amount}} لباقة {{plan}}. سنعيد المحاولة {{retry}}.\n\nإن كان للبطاقة مشكلة فحدّثها من لوحة الدفع.',
  },
  {
    event: 'subscription.payment_failed',
    locale: 'en',
    subject: 'We could not charge your subscription',
    body: 'Hello {{name}},\n\nThe charge of {{amount}} for {{plan}} failed. We will retry {{retry}}.\n\nUpdate your payment method if the card has an issue.',
  },
  {
    event: 'activation.approved',
    locale: 'ar',
    subject: 'تم قبول تفعيل {{tenant}}',
    body: 'مرحباً {{name}},\n\nقُبل طلب تفعيل منشأة {{tenant}}. ابدأ من هنا:\n{{link}}',
  },
  {
    event: 'activation.approved',
    locale: 'en',
    subject: 'Activation approved for {{tenant}}',
    body: 'Hello {{name}},\n\nActivation for {{tenant}} was approved. Start here:\n{{link}}',
  },
  {
    event: 'activation.rejected',
    locale: 'ar',
    subject: 'لم يُقبل طلب تفعيل {{tenant}}',
    body: 'مرحباً {{name}},\n\nلم يُقبل طلب تفعيل منشأة {{tenant}}.\nالسبب: {{reason}}\n\nيمكنك تصحيح البيانات وإعادة الطلب.',
  },
  {
    event: 'activation.rejected',
    locale: 'en',
    subject: 'Activation rejected for {{tenant}}',
    body: 'Hello {{name}},\n\nActivation for {{tenant}} was rejected.\nReason: {{reason}}\n\nYou can correct the details and apply again.',
  },
  {
    event: 'announcement',
    locale: 'ar',
    subject: '{{title}}',
    body: 'مرحباً {{name}},\n\n{{body}}\n\n{{link}}',
  },
  {
    event: 'announcement',
    locale: 'en',
    subject: '{{title}}',
    body: 'Hello {{name}},\n\n{{body}}\n\n{{link}}',
  },

  {
    event: 'campaign.message',
    locale: 'ar',
    subject: '{{subject}}',
    body: '{{body}}\n\n—\nلإلغاء الاشتراك بنقرة واحدة: {{unsubscribe_url}}',
  },
  {
    event: 'campaign.message',
    locale: 'en',
    subject: '{{subject}}',
    body: '{{body}}\n\n—\nUnsubscribe with one click: {{unsubscribe_url}}',
  },
  {
    event: 'report.weekly',
    locale: 'ar',
    subject: 'تقرير المنصة — أسبوع {{week}}',
    body: 'مرحباً،\n\nحصيلة الأسبوع {{week}}:\n• المنشآت: {{tenants}} (نشطة {{active}} · تجريبية {{trialing}})\n• انضمّ {{new_this_week}} وغادر {{churned_this_week}}\n• الإيراد الشهري المتكرّر: {{mrr}}\n• مستحقّ: {{outstanding}} — منه متأخّر: {{overdue}}\n• تجارب تنتهي خلال أسبوع: {{trials_ending}}\n\nتنبيهات تحتاج قراراً:\n{{alerts}}\n\nالتفاصيل: {{link}}',
  },
  {
    event: 'report.weekly',
    locale: 'en',
    subject: 'Platform report — week of {{week}}',
    body: 'Hello,\n\nThe week of {{week}}:\n• Tenants: {{tenants}} (active {{active}} · trialing {{trialing}})\n• Joined {{new_this_week}}, churned {{churned_this_week}}\n• MRR: {{mrr}}\n• Outstanding: {{outstanding}} — overdue: {{overdue}}\n• Trials ending within a week: {{trials_ending}}\n\nAlerts needing a decision:\n{{alerts}}\n\nDetails: {{link}}',
  },
  {
    event: 'comment.mention',
    locale: 'ar',
    subject: '{{author}} أشار إليك في تعليق',
    body: 'مرحباً {{name}},\n\nأشار إليك {{author}} في تعليق:\n{{excerpt}}\n\nافتح المستند:\n{{link}}',
  },
  {
    event: 'comment.mention',
    locale: 'en',
    subject: '{{author}} mentioned you in a comment',
    body: 'Hello {{name}},\n\n{{author}} mentioned you in a comment:\n{{excerpt}}\n\nOpen the document:\n{{link}}',
  },] as const;

export function emailTemplateSeed(event: EmailEvent, locale: EmailLocale): EmailTemplateSeed | undefined {
  return emailTemplateSeeds.find((seed) => seed.event === event && seed.locale === locale);
}

// ══════════════════════════════════════════════════════ الأشكال

export const emailTemplateSchema = z.object({
  id: uuidSchema.nullable(),
  /** `null` = قالب المنصة؛ و`tenantId` = تجاوزٌ كتبه العميل. */
  tenantId: uuidSchema.nullable(),
  event: z.enum(emailEvents),
  labelAr: z.string(),
  locale: z.enum(emailLocales),
  subject: z.string(),
  body: z.string(),
  version: z.number().int().positive(),
  /** `platform` (الصفّ العام) أو `tenant` (تجاوز المستأجر) أو `seed` (لم يُحفظ بعد). */
  source: z.enum(['platform', 'tenant', 'seed']),
  variables: z.array(z.string()),
  missingVariables: z.array(z.string()),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});
export type EmailTemplate = z.infer<typeof emailTemplateSchema>;

export const emailTemplateListResponseSchema = z.object({
  data: z.array(emailTemplateSchema),
  meta: z.record(z.unknown()),
});
export type EmailTemplateListResponse = z.infer<typeof emailTemplateListResponseSchema>;

/** تحرير نصّ المنصة: النصّان مقصودان معاً، ومتغيّرٌ خارج فهرس الحدث يُرفض. */
export const emailTemplateUpdateSchema = z
  .object({
    subject: z.string().trim().min(1).max(300),
    body: z.string().trim().min(1).max(20_000),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export type EmailTemplateUpdate = z.infer<typeof emailTemplateUpdateSchema>;

/**
 * إنشاء قالب: النصّان + الحدث واللغة، و`tenantId` عند إنشاء تجاوزٍ لعميل بعينه.
 * والمفتاح `(event, locale, tenantId)` فريد — فالمكرّر يُرفض بـ422 لا يُحدَّث صامتاً.
 */
export const emailTemplateCreateSchema = emailTemplateUpdateSchema.extend({
  event: emailEventSchema,
  locale: emailLocaleSchema.default('ar'),
  tenantId: uuidSchema.nullable().optional(),
});
export type EmailTemplateCreate = z.infer<typeof emailTemplateCreateSchema>;

/** سبب إعادة المحاولة اليدوية: يُسجَّل في التدقيق — وبلا سببٍ لا يُعرف لماذا أُعيدت. */
export const emailRetrySchema = z
  .object({
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export type EmailRetry = z.infer<typeof emailRetrySchema>;

/**
 * تجاوز المستأجر: **النصّ وحده** (نفس ما تقوله الخطة) — لا الحدث ولا اللغة ولا الحالة.
 * و`null` في حقلٍ يعني «أعِد نصّ المنصة لذلك الحقل» (إزالة التجاوز الجزئي).
 */
export const tenantEmailTemplateUpdateSchema = z
  .object({
    subject: z.string().trim().min(1).max(300).nullable().optional(),
    body: z.string().trim().min(1).max(20_000).nullable().optional(),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict()
  .refine((value) => value.subject !== undefined || value.body !== undefined, {
    message: 'لا شيء للتعديل',
  });
export type TenantEmailTemplateUpdate = z.infer<typeof tenantEmailTemplateUpdateSchema>;

export const emailMessageSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema.nullable(),
  tenantCode: z.string().nullable(),
  event: z.enum(emailEvents),
  eventLabelAr: z.string(),
  locale: z.enum(emailLocales),
  toEmail: z.string(),
  toName: z.string().nullable(),
  subject: z.string(),
  status: z.enum(emailMessageStatuses),
  provider: z.string(),
  deliveryMode: z.enum(['queue', 'inline']),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  providerMessageId: z.string().nullable(),
  queuedAt: z.string(),
  sentAt: z.string().nullable(),
  createdAt: z.string(),
  /** رسالة اختبارٍ من الشاشة — تُعرض بشارة، ولا تُحتسب على العميل. */
  isTest: z.boolean(),
});
export type EmailMessage = z.infer<typeof emailMessageSchema>;

export const emailMessageListQuerySchema = z.object({
  tenantId: uuidSchema.optional(),
  event: z.enum(emailEvents).optional(),
  status: z.enum(emailMessageStatuses).optional(),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type EmailMessageListQuery = z.infer<typeof emailMessageListQuerySchema>;

export const emailMessageListResponseSchema = z.object({
  data: z.array(emailMessageSchema),
  meta: z.object({ total: z.number().int(), limit: z.number().int(), offset: z.number().int() }),
  counts: z.record(z.number().int()),
});
export type EmailMessageListResponse = z.infer<typeof emailMessageListResponseSchema>;

export const emailSuppressionSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema.nullable(),
  email: z.string(),
  reason: z.enum(emailSuppressionReasons),
  note: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
});
export type EmailSuppression = z.infer<typeof emailSuppressionSchema>;

export const emailSuppressionCreateSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(253),
    reason: z.enum(emailSuppressionReasons),
    tenantId: uuidSchema.nullable().optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type EmailSuppressionCreate = z.infer<typeof emailSuppressionCreateSchema>;

/**
 * إعدادات البريد — صفٌّ عام (`tenantId: null`) وصفٌّ لكل عميل يتجاوز المُرسِل.
 * والمزوّد اختيارٌ من الشاشة (بلا إعادة نشر)؛ أما اعتمادات SMTP نفسها ففي البيئة (§3 من التقرير).
 */
export const emailSettingsSchema = z.object({
  tenantId: uuidSchema.nullable(),
  /** المزوّد الذي سيُرسَل به فعلاً: اختيارُ الشاشة، وأوّل قراءةٍ ترث `MAIL_TRANSPORT`. */
  provider: z.enum(emailProviders),
  fromName: z.string(),
  fromEmail: z.string(),
  replyTo: z.string().nullable(),
  sendingDomain: z.string().nullable(),
  dailyLimit: z.number().int().positive().nullable(),
  monthlyLimit: z.number().int().positive().nullable(),
  smtpHost: z.string().nullable(),
  smtpPort: z.number().int().nullable().optional(),
  smtpUser: z.string().nullable().optional(),
  smtpSecure: z.boolean().optional(),
  smtpConfigured: z.boolean(),
  apiKeyMasked: z.string().nullable().optional(),
  apiEndpoint: z.string().nullable().optional(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});
export type EmailSettings = z.infer<typeof emailSettingsSchema>;

/** الحقول القابلة للتحرير: `reason` وحده ليس تعديلاً. */
export const emailSettingsPatchKeys = [
  'provider',
  'fromName',
  'fromEmail',
  'replyTo',
  'sendingDomain',
  'dailyLimit',
  'monthlyLimit',
  'apiKey',
  'apiEndpoint',
  'smtpHost',
  'smtpPort',
  'smtpUser',
  'smtpPassword',
  'smtpSecure',
] as const;

export const emailSettingsUpdateSchema = z
  .object({
    provider: emailProviderSchema.optional(),
    fromName: z.string().trim().min(1).max(120).optional(),
    fromEmail: z.string().trim().toLowerCase().email().max(253).optional(),
    replyTo: z.string().trim().toLowerCase().email().max(253).nullable().optional(),
    sendingDomain: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'نطاق غير صالح')
      .max(253)
      .nullable()
      .optional(),
    dailyLimit: z.coerce.number().int().min(1).max(100_000).nullable().optional(),
    monthlyLimit: z.coerce.number().int().min(1).max(2_000_000).nullable().optional(),
    apiKey: z.string().trim().max(500).nullable().optional(),
    apiEndpoint: z.string().trim().url('رابط API غير صالح').max(500).nullable().optional(),
    smtpHost: z.string().trim().max(253).nullable().optional(),
    smtpPort: z.coerce.number().int().min(1).max(65535).nullable().optional(),
    smtpUser: z.string().trim().max(253).nullable().optional(),
    smtpPassword: z.string().max(500).nullable().optional(),
    smtpSecure: z.boolean().optional(),
    /**
     * سبب التعديل — `null` يعني «ارث من المنصة» في الحقول الاختيارية، فالسقف يُرفع بتعديلٍ
     * صريح ويُسجَّل في التدقيق. اختياريّ هنا (الفرق قبل/بعد يقول ما تغيّر)، ومطلوب في تحرير
     * نصّ قالب (`emailTemplateUpdateSchema`) لأن نصّاً يراه العميل يحتاج تعليلاً مكتوباً.
     */
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict()
  .refine((value) => emailSettingsPatchKeys.some((key) => value[key] !== undefined), {
    message: 'لا شيء للتعديل',
  });
export type EmailSettingsUpdate = z.infer<typeof emailSettingsUpdateSchema>;

/** `POST /platform/email/templates/:id/test` و`POST /platform/email/settings/test`. */
export const emailTestSendSchema = z
  .object({
    to: z.string().trim().toLowerCase().email().max(253),
    locale: z.enum(emailLocales).default('ar'),
    /** متغيّراتٌ تجريبية لمعاينة قالب بحالةٍ واقعية. */
    variables: z.record(z.union([z.string(), z.number()])).default({}),
  })
  .strict();
export type EmailTestSend = z.infer<typeof emailTestSendSchema>;

export const emailSendInputSchema = z
  .object({
    event: z.enum(emailEvents),
    to: z.string().trim().toLowerCase().email().max(253),
    toName: z.string().trim().max(120).optional(),
    locale: z.enum(emailLocales).default('ar'),
    variables: z.record(z.union([z.string(), z.number()])).default({}),
    /** متى يُحاول أول مرة — يُستعمل للجدولة (تقرير أسبوعي لاحقاً). */
    sendAt: z.string().optional(),
  })
  .strict();
export type EmailSendInput = z.infer<typeof emailSendInputSchema>;

export const emailSendResultSchema = z.object({
  id: uuidSchema,
  status: z.enum(emailMessageStatuses),
  deliveryMode: z.enum(['queue', 'inline']),
  subject: z.string(),
});
export type EmailSendResult = z.infer<typeof emailSendResultSchema>;

/** استجابة فحص الاتصال: يذكر المزوّد الحقيقي ووجهة الرسالة، ولا يكشف اعتماداً. */
export const emailTestResultSchema = z.object({
  messageId: uuidSchema,
  provider: z.enum(emailProviders),
  to: z.string(),
  subject: z.string(),
  deliveredAt: z.string().nullable(),
  status: z.enum(emailMessageStatuses),
  /** إن مُنع الإرسال بالحجر: السبب — إذ لا يُبتلع سبب الفشل في اختبار الاتصال. */
  suppressionReason: z.enum(emailSuppressionReasons).nullable(),
});
export type EmailTestResult = z.infer<typeof emailTestResultSchema>;

/** أفعال التدقيق التي يكتبها هذا الجزء — تُرشَّح بها شاشة التدقيق. */
export const emailAuditActions = {
  templateUpdate: 'email.template_update',
  templateReset: 'email.template_reset',
  tenantTemplateUpdate: 'email.tenant_template_update',
  settingsUpdate: 'email.settings_update',
  tenantSettingsUpdate: 'email.tenant_settings_update',
  messageQueued: 'email.message_queued',
  messageSent: 'email.message_sent',
  messageFailed: 'email.message_failed',
  messageRetry: 'email.message_retry',
  messageSuppressed: 'email.message_suppressed',
  suppressionAdd: 'email.suppression_add',
  suppressionRemove: 'email.suppression_remove',
} as const;
