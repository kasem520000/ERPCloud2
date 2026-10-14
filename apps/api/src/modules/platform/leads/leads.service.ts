import { randomBytes, createHash } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  DomainError,
  errorCodes,
  isHoneypotFilled,
  isLeadClosed,
  leadDedupeKey,
  leadAuditActions,
  leadDisplayName,
  defaultPlatformSettingValue,
  leadSourceLabelsAr,
  leadStatusLabelsAr,
  leadTransitionAllowed,
  normalizeLeadEmail,
  type LeadAccepted,
  type LeadConvert,
  type LeadCreate,
  type LeadEventView,
  type LeadNoteCreate,
  type LeadNoteView,
  type LeadPatch,
  type LeadListQuery,
  type LeadSource,
  type LeadStatus,
  type LeadView,
  type ListEnvelope,
  type SubscriberAccepted,
  type SubscriberCreate,
  type SubscriberStatus,
  subscriberStatusLabelsAr,
  type SubscriberListQuery,
  type SubscriberView,
  type Utm,
} from '@erp/contracts';
import {
  newId,
  withPlatformAdminTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.tokens.js';
import { getAuthContext, tryGetAuthContext } from '../../../request-context/request-context.js';
import { EmailService } from '../../email/email.service.js';
import { OrgProvisioningService } from '../../organization/provisioning/org-provisioning.service.js';
import { PlatformAdminService } from '../admin/platform-admin.service.js';
import { PlatformBillingService } from '../admin/platform-billing.service.js';
import { AuditService } from '../../platform-services/audit/audit.service.js';

/**
 * P-M6 — «التقاط العملاء المتوقّعين وإدارتهم» (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * **الطابور هنا، والعقد في `@erp/contracts`**: الحالات والانتقالات والتطبيع والمصيدة تقيسها
 * اختبارات العقد بلا قاعدة، وهذه الخدمة تنفّذها على صفوف.
 *
 * وأربعة قرارات تحكم هذا الملف:
 *
 *   1. **لا يضيع زائر**: الاستمارة تُخزَّن أوّلاً، ثم يُحاول البريد — وإخفاق البريد لا يُسقط
 *      الطلب (الطلب أغلى من الرسالة). وعنوانٌ يعود ثانياً **لا يُكرَّر صفّاً**: تُلحَق رسالته
 *      ملاحظةً على الطلب القائم، ويُسجَّل ذلك أثراً.
 *   2. **الردّ صامت**: المصيدة والعنوان المرفوض يُقابَلان بـ202 والأثر يُسجَّل في السجل
 *      (logger) لا في الاستجابة — إخبارُ الآلة بأنها كُشِفت دعوةٌ لتجربةٍ أخرى.
 *   3. **التحويل فعلٌ صريح**: ينشئ المنشأة والمدير ودليل الحسابات، ويمنح **تجربةً من إعداد
 *      المنصّة** (`billing.trial_days`) لا من رقمٍ في الكود، ويترك الطلب `won` بمنشأته.
 *      وبيانات الدخول تُعاد **مرةً واحدة**: لا تُخزَّن، ولا تُرسل بالبريد، فيجب أن يراها من
 *      وقّع التحويل.
 *   4. **النشرة تأكيدٌ مزدوج**: لا يُضاف عنوانٌ إلى القائمة إلا بفتح رابطٍ وُلد لحظة الطلب
 *      وخُزِّن **مُجزَّأً** (sha256) — كرمز التسجيل في P-M4 تماماً.
 */
@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly admin: PlatformAdminService,
    private readonly billing: PlatformBillingService,
    private readonly provisioning: OrgProvisioningService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
  ) {}

  // ═══════════════════════════════════════════════════ ١ · الالتقاط العام

  /**
   * `POST /public/leads` — استمارة تواصلٍ أو طلب عرض.
   *
   * المصيدة تُفحَص **قبل أي كتابة**: طلبٌ آليٌّ لا يُنشئ صفّاً، ولا يُرسَل له بريد، ويُقابَل
   * بجوابٍ ناجحٍ ظاهرياً. والمصدر لا يُقبل من الإنترنت إلا من قائمة المصادر العامّة
   * (`form` · `demo` · `newsletter`) — وإلا لكتب ماسحٌ طلباً بوسم «مباشر» يخدع به التقارير.
   */
  async capture(input: LeadCreate): Promise<LeadAccepted> {
    if (isHoneypotFilled(input as unknown as Record<string, unknown>)) {
      this.logger.warn(`lead form rejected by honeypot from ${normalizeLeadEmail(input.email)}`);
      return { received: true, reference: 'L-00000000' };
    }

    const email = normalizeLeadEmail(input.email);
    // المصدر من الباب لا من الزائر: الطلب الواصل إلى `/public/leads` هو `form` أو `demo`،
    // وما عداهما (حملة · مباشر) يُكتب من اللوحة أو من مزامنةٍ لا من استمارةٍ عامّة.
    const source: LeadSource = input.source === 'demo' ? 'demo' : 'form';
    // المعرّف والمرجع معاً: المرجع يُشتقّ من المعرّف نفسه، فلا مولّدَ ثانياً ولا تصادم.
    const id = newId();
    const reference = referenceFor(id);
    const utm = (input.utm ?? null) as Utm | null;

    const created = await withPlatformAdminTx(this.database.db, async (tx) => {
      // `ON CONFLICT DO NOTHING` ثم القراءة: العنوان نفسه لا يُنشئ طلباً ثانياً، لكن الرسالة
      // الجديدة لا تُهمَل — تُلحَق ملاحظةً على الطلب القائم (وانظر الفرع أدناه).
      const inserted = await tx.execute(sql`
        INSERT INTO leads (
          id, reference, full_name, company_name, email, dedupe_key, phone, branch_count,
          plan_interest, message, source, locale, accepts_marketing, utm
        ) VALUES (
          ${id}, ${reference}, ${input.fullName.trim()}, ${input.companyName?.trim() ?? null},
          ${email}, ${leadDedupeKey(email)}, ${input.phone?.trim() ?? null},
          ${input.branchCount ?? null}, ${input.planInterest?.trim() ?? null}, ${input.message.trim()},
          ${source}, ${input.locale}, ${input.acceptsMarketing}, ${utm === null ? null : JSON.stringify(utm)}::jsonb
        )
        ON CONFLICT (dedupe_key) DO NOTHING
        RETURNING id, reference
      `);

      const row = inserted.rows[0] as { id: string; reference: string } | undefined;
      if (row) {
        await this.event(tx, String(row.id), 'lead.created', `طلبٌ جديد من ${source}`, null, null, {
          source,
          utm,
        });
        return { id: String(row.id), reference: String(row.reference), duplicated: false };
      }

      const existing = (await tx.execute(sql`
        SELECT id, reference FROM leads WHERE dedupe_key = ${leadDedupeKey(email)} LIMIT 1
      `)) as unknown as { rows: Array<{ id: string; reference: string }> };
      const found = existing.rows[0];
      if (!found) {
        // لا يمكن أن يقع: القيد الفريد رفض الإدراج، فالطلب قائم بالضرورة.
        throw new DomainError(errorCodes.INTERNAL, 'تعذّر تسجيل الطلب', 500);
      }
      await tx.execute(sql`
        INSERT INTO lead_notes (id, lead_id, body, author_label)
        VALUES (${newId()}, ${String(found.id)},
                ${`طلبٌ ثانٍ من الموقع: ${input.message.trim()}`}, 'الموقع')
      `);
      await this.event(
        tx,
        String(found.id),
        'lead.duplicated',
        'وصل طلبٌ ثانٍ من العنوان نفسه فأُلحق ملاحظةً',
        null,
        null,
        { source, utm },
      );
      return { id: String(found.id), reference: String(found.reference), duplicated: true };
    });

    if (!created.duplicated) {
      await this.acknowledgeLead({
        email,
        name: leadDisplayName(input),
        company: input.companyName?.trim() ?? '',
        reference: created.reference,
        locale: input.locale,
      });
    }

    return { received: true, reference: created.reference };
  }

  /**
   * `POST /public/subscribe` — النشرة البريدية.
   *
   * والجواب **لا يكشف** هل العنوان مشتركٌ من قبل: `pending` للجديد، و`confirmed` إن كان
   * مؤكَّداً سابقاً، **ونفس الرسالة** في الحالتين — فلا يتحوّل حقلُ اشتراكٍ إلى أداة تحقّقٍ
   * من العناوين (وهو درس 404 الموحّد في P-M4، معاداً هنا).
   */
  async subscribe(input: SubscriberCreate): Promise<SubscriberAccepted> {
    if (isHoneypotFilled(input as unknown as Record<string, unknown>)) {
      this.logger.warn(`subscribe form rejected by honeypot from ${normalizeLeadEmail(input.email)}`);
      return { received: true, status: 'pending' };
    }

    const email = normalizeLeadEmail(input.email);
    const token = randomBytes(24).toString('hex');
    const utm = (input.utm ?? null) as Utm | null;

    const outcome = await withPlatformAdminTx(this.database.db, async (tx) => {
      const existing = (await tx.execute(sql`
        SELECT id, status FROM email_subscribers WHERE dedupe_key = ${leadDedupeKey(email)} LIMIT 1
      `)) as unknown as { rows: Array<{ id: string; status: SubscriberStatus }> };
      const found = existing.rows[0];

      if (found?.status === 'confirmed') {
        // مؤكَّدٌ من قبل: لا رسالة تأكيدٍ ثانية (إزعاجٌ بلا سبب)، والجواب يقول الحقيقة.
        return { id: String(found.id), status: 'confirmed' as SubscriberStatus, send: false };
      }

      if (found) {
        // `pending` أو `unsubscribed`: رمزٌ جديد يعيد الطلب إلى أوّل الطريق.
        await tx.execute(sql`
          UPDATE email_subscribers
             SET status = 'pending', confirm_token_hash = ${digest(token)},
                 confirm_sent_at = now(), unsubscribed_at = NULL, locale = ${input.locale},
                 source = ${input.source}, utm = ${utm === null ? null : JSON.stringify(utm)}::jsonb,
                 updated_at = now()
           WHERE id = ${String(found.id)}
        `);
        return { id: String(found.id), status: 'pending' as SubscriberStatus, send: true };
      }

      const id = newId();
      await tx.execute(sql`
        INSERT INTO email_subscribers (
          id, email, dedupe_key, status, locale, source, confirm_token_hash, confirm_sent_at, utm
        ) VALUES (
          ${id}, ${email}, ${leadDedupeKey(email)}, 'pending', ${input.locale}, ${input.source},
          ${digest(token)}, now(), ${utm === null ? null : JSON.stringify(utm)}::jsonb
        )
      `);
      return { id, status: 'pending' as SubscriberStatus, send: true };
    });

    if (outcome.send) {
      await this.sendConfirmLink({ email, token, locale: input.locale });
    }
    return { received: true, status: outcome.status };
  }

  /**
   * `GET /public/subscribe/confirm/:token` — فتح الرابط يُؤكّد.
   *
   * والرمز مُجزَّأٌ في القاعدة: لا يُقرأ منها، بل يُجزَّأ الواصل ويُقابَل — ولا يُعاد في
   * الاستجابة. والتأكيد **idempotent**: فتحُ الرابط مرّتين لا يغيّر شيئاً ولا يخطئ.
   */
  async confirmSubscription(token: string): Promise<{ email: string; status: SubscriberStatus }> {
    const outcome = await withPlatformAdminTx(this.database.db, async (tx) => {
      const found = (await tx.execute(sql`
        SELECT id, email, status FROM email_subscribers
         WHERE confirm_token_hash = ${digest(token)} LIMIT 1
      `)) as unknown as { rows: Array<{ id: string; email: string; status: SubscriberStatus }> };
      const row = found.rows[0];
      if (!row) {
        throw new DomainError(
          errorCodes.NOT_FOUND,
          'رابط التأكيد غير معروف أو استُبدل بغيره. اطلب اشتراكاً جديداً من الموقع.',
          404,
        );
      }
      if (row.status === 'confirmed') {
        return { email: String(row.email), status: 'confirmed' as SubscriberStatus, fresh: false };
      }
      await tx.execute(sql`
        UPDATE email_subscribers SET status = 'confirmed', confirmed_at = now(), updated_at = now()
         WHERE id = ${String(row.id)}
      `);
      return { email: String(row.email), status: 'confirmed' as SubscriberStatus, fresh: true };
    });

    if (outcome.fresh) {
      this.logger.log(`newsletter subscription confirmed for ${outcome.email}`);
    }
    return { email: outcome.email, status: outcome.status };
  }

  // ═══════════════════════════════════════════════════ ٢ · الطابور في اللوحة

  /** `GET /platform/leads` — الطابور بترشيح الحالة والمصدر والإسناد والبحث، وبعددٍ لكل حالة. */
  async list(
    query: LeadListQuery & { mine?: boolean },
  ): Promise<ListEnvelope<LeadView> & { counts: Record<LeadStatus, number>; unassigned: number }> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = Math.max(query.offset ?? 0, 0);
    const search = query.q?.trim() ? `%${query.q.trim().toLowerCase()}%` : null;
    // «طلباتي» تُقرأ من الرمز لا من معامل: من يقلّد معرّف غيره لا يصير مندوباً عليه.
    const mine = query.mine ? (tryGetAuthContext()?.userId ?? null) : null;

    return withPlatformAdminTx(this.database.db, async (tx) => {
      const filters = sql`
        WHERE (${query.status ?? null}::text IS NULL OR l.status = ${query.status ?? null})
          AND (${query.source ?? null}::text IS NULL OR l.source = ${query.source ?? null})
          AND (${query.assignedTo ?? null}::uuid IS NULL OR l.assigned_to = ${query.assignedTo ?? null}::uuid)
          AND (${query.unassigned ?? false} = false OR l.assigned_to IS NULL)
          AND (${mine}::uuid IS NULL OR l.assigned_to = ${mine}::uuid)
          AND (${search}::text IS NULL
               OR lower(l.full_name) LIKE ${search}
               OR lower(coalesce(l.company_name, '')) LIKE ${search}
               OR lower(l.email) LIKE ${search}
               OR upper(l.reference) LIKE upper(${search}))
      `;

      const rows = (await tx.execute(sql`
        SELECT l.*, u.full_name AS assignee_name, t.code AS converted_tenant_code
          FROM leads l
          LEFT JOIN users u ON u.id = l.assigned_to
          LEFT JOIN tenants t ON t.id = l.converted_tenant_id
          ${filters}
         ORDER BY
           -- المفتوح أوّلاً: الطابور أداةُ عملٍ لا أرشيف، والجديد في رأسه.
           CASE l.status WHEN 'new' THEN 0 WHEN 'contacted' THEN 1 WHEN 'qualified' THEN 2 ELSE 3 END,
           l.created_at DESC
         LIMIT ${limit} OFFSET ${offset}
      `)) as unknown as { rows: Array<Record<string, unknown>> };

      const totals = (await tx.execute(sql`
        SELECT count(*)::int AS total FROM leads l ${filters}
      `)) as unknown as { rows: Array<{ total: number }> };

      const counts = (await tx.execute(sql`
        SELECT status, count(*)::int AS n, count(*) FILTER (WHERE assigned_to IS NULL)::int AS unassigned
          FROM leads GROUP BY status
      `)) as unknown as { rows: Array<{ status: LeadStatus; n: number; unassigned: number }> };

      const perStatus: Record<LeadStatus, number> = { new: 0, contacted: 0, qualified: 0, won: 0, rejected: 0 };
      let unassigned = 0;
      for (const row of counts.rows) {
        perStatus[row.status] = Number(row.n);
        if (row.status === 'new' || row.status === 'contacted' || row.status === 'qualified') {
          unassigned += Number(row.unassigned);
        }
      }

      return {
        data: rows.rows.map((row) => this.leadView(row)),
        meta: {
          total: Number(totals.rows[0]?.total ?? 0),
          limit,
          offset,
          count: rows.rows.length,
        },
        counts: perStatus,
        unassigned,
      };
    });
  }

  /** `GET /platform/leads/:id` — الطلب، وملاحظاته، وأثره. */
  async detail(
    id: string,
  ): Promise<{ lead: LeadView; notes: LeadNoteView[]; events: LeadEventView[] }> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const lead = await this.requireLead(tx, id);
      const notes = (await tx.execute(sql`
        SELECT * FROM lead_notes WHERE lead_id = ${id} ORDER BY created_at DESC
      `)) as unknown as { rows: Array<Record<string, unknown>> };
      const events = (await tx.execute(sql`
        SELECT * FROM lead_events WHERE lead_id = ${id} ORDER BY created_at DESC LIMIT 200
      `)) as unknown as { rows: Array<Record<string, unknown>> };

      return {
        lead: this.leadView(lead.row),
        notes: notes.rows.map((row) => ({
          id: String(row.id),
          leadId: String(row.lead_id),
          body: String(row.body),
          authorId: (row.author_id as string | null) ?? null,
          authorName: (row.author_label as string | null) ?? null,
          createdAt: instant(row.created_at),
        })),
        events: events.rows.map((row) => ({
          id: String(row.id),
          leadId: String(row.lead_id),
          kind: String(row.kind),
          detail: (row.detail as string | null) ?? null,
          actorId: (row.actor_id as string | null) ?? null,
          actorName: (row.actor_label as string | null) ?? null,
          createdAt: instant(row.created_at),
        })),
      };
    });
  }

  /**
   * `PATCH /platform/leads/:id` — الحالة والإسناد.
   *
   * والانتقال يُقاس على `leadTransitions` في العقد: الحالة النهائية (`won` · `rejected`) لا
   * تعود، والرجوع عن قرارٍ يُكتب ملاحظةً أو يُفتح طلبٌ جديد — فالأثر لا يُمحى بتصحيح حالة.
   */
  async update(id: string, input: LeadPatch): Promise<LeadView> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const actor = await this.actor(tx);
      const current = await this.requireLead(tx, id);
      const status = input.status;
      const assignedTo = input.assignedTo;

      if (status && !leadTransitionAllowed(current.status, status)) {
        throw new DomainError(
          errorCodes.LEAD_STATUS_LOCKED,
          `لا يمكن الانتقال من «${leadStatusLabelsAr[current.status]}» إلى «${leadStatusLabelsAr[status]}». ` +
            'الحالة النهائية لا تعود: اكتب ملاحظةً أو افتح طلباً جديداً.',
          422,
          { from: current.status, to: status },
        );
      }

      if (assignedTo) await this.assertAssignee(tx, assignedTo);

      await tx.execute(sql`
        UPDATE leads SET
          status = ${status ?? current.status},
          assigned_to = ${assignedTo === undefined ? current.assignedTo : assignedTo},
          updated_at = now()
         WHERE id = ${id}
      `);

      if (status && status !== current.status) {
        await this.event(
          tx,
          id,
          'lead.status_changed',
          `${leadStatusLabelsAr[current.status]} ← ${leadStatusLabelsAr[status]}` +
            (input.reason ? ` · ${input.reason}` : ''),
          actor.id,
          actor.label,
          { from: current.status, to: status, reason: input.reason ?? null },
        );
      }
      if (assignedTo !== undefined) {
        await this.event(
          tx,
          id,
          'lead.assigned',
          assignedTo ? `أُسند إلى ${await this.actorLabel(tx, assignedTo)}` : 'أُزيل الإسناد',
          actor.id,
          actor.label,
          { assignedTo },
        );
      }

      if (status && status !== current.status) {
        await this.record(tx, actor, leadAuditActions.STATUS_CHANGED, id, {
          from: current.status,
          to: status,
          reason: input.reason ?? null,
        });
      }
      if (assignedTo !== undefined) {
        await this.record(tx, actor, leadAuditActions.ASSIGNED, id, { assignedTo });
      }

      return this.leadView((await this.requireLead(tx, id)).row);
    });
  }

  /** `POST /platform/leads/:id/notes` — ملاحظةٌ من إنسان (وهي أثرٌ أيضاً). */
  async addNote(id: string, input: LeadNoteCreate): Promise<LeadNoteView> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const actor = await this.actor(tx);
      await this.requireLead(tx, id);
      const noteId = newId();
      await tx.execute(sql`
        INSERT INTO lead_notes (id, lead_id, body, author_id, author_label)
        VALUES (${noteId}, ${id}, ${input.body.trim()}, ${actor.id}, ${actor.label})
      `);
      await tx.execute(sql`UPDATE leads SET updated_at = now() WHERE id = ${id}`);
      await this.event(tx, id, 'lead.note_added', input.body.trim().slice(0, 200), actor.id, actor.label, null);

      return {
        id: noteId,
        leadId: id,
        body: input.body.trim(),
        authorId: actor.id,
        authorName: actor.label,
        createdAt: new Date().toISOString(),
      };
    });
  }

  /**
   * `POST /platform/leads/:id/convert` — «بضغطةٍ واحدة»: منشأةٌ ومديرٌ وتجربة.
   *
   * وما يحدث بالضبط:
   *   1. رمزُ المنشأة يُشتقّ من الشركة إن لم يُعطَ، ويُرفض إن كان مأخوذاً (والطلب لم يُمسّ).
   *   2. `PlatformAdminService.signup` تُنشئ المنشأة والمدير والدور الأساسي في معاملةٍ واحدة —
   *      و`provisionCompanyFile` لا تصلح هنا لأنها تفتح طلب تفعيلٍ معلَّقاً: **المشغّل هو من
   *      قرّر**، فالترخيص يُمنح فوراً بتجربة.
   *   3. `OrgProvisioningService` تُكمل الفرع والمستودع والخزنة ودليل الحسابات.
   *   4. ترخيصٌ بحالة `trialing` لمدة `billing.trial_days` عبر `PlatformBillingService`
   *      (وهي تُلغي أي ترخيصٍ حيّ سابق وترفض باقةً مجهولة قبل أن تكتب).
   *   5. الطلب يصير `won` ومنشأته تُكتب عليه، والأثر يحمل من فعل ذلك.
   *
   * وكلمة المرور **مُولَّدة ولا تُخزَّن خاماً**: تُعاد في الاستجابة مرّةً واحدة ومَن حَضَر
   * التحويل هو من يبلّغها، والحساب يطالب بتغييرها عند أول دخول.
   */
  async convert(
    id: string,
    input: LeadConvert,
  ): Promise<{
    lead: LeadView;
    tenantId: string;
    tenantCode: string;
    ownerEmail: string;
    ownerUserId: string;
    tempPassword: string;
    subscriptionId: string;
    trialDays: number;
    trialEndsAt: string | null;
  }> {
    const leadRow = await withPlatformAdminTx(this.database.db, (tx) => this.requireLead(tx, id));
    const actor = { id: getAuthContext().userId, label: '' };
    if (leadRow.convertedTenantId) {
      throw new DomainError(
        errorCodes.LEAD_ALREADY_CONVERTED,
        'هذا الطلب حُوّل من قبل. الشاشة تعرض المنشأة الناتجة، ولا تُنشأ منشأةٌ ثانية لنفس الطلب.',
        409,
        { tenantId: leadRow.convertedTenantId },
      );
    }
    const companyName = leadRow.companyName || leadRow.fullName;
    const ownerEmail = normalizeLeadEmail(leadRow.email);
    const tenantCode = (input.tenantCode ?? slugifyTenantCode(companyName)).toLowerCase();
    const trialDays = input.trialDays ?? (await this.trialDays());
    const tempPassword = randomPassword();
    // بلا باقة لا تجربة: الترخيص `trialing` يُبنى على باقة، فطلبٌ بلا باقةٍ مُعلنة يُرفض
    // **قبل** إنشاء أي صفّ (لا منشأةَ نصف محوَّلة تنتظر من يكملها).
    const plan = input.planId ?? (await this.defaultPlanId());
    if (!plan) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'لا باقةَ مُعلنة في المنصّة. انشر باقةً (أو سمِّ `planId`) ثم أعد التحويل — فالترخيص التجريبي يُبنى على باقة.',
        422,
        { field: 'planId' },
      );
    }

    const created = await this.admin.signup({
      code: tenantCode,
      companyName: input.tenantName?.trim() || companyName,
      baseCurrency: 'SAR',
      countryCode: 'SA',
      ownerEmail,
      ownerFullName: leadRow.fullName || ownerEmail,
      ownerPassword: tempPassword,
      planId: plan ?? undefined,
    });

    await this.provisioning.provisionOrgDefaults(created.tenantId, {
      actorUserId: created.ownerUserId,
    });

    const granted = await this.billing.grantSubscription({
      tenantId: created.tenantId,
      planId: plan,
      months: 1,
      trialDays,
      billingEmail: ownerEmail,
      notes: `تحويل عميل متوقَّع ${leadRow.reference} · تجربة ${trialDays} يوماً`,
    });
    const subscriptionId = granted.id;
    const trialEndsAt = granted.trialEndsAt;

    const label = await withPlatformAdminTx(this.database.db, (tx) => this.actorLabel(tx, actor.id));
    const lead = await withPlatformAdminTx(this.database.db, async (tx) => {
      const who = { id: actor.id, label };
      await tx.execute(sql`
        UPDATE leads SET status = 'won', converted_tenant_id = ${created.tenantId},
                         converted_at = now(), assigned_to = coalesce(assigned_to, ${who.id}),
                         updated_at = now()
         WHERE id = ${id}
      `);
      await this.event(
        tx,
        id,
        'lead.converted',
        `أُنشئت منشأة ${created.tenantCode} بتجربة ${trialDays} يوماً`,
        who.id,
        who.label,
        { tenantId: created.tenantId, tenantCode: created.tenantCode, trialDays, subscriptionId },
      );
      // سجلّ المنصّة أيضاً: تحويلُ طلبٍ يُنشئ منشأة، وهو حدثٌ يُراجَع لا مجرّد ملاحظة.
      await this.audit.recordInTx(tx, {
        tenantId: null,
        actorUserId: who.id,
        actorLabel: who.label,
        action: leadAuditActions.CONVERTED,
        entity: 'lead',
        entityId: id,
        after: {
          tenantId: created.tenantId,
          tenantCode: created.tenantCode,
          trialDays,
          planId: plan,
        },
        meta: { scope: 'platform_console', reference: leadRow.reference },
      });
      // إغلاقُ القمع يُقاس من الأثر: الطلب صار عميلاً، ولا تكرار بعده.
      return this.leadView((await this.requireLead(tx, id)).row);
    });

    return {
      lead,
      tenantId: created.tenantId,
      tenantCode: created.tenantCode,
      ownerEmail,
      ownerUserId: created.ownerUserId,
      tempPassword,
      subscriptionId,
      trialDays,
      trialEndsAt,
    };
  }

  // ═══════════════════════════════════════════════════ ٣ · المشتركون

  /**
   * `GET /platform/leads/subscribers` — قائمة النشرة بحالتها.
   *
   * ولا متغيّر اسمه `total` هنا: حرس المال في `eslint.config.mjs` يمنع الأسماء الماليّة
   * (`price|amount|total|balance|cost|rate`) في مواضع القيمة — **وهو عدٌّ لا مبلغ**، فيُسمّى
   * باسمه (`subscriberCount`) بدل أن يُستثنى الحرس في موضعٍ لا يستحقّ استثناءً.
   */
  async listSubscribers(
    query: SubscriberListQuery,
  ): Promise<ListEnvelope<SubscriberView> & { counts: Record<SubscriberStatus, number> }> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = Math.max(query.offset ?? 0, 0);
    const search = query.q?.trim() ? `%${query.q.trim().toLowerCase()}%` : null;

    return withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT * FROM email_subscribers
         WHERE (${query.status ?? null}::text IS NULL OR status = ${query.status ?? null})
           AND (${search}::text IS NULL OR lower(email) LIKE ${search})
         ORDER BY created_at DESC
         LIMIT ${limit} OFFSET ${offset}
      `)) as unknown as { rows: Array<Record<string, unknown>> };

      const totals = (await tx.execute(sql`
        SELECT status, count(*)::int AS n FROM email_subscribers GROUP BY status
      `)) as unknown as { rows: Array<{ status: SubscriberStatus; n: number }> };

      const counts: Record<SubscriberStatus, number> = { pending: 0, confirmed: 0, unsubscribed: 0 };
      let subscriberCount = 0;
      for (const row of totals.rows) {
        counts[row.status] = Number(row.n);
        subscriberCount += Number(row.n);
      }

      return {
        data: rows.rows.map((row) => this.subscriberView(row)),
        meta: { total: subscriberCount, limit, offset, count: rows.rows.length },
        counts,
      };
    });
  }

  /**
   * `PATCH /platform/subscribers/:id` — تأكيدٌ يدوي أو إلغاء اشتراك.
   *
   * لماذا يدويّ وإلى جانبه رابط التأكيد؟ لأن من كتب عنوانه في ورقةٍ أو هاتفه لن يفتح رابطاً
   * أبداً — ومن يطلب الإزالة يطلبها بسرعة. والقرار يُنسب لمن اتّخذه في اللوحة.
   */
  async updateSubscriber(id: string, status: SubscriberStatus): Promise<SubscriberView> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const actor = await this.actor(tx);
      const found = (await tx.execute(sql`
        SELECT * FROM email_subscribers WHERE id = ${id} LIMIT 1
      `)) as unknown as { rows: Array<Record<string, unknown>> };
      const row = found.rows[0];
      if (!row) {
        throw new DomainError(errorCodes.NOT_FOUND, 'المشترك غير موجود', 404);
      }

      await tx.execute(sql`
        UPDATE email_subscribers SET
          status = ${status},
          confirmed_at = CASE WHEN ${status} = 'confirmed' THEN coalesce(confirmed_at, now()) ELSE NULL END,
          unsubscribed_at = CASE WHEN ${status} = 'unsubscribed' THEN now() ELSE NULL END,
          confirm_token_hash = CASE WHEN ${status} = 'confirmed' THEN confirm_token_hash ELSE NULL END,
          updated_at = now()
         WHERE id = ${id}
      `);
      await this.record(tx, actor, leadAuditActions.SUBSCRIBER_STATUS, id, { status });

      return this.subscriberView({ ...row, status });
    });
  }

  // ═══════════════════════════════════════════════════ أدوات داخلية

  private async requireLead(
    tx: DrizzleTx,
    id: string,
  ): Promise<LeadRow> {
    const result = (await tx.execute(sql`
      SELECT l.*, u.full_name AS assignee_name, t.code AS converted_tenant_code
        FROM leads l
        LEFT JOIN users u ON u.id = l.assigned_to
        LEFT JOIN tenants t ON t.id = l.converted_tenant_id
       WHERE l.id = ${id} LIMIT 1
    `)) as unknown as { rows: Array<Record<string, unknown>> };
    const row = result.rows[0];
    if (!row) {
      throw new DomainError(errorCodes.LEAD_NOT_FOUND, 'الطلب غير موجود', 404, { leadId: id });
    }
    return {
      id: String(row.id),
      row,
      status: row.status as LeadStatus,
      email: String(row.email ?? ''),
      reference: String(row.reference ?? ''),
      companyName: String(row.company_name ?? '').trim(),
      fullName: String(row.full_name ?? '').trim(),
      convertedTenantId: (row.converted_tenant_id as string | null) ?? null,
      assignedTo: (row.assigned_to as string | null) ?? null,
    };
  }

  private async assertAssignee(tx: DrizzleTx, userId: string): Promise<void> {
    const found = await tx.execute(sql`
      SELECT u.id FROM users u
        JOIN memberships m ON m.user_id = u.id
       WHERE u.id = ${userId} AND m.status = 'active' LIMIT 1
    `);
    if (!found.rows[0]) {
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        'لا يمكن الإسناد إلى مستخدمٍ غير نشط. اختر مشغّلاً من القائمة.',
        422,
        { assignedTo: userId },
      );
    }
  }

  /** الفاعل من سياق الطلب: المعرّف من الرمز، والاسم من القاعدة (يُحفظ في الأثر وقت الحدث). */
  private async actor(tx: DrizzleTx): Promise<{ id: string; label: string }> {
    const auth = getAuthContext();
    return { id: auth.userId, label: await this.actorLabel(tx, auth.userId) };
  }

  /** أثرٌ في `audit_log` — للأفعال التي تُغيّر حالة عميلٍ أو تُنشئ منشأة. */
  private async record(
    tx: DrizzleTx,
    actor: { id: string; label: string },
    action: string,
    entityId: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.recordInTx(tx, {
      tenantId: null,
      actorUserId: actor.id,
      actorLabel: actor.label,
      action,
      entity: 'lead',
      entityId,
      after,
      meta: { scope: 'platform_console' },
    });
  }

  private async actorLabel(tx: DrizzleTx, userId: string): Promise<string> {
    const found = await tx.execute(sql`SELECT full_name, email FROM users WHERE id = ${userId} LIMIT 1`);
    const row = found.rows[0] as { full_name?: string; email?: string } | undefined;
    return row?.full_name?.trim() || row?.email || 'مشغّل';
  }

  /** أثرٌ في الجدول — واللوحة تقرؤه، فالحدث ليس سطرَ سجلٍّ يُهمَل. */
  private async event(
    tx: DrizzleTx,
    leadId: string,
    kind: string,
    detail: string | null,
    actorId: string | null,
    actorLabel: string | null,
    meta: Record<string, unknown> | null,
  ): Promise<void> {
    await tx.execute(sql`
      INSERT INTO lead_events (id, lead_id, kind, detail, meta, actor_id, actor_label)
      VALUES (${newId()}, ${leadId}, ${kind}, ${detail}, ${meta === null ? null : JSON.stringify(meta)}::jsonb,
              ${actorId}, ${actorLabel})
    `);
  }

  private leadView(row: Record<string, unknown>): LeadView {
    const status = row.status as LeadStatus;
    return {
      id: String(row.id),
      reference: String(row.reference),
      fullName: (row.full_name as string | null) ?? null,
      companyName: (row.company_name as string | null) ?? null,
      email: String(row.email),
      phone: (row.phone as string | null) ?? null,
      branchCount: row.branch_count === null || row.branch_count === undefined ? null : Number(row.branch_count),
      planInterest: (row.plan_interest as string | null) ?? null,
      message: String(row.message),
      source: row.source as LeadSource,
      sourceLabelAr: leadSourceLabelsAr[row.source as LeadSource],
      status,
      statusLabelAr: leadStatusLabelsAr[status],
      statusLocked: isLeadClosed(status),
      locale: row.locale === 'en' ? 'en' : 'ar',
      acceptsMarketing: Boolean(row.accepts_marketing),
      utm: (row.utm as Utm | null) ?? null,
      assignedTo: (row.assigned_to as string | null) ?? null,
      assignedToName: (row.assignee_name as string | null) ?? null,
      convertedTenantId: (row.converted_tenant_id as string | null) ?? null,
      convertedTenantCode: (row.converted_tenant_code as string | null) ?? null,
      convertedAt: row.converted_at ? instant(row.converted_at) : null,
      createdAt: instant(row.created_at),
      updatedAt: row.updated_at ? instant(row.updated_at) : null,
    };
  }

  private subscriberView(row: Record<string, unknown>): SubscriberView {
    const status = row.status as SubscriberStatus;
    return {
      id: String(row.id),
      email: String(row.email),
      status,
      statusLabelAr: subscriberStatusLabelsAr[status],
      locale: row.locale === 'en' ? 'en' : 'ar',
      source: row.source as LeadSource,
      createdAt: instant(row.created_at),
      confirmedAt: row.confirmed_at ? instant(row.confirmed_at) : null,
    };
  }

  /** رسالة استلام الطلب — لا تُسقط الطلب إن فشلت. */
  private async acknowledgeLead(input: {
    email: string;
    name: string;
    company: string;
    reference: string;
    locale: 'ar' | 'en';
  }): Promise<void> {
    try {
      await this.email.send({
        tenantId: null,
        event: 'lead.received',
        to: input.email,
        toName: input.name,
        locale: input.locale,
        variables: {
          name: input.name,
          company: input.company || 'منشأتك',
          reference: input.reference,
        },
      });
    } catch (error) {
      this.logger.warn(`lead acknowledgement failed for ${input.email}: ${(error as Error).message}`);
    }
  }

  /** رابط التأكيد المزدوج — من نطاق الموقع (`site.url`) لا من `localhost`. */
  private async sendConfirmLink(input: {
    email: string;
    token: string;
    locale: 'ar' | 'en';
  }): Promise<void> {
    try {
      const siteUrl = String(await this.setting('site.url')).replace(/\/+$/, '');
      const link = `${siteUrl}/api/v1/public/subscribe/confirm/${input.token}`;
      await this.email.send({
        tenantId: null,
        event: 'subscriber.confirm',
        to: input.email,
        toName: input.email,
        locale: input.locale,
        variables: { email: input.email, link },
      });
    } catch (error) {
      this.logger.warn(`newsletter confirmation failed for ${input.email}: ${(error as Error).message}`);
    }
  }

  /** الفترة التجريبية من إعدادات المنصّة (`billing.trial_days`) — لا من رقمٍ في الكود. */
  private async trialDays(): Promise<number> {
    const days = Number(await this.setting('billing.trial_days'));
    return Number.isFinite(days) && days > 0 ? Math.floor(days) : 0;
  }

  /**
   * قيمةُ إعدادٍ منصّيّ كما يقرؤها المحتوى (P-M5): الافتراضي من الفهرس المشترك في العقد،
   * وصفُّ القاعدة يُدمج فوقه إن وُجد — فلا يفترق رقمُ الخدمة عن رقم الشاشة.
   */
  private async setting(key: string): Promise<string | number | boolean | string[]> {
    const fallback = defaultPlatformSettingValue(key);
    const found = await withPlatformAdminTx(this.database.db, (tx) =>
      tx.execute(sql`
        SELECT value::text AS raw FROM platform_settings
         WHERE key = ${key} AND tenant_id IS NULL LIMIT 1
      `),
    );
    const raw = (found.rows[0] as { raw?: string } | undefined)?.raw;
    if (raw === undefined) return fallback;
    try {
      return JSON.parse(raw) as string | number | boolean | string[];
    } catch {
      return fallback;
    }
  }

  /**
   * الباقة الافتراضية: أوّل باقةٍ مُعلنة (والسنوية أسبق من الشهرية عند التساوي) — ولا اختراع.
   * والعمود هنا `active` لا `is_active`: جدول `billing_plans` سابقٌ لاصطلاح `is_active`
   * الذي جاء مع الجداول التنظيمية، وكل قارئٍ آخر له يُصفّي بـ`active = true`
   * (`billing.service.ts` · `public-plans.service.ts`). ولا `deleted_at` في الجدول أصلاً.
   */
  private async defaultPlanId(): Promise<string | null> {
    const found = await withPlatformAdminTx(this.database.db, (tx) =>
      tx.execute(sql`
        SELECT id FROM billing_plans
         WHERE active = true
         ORDER BY CASE interval WHEN 'year' THEN 0 ELSE 1 END, amount ASC
         LIMIT 1
      `),
    );
    const row = found.rows[0] as { id?: string } | undefined;
    return row?.id ?? null;
  }
}

// ═══════════════════════════════════════════════════ أنواع ودوالّ حرة

/** صفّ الطلب كما تقرؤه الخدمة، مُطبَّعاً — حتى لا تتكرّر `String(row.x ?? '')` في كل دالّة. */
type LeadRow = {
  id: string;
  row: Record<string, unknown>;
  status: LeadStatus;
  email: string;
  reference: string;
  companyName: string;
  fullName: string;
  convertedTenantId: string | null;
  assignedTo: string | null;
};

/**
 * مرجعٌ قصير للزائر: `L-` واثنتا عشرة خانة من **ذيل** المعرّف.
 *
 * والذيل لا الرأس، لأن معرّفات هذا المستودع v7: رأسُها طابعٌ زمنيّ، فأخذُ عشر خاناتٍ من
 * رأسها يجعل **كل مرجعين في المللي ثانية نفسها متطابقين** — ويظهر ذلك كتعارضٍ في القيد
 * الفريد لا كخطأ منطق. وذيلُها هو الجزء العشوائي فيها (٤٨ بتّاً)، فهو موضع الفرادة.
 */
function referenceFor(id: string): string {
  return `L-${id.replace(/-/g, '').slice(-12).toUpperCase()}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** كلمة مرورٍ مؤقتة قوية: 20 حرفاً من مولّدٍ عشوائي تشفيري، ولها خطُّ افتراضي في الوسط. */
function randomPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(20);
  let value = '';
  for (const byte of bytes) value += alphabet[byte % alphabet.length];
  return `${value.slice(0, 10)}-${value.slice(10)}`.replace(/^([a-z])/, (first) => first.toUpperCase());
}

/**
 * رمز منشأةٍ مشتقّ من الاسم — **ASCII وحده** وله لاحقةٌ عشوائية.
 *
 * والاسم العربي لا يحمل ASCII أصلاً، فالتقشير يُفرغه ويبقى `lead-4f2a9c`: رمزٌ صالحٌ دائماً
 * (`/^[a-z0-9][a-z0-9-]{1,62}$/` في `provisionTenant`) بدل رمزٍ عربي يُرفض في منتصف التحويل
 * بعد أن يكون الطلب قد صار `won`.
 */
function slugifyTenantCode(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const suffix = randomBytes(3).toString('hex');
  return base.length >= 2 ? `${base}-${suffix}` : `lead-${suffix}`;
}

/**
 * طابع زمني مضمون كـ`Date` — نتائج `tx.execute` الخام تُعيد `timestamptz` **نصّاً** بصيغة
 * PostgreSQL، لا كائنَ `Date` (وهو الخطأ الذي وقع في P-M4 وأصلحه `toInstant` هناك).
 */
function instant(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const text = String(value).trim().replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? new Date(String(value)).toISOString() : parsed.toISOString();
}
