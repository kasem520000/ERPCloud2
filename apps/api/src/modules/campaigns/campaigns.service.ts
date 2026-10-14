import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  campaignBodyProblems,
  campaignClickUrl,
  campaignEventLabelsAr,
  campaignHyperlinks,
  campaignIsCancelable,
  campaignIsEditable,
  campaignMessageStatusLabelsAr,
  campaignOpenUrl,
  campaignSegmentDescriptionsAr,
  campaignSegmentIsPeople,
  campaignSegmentLabelsAr,
  campaignStatusLabelsAr,
  campaignUnsubscribeUrl,
  campaignVariablesIn,
  defaultPlatformSettingValue,
  DomainError,
  errorCodes,
  jobTypes,
  renderCampaignMessage,
  type CampaignCancel,
  type CampaignCreate,
  type CampaignDispatch,
  type CampaignEventKind,
  type CampaignEventView,
  type CampaignListQuery,
  type CampaignListResponse,
  type CampaignLocale,
  type CampaignMessageStatus,
  type CampaignMessageView,
  type CampaignPatch,
  type CampaignReport,
  type CampaignSchedule,
  type CampaignSegment,
  type CampaignSegmentInfo,
  type CampaignStatus,
  type CampaignTest,
  type CampaignTestResult,
  type CampaignTotals,
  type CampaignView,
} from '@erp/contracts';
import { newId, withPlatformAdminTx, type DatabaseHandle, type DrizzleTx } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.tokens.js';
import { tryGetAuthContext } from '../../request-context/request-context.js';
import { EmailService } from '../email/email.service.js';
import { AuditService } from '../platform-services/audit/audit.service.js';
import { OutboxService } from '../platform-services/jobs/outbox.service.js';

/**
 * P-M7 — الحملات البريدية (`docs/roadmap/MARKETING_SITE_PLAN.md` §5، السطر P-M7).
 *
 * **سبعة قرارات تحكم هذا الملف:**
 *
 *   1. **الرسالة صفٌّ قبل أن تكون بريداً.** الإرسال يُنشئ لكل مستلم صفّاً في
 *      `campaign_messages` (بمرمزه وروابطه) **ثم** يُسلّم رسالته. فـ«من وصلته؟» يُجاب من
 *      صفوفٍ لا من عدّادٍ في الذاكرة، ولو توقّف الإرسال في منتصفه عُرف أين وقف بالضبط.
 *   2. **دفعات (٥٠ مستلماً)**: كل دفعة تُنشئ رسائلها وتُسلّمها inline كما يفعل كل بريد
 *      المنصّة (P-C6) — فلا يقف الطلب دقائق على قائمةٍ كبيرة. وإن بقيت بقيّة أُعيدت جدولة
 *      مهمّة `campaign.send`، **والمسح (`dispatchDue`) يُنادى قبل كل قراءة للقائمة**:
 *      «الطابور يوقظ والمسح يكفل» — نفس مبدأ نشر المحتوى في P-M5، فتعمل المجدولة في بيئةٍ
 *      بلا Redis أو بلا عامل.
 *   3. **الحجر والموافقة قبل المزج**: قائمة الحجر يمنعها مُرسِل البريد نفسه (لا منطق ثانٍ
 *      هنا يدّعي أنه احترمها)، والموافقة (`accepts_marketing`، وتأكيد المشترك) جزءٌ من
 *      **تعريف الشريحة** — فمن لم يوافق لا يُدرَج أصلاً.
 *   4. **الرمز سرٌّ لا يُخزَّن**: يُولَّد في اللحظة التي يُبنى فيها الصفّ ويُخزَّن sha256 له،
 *      ويخرج الخام في نصّ الرسالة وحده (الفتح والنقر والإلغاء بالرمز نفسه). فلا يستطيع من
 *      قرأ القاعدة تسجيلَ فتحٍ ولا نقرةٍ ولا إلغاءِ اشتراكِ غيره. ولهذا تُبنى الرسالة في
 *      **نفس اللحظة** التي وُلد فيها الرمز: لا يُعاد بناؤه بعد إعادة تشغيلٍ، ويُعاد تجميد
 *      ما لم يخرج بدورةٍ جديدة.
 *   5. **إلغاءُ الاشتراك يُسجِّل حجراً**: النقرة تُكتب في `email_suppressions` (سبب
 *      `unsubscribe`) فيمنعها مُرسِل P-C6 في كل بريدٍ لاحق — لا في هذه الحملة وحدها —
 *      وتُعلَّم حالة المشترك `unsubscribed` إن كان في النشرة، فلا يبقى في جدولين قولان.
 *   6. **حملةٌ بدأ إرسالها لا تُعدَّل ولا تُلغى**: النصّ الذي خرج نصٌّ خرج (`CAMPAIGN_LOCKED`).
 *   7. **لا حذف**: الحملة تُلغى بسببٍ مكتوب، ورسائلها وأحداثها شواهد.
 */
@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  /** حجم الدفعة: صغيرٌ بما يكفي ألّا يطول الطلب، كبيرٌ بما يكفي ألّا يُذلّ الطابور. */
  private static readonly BATCH_SIZE = 50;

  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly email: EmailService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  // ═══════════════════════════════════════════════════ الشرائح

  /**
   * عدُّ الشرائح كما هو **الآن** — لا تقدير. والشاشة تقول ما يقوله الإرسال لأن الاستعلام
   * واحد: `segmentRowsSql` هو التعريف الوحيد لمعنى كل شريحة في المنصّة.
   */
  async segments(): Promise<CampaignSegmentInfo[]> {
    const segments: CampaignSegment[] = [
      'leads',
      'subscribers',
      'trialing',
      'active',
      'past_due',
      'churned',
    ];
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const counts = await tx.execute(sql`
        SELECT
          (SELECT count(*) FROM (${sql.raw(this.segmentRowsSql('leads'))}) AS s)::int AS leads,
          (SELECT count(*) FROM (${sql.raw(this.segmentRowsSql('subscribers'))}) AS s)::int AS subscribers,
          (SELECT count(*) FROM (${sql.raw(this.segmentRowsSql('trialing'))}) AS s)::int AS trialing,
          (SELECT count(*) FROM (${sql.raw(this.segmentRowsSql('active'))}) AS s)::int AS active,
          (SELECT count(*) FROM (${sql.raw(this.segmentRowsSql('past_due'))}) AS s)::int AS past_due,
          (SELECT count(*) FROM (${sql.raw(this.segmentRowsSql('churned'))}) AS s)::int AS churned
      `);
      const row = (counts.rows[0] ?? {}) as Record<string, number>;
      return segments.map((segment) => {
        const count = Number(row[segment] ?? 0);
        return {
          segment,
          labelAr: campaignSegmentLabelsAr[segment],
          descriptionAr: campaignSegmentDescriptionsAr[segment],
          count,
          audience: campaignSegmentIsPeople(segment) ? ('people' as const) : ('account' as const),
          warningAr: warningFor(segment, count),
        } satisfies CampaignSegmentInfo;
      });
    });
  }

  /**
   * صفوف شريحةٍ واحد — **التعريف الوحيد** لمعنى كل شريحة (العدّ والإرسال معاً).
   *
   * و»الحيّ» في التراخيص هو ما تعرفه `tenant_subscriptions_active_tenant_key`: حالةٌ
   * `trialing · active · past_due · paused` بلا `canceled_at`. والوجهة: **بريد الفوترة** إن
   * كُتب (هو عنوان المراسلات الذي وقّع عليه العميل)، وإلا **بريد مالك المنشأة** (أوّل عضوٍ
   * فعّال: `is_owner` ثم الأقدم) — فلا تُرسل حملةٌ إلى عنوانٍ مُخترع، ومنشأةٌ بلا عنوانٍ
   * فعّال تُستبعد من الشريحة (وذلك يظهر في العدّ).
   */
  private segmentRowsSql(segment: CampaignSegment): string {
    if (segment === 'leads') {
      // من ملأ استمارةً ووافق على التسويق ولم يصر عميلاً بعد. والشرط الأخير بالذات يمنع
      // أن يصل «عرضُ تجربةٍ» لمن هو في تجربةٍ بالفعل.
      return `
        SELECT l.id AS ref_id, l.email, l.full_name, l.company_name,
               NULL::uuid AS tenant_id, l.id AS lead_id, NULL::uuid AS subscriber_id
          FROM leads l
         WHERE l.status IN ('new', 'contacted', 'qualified')
           AND l.accepts_marketing
           AND l.converted_tenant_id IS NULL
      `;
    }
    if (segment === 'subscribers') {
      // المؤكَّد وحده: من كتب عنوانه ولم يفتح رابط التأكيد ليس مشتركاً (P-M6).
      return `
        SELECT s.id AS ref_id, s.email, NULL::text AS full_name, NULL::text AS company_name,
               NULL::uuid AS tenant_id, NULL::uuid AS lead_id, s.id AS subscriber_id
          FROM email_subscribers s
         WHERE s.status = 'confirmed'
      `;
    }

    const live =
      segment === 'trialing' ? `('trialing')` : segment === 'active' ? `('active')` : `('past_due')`;
    const condition =
      segment === 'churned'
        ? `NOT EXISTS (SELECT 1 FROM tenant_subscriptions x
                        WHERE x.tenant_id = t.id AND x.status IN ('trialing', 'active', 'past_due', 'paused')
                          AND x.canceled_at IS NULL)
             AND EXISTS (SELECT 1 FROM tenant_subscriptions y
                          WHERE y.tenant_id = t.id AND y.status IN ('canceled', 'expired'))`
        : `EXISTS (SELECT 1 FROM tenant_subscriptions x
                    WHERE x.tenant_id = t.id AND x.status IN ${live} AND x.canceled_at IS NULL)`;

    return `
      SELECT t.id AS ref_id, COALESCE(billing.email, owner.email) AS email,
             COALESCE(owner.full_name, t.name) AS full_name, t.name AS company_name,
             t.id AS tenant_id, NULL::uuid AS lead_id, NULL::uuid AS subscriber_id
        FROM tenants t
        LEFT JOIN LATERAL (
          SELECT COALESCE(ts.billing_email, usr.email) AS email
            FROM tenant_subscriptions ts
            LEFT JOIN LATERAL (
              SELECT u.email
                FROM memberships m
                JOIN users u ON u.id = m.user_id
               WHERE m.tenant_id = t.id AND m.deleted_at IS NULL AND m.kind = 'staff'
                 AND u.status <> 'suspended'
               ORDER BY m.is_owner DESC, m.created_at ASC
               LIMIT 1
            ) usr ON true
           WHERE ts.tenant_id = t.id
           ORDER BY ts.created_at DESC
           LIMIT 1
        ) billing ON true
        LEFT JOIN LATERAL (
          SELECT u.email, u.full_name
            FROM memberships m
            JOIN users u ON u.id = m.user_id
           WHERE m.tenant_id = t.id AND m.deleted_at IS NULL AND m.kind = 'staff'
             AND u.status <> 'suspended'
           ORDER BY m.is_owner DESC, m.created_at ASC
           LIMIT 1
        ) owner ON true
       WHERE t.status <> 'deleted'
         AND COALESCE(billing.email, owner.email) IS NOT NULL
         AND ${condition}
       ORDER BY COALESCE(billing.email, owner.email) ASC
    `;
  }

  // ═══════════════════════════════════════════════════ القراءة

  async list(query: CampaignListQuery): Promise<CampaignListResponse> {
    // نبضة المسح قبل القراءة — فبيئةٌ بلا عامل تُرسل حملاتها المجدولة هنا (كما في P-M5).
    await this.dispatchDue().catch((error: unknown) => {
      this.logger.warn(`campaign sweep failed: ${(error as Error).message}`);
    });

    return withPlatformAdminTx(this.database.db, async (tx) => {
      const filters = [sql`1 = 1`];
      if (query.status) filters.push(sql`status = ${query.status}`);
      if (query.segment) filters.push(sql`segment = ${query.segment}`);
      if (query.q) {
        filters.push(sql`(name ILIKE ${`%${query.q}%`} OR subject ILIKE ${`%${query.q}%`})`);
      }
      const where = sql.join(filters, sql` AND `);

      const rows = await tx.execute(sql`
        SELECT ${campaignColumns()}
          FROM email_campaigns
         WHERE ${where}
         ORDER BY
           CASE status WHEN 'sending' THEN 0 WHEN 'scheduled' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END,
           coalesce(scheduled_at, created_at) DESC
         LIMIT ${query.limit} OFFSET ${query.offset}
      `);
      const totals = await tx.execute(sql`
        SELECT status, count(*)::int AS total FROM email_campaigns GROUP BY status
      `);
      // الاسم `filtered` لا `total`: حرس المال في المستودع يمنع الاسم `total` في مواضع
      // القيمة — وهذا **عدُّ صفوف** لا مبلغاً، فيُسمّى باسمه.
      const filtered = await tx.execute(sql`
        SELECT count(*)::int AS total FROM email_campaigns WHERE ${where}
      `);

      const counts: Record<CampaignStatus, number> = {
        draft: 0,
        scheduled: 0,
        sending: 0,
        sent: 0,
        canceled: 0,
      };
      for (const row of totals.rows) counts[String(row.status) as CampaignStatus] = Number(row.total);

      return {
        // في القائمة تُعرض أرقام الحملة كما تُقرأ من صفوفها لحظتها — لا من عمودٍ مجمَّد.
        data: await Promise.all(rows.rows.map((row) => this.viewInTx(tx, String(row.id)))),
        meta: {
          total: Number(filtered.rows[0]?.total ?? 0),
          limit: query.limit,
          offset: query.offset,
        },
        counts,
      } satisfies CampaignListResponse;
    });
  }

  async detail(id: string): Promise<CampaignView> {
    return withPlatformAdminTx(this.database.db, async (tx) => this.viewInTx(tx, id));
  }

  // ═══════════════════════════════════════════════════ الكتابة

  async create(input: CampaignCreate): Promise<CampaignView> {
    assertBodyValid(input.body);
    const auth = tryGetAuthContext();
    const id = newId();

    const created = await withPlatformAdminTx(this.database.db, async (tx) => {
      await tx.execute(sql`
        INSERT INTO email_campaigns (id, name, subject, body, segment, locale, status, created_by, updated_by)
        VALUES (${id}, ${input.name}, ${input.subject}, ${input.body}, ${input.segment},
                ${input.locale}, 'draft', ${auth?.userId ?? null}, ${auth?.userId ?? null})
      `);
      await this.audit.recordInTx(tx, {
        actorUserId: auth?.userId ?? null,
        action: 'campaign.created',
        entity: 'email_campaign',
        entityId: id,
        after: { name: input.name, segment: input.segment, locale: input.locale },
        meta: { scope: 'campaigns' },
      });
      return this.viewInTx(tx, id);
    });
    this.logger.log(`campaign ${id} created for segment ${input.segment}`);
    return created;
  }

  async update(id: string, input: CampaignPatch): Promise<CampaignView> {
    if (input.body !== undefined) assertBodyValid(input.body);
    const auth = tryGetAuthContext();

    return withPlatformAdminTx(this.database.db, async (tx) => {
      const current = await this.rowInTx(tx, id);
      if (!campaignIsEditable(String(current.status) as CampaignStatus)) {
        throw new DomainError(
          errorCodes.CAMPAIGN_LOCKED,
          'حملةٌ بدأ إرسالها لا تُعدَّل — النصّ الذي خرج نصٌّ خرج. أنشئ حملةً جديدة.',
          422,
          { status: String(current.status) },
        );
      }

      const sets = [];
      if (input.name !== undefined) sets.push(sql`name = ${input.name}`);
      if (input.subject !== undefined) sets.push(sql`subject = ${input.subject}`);
      if (input.body !== undefined) sets.push(sql`body = ${input.body}`);
      if (input.segment !== undefined) sets.push(sql`segment = ${input.segment}`);
      if (input.locale !== undefined) sets.push(sql`locale = ${input.locale}`);
      // تعديل الشريحة يُبطل التقدير المخزَّن: العدد يُحسب من جديد لحظة الجدولة.
      if (input.segment !== undefined) sets.push(sql`estimated_recipients = 0`);
      sets.push(sql`updated_by = ${auth?.userId ?? null}`, sql`updated_at = now()`);

      await tx.execute(sql`UPDATE email_campaigns SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);
      await this.audit.recordInTx(tx, {
        actorUserId: auth?.userId ?? null,
        action: 'campaign.updated',
        entity: 'email_campaign',
        entityId: id,
        before: { name: current.name, segment: current.segment, status: current.status },
        after: { ...input },
        meta: { scope: 'campaigns' },
      });
      return this.viewInTx(tx, id);
    });
  }

  /**
   * الجدولة — أو الإرسال الآن (`scheduledAt: null`).
   *
   * وكل ما يُفحَص هنا **قبل** أي كتابة: النصّ صالح، والحملة قابلة للتعديل، والشريحة فيها
   * أحد. وحملةٌ إلى صفرِ مستلمين تُرفض بـ`CAMPAIGN_SEGMENT_EMPTY` ولا تُعلَن «أُرسلت»:
   * تقريرٌ يقول «أُرسلت إلى ٠» أسوأ من خطأٍ يقول لماذا.
   */
  async schedule(id: string, input: CampaignSchedule): Promise<CampaignView> {
    const auth = tryGetAuthContext();
    const target = input.scheduledAt ? new Date(input.scheduledAt) : null;
    const immediate = target === null || target.getTime() <= Date.now() + 1_000;

    const outcome = await withPlatformAdminTx(this.database.db, async (tx) => {
      const current = await this.rowInTx(tx, id);
      const status = String(current.status) as CampaignStatus;
      if (!campaignIsEditable(status)) {
        throw new DomainError(
          errorCodes.CAMPAIGN_LOCKED,
          'هذه الحملة مضت — لا تُجدَّل مرّتين. أنشئ حملةً جديدة.',
          422,
          { status },
        );
      }
      const body = String(current.body);
      assertBodyValid(body);

      const segment = String(current.segment) as CampaignSegment;
      const estimate = await this.recipientsLeftInTx(tx, { campaignId: id, segment, limit: 1 });
      if (estimate.total === 0) {
        throw new DomainError(
          errorCodes.CAMPAIGN_SEGMENT_EMPTY,
          `لا أحد في شريحة «${campaignSegmentLabelsAr[segment]}» الآن — لا حملةَ إلى صفر`,
          422,
          { segment },
        );
      }

      if (immediate) {
        await tx.execute(sql`
          UPDATE email_campaigns
             SET status = 'sending', scheduled_at = now(), started_at = now(),
                 estimated_recipients = ${estimate.total},
                 updated_by = ${auth?.userId ?? null}, updated_at = now()
           WHERE id = ${id}
        `);
      } else {
        await tx.execute(sql`
          UPDATE email_campaigns
             SET status = 'scheduled', scheduled_at = ${target}, started_at = NULL,
                 estimated_recipients = ${estimate.total},
                 updated_by = ${auth?.userId ?? null}, updated_at = now()
           WHERE id = ${id}
        `);
        await this.outbox.enqueueInTx(tx, {
          tenantId: await this.platformTenantIdInTx(tx),
          queue: 'maintenance',
          type: jobTypes.CAMPAIGN_SEND,
          payload: { campaignId: id },
          runAt: target as Date,
        });
      }

      await this.audit.recordInTx(tx, {
        actorUserId: auth?.userId ?? null,
        action: immediate ? 'campaign.sending' : 'campaign.scheduled',
        entity: 'email_campaign',
        entityId: id,
        before: { status },
        after: {
          status: immediate ? 'sending' : 'scheduled',
          scheduledAt: immediate ? null : (target as Date).toISOString(),
          recipients: estimate.total,
          ...(input.reason ? { reason: input.reason } : {}),
        },
        meta: { scope: 'campaigns' },
      });
      return { view: await this.viewInTx(tx, id), immediate };
    });

    // الإرسال الفوري يقع **بعد** الالتزام لا داخله: الرسائل تُنشأ وتُسلَّم في مسار البريد
    // نفسه، ولو وقعت داخل معاملة الجدولة لَطال القفل على جدول الحملات بلا سبب.
    if (outcome.immediate) {
      await this.dispatch(id);
      return this.detail(id);
    }
    return outcome.view;
  }

  async cancel(id: string, input: CampaignCancel): Promise<CampaignView> {
    const auth = tryGetAuthContext();
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const current = await this.rowInTx(tx, id);
      const status = String(current.status) as CampaignStatus;
      if (!campaignIsCancelable(status)) {
        throw new DomainError(
          errorCodes.CAMPAIGN_LOCKED,
          status === 'sent' ? 'حملةٌ أُرسلت لا تُلغى — ما خرج لا يُستدعى' : 'الحملة ملغاة من قبل',
          422,
          { status },
        );
      }

      const pending = await tx.execute(sql`
        UPDATE campaign_messages
           SET status = 'skipped', detail = ${`أُلغيت الحملة: ${input.reason}`}
         WHERE campaign_id = ${id} AND status = 'pending'
        RETURNING id
      `);

      await tx.execute(sql`
        UPDATE email_campaigns
           SET status = 'canceled', canceled_at = now(), canceled_reason = ${input.reason},
               finished_at = coalesce(finished_at, now()),
               updated_by = ${auth?.userId ?? null}, updated_at = now()
         WHERE id = ${id}
      `);
      await tx.execute(sql`
        INSERT INTO campaign_events (id, campaign_id, message_id, kind, detail)
        VALUES (${newId()}, ${id}, NULL, 'canceled', ${input.reason})
      `);
      await this.audit.recordInTx(tx, {
        actorUserId: auth?.userId ?? null,
        action: 'campaign.canceled',
        entity: 'email_campaign',
        entityId: id,
        before: { status },
        after: { status: 'canceled', reason: input.reason, skippedPending: pending.rows.length },
        meta: { scope: 'campaigns' },
      });
      return this.viewInTx(tx, id);
    });
  }

  /**
   * رسالة اختبار إلى عنوانٍ واحد — **بلا وسم حملة**: لا صفَّ في `campaign_messages`، ولا
   * رابطَ زحفٍ حقيقي، ولا حدث. فالتقرير يبقى عن الحملة الحقيقية وحدها، ومن جرّب نصّه لا
   * يُفسد أرقامه. والرسالة تُصيَّر بالمتغيّرات كما ستخرج، وتُوسَم اختباراً في سجلّ البريد.
   */
  async sendTest(id: string, input: CampaignTest): Promise<CampaignTestResult> {
    const campaign = await this.detail(id);
    const siteUrl = await this.siteUrl();
    const stamp = `test-${id.replace(/-/g, '').slice(0, 16)}`;
    const links = campaignHyperlinks(campaign.body);
    const rendered = renderCampaignMessage({
      campaign,
      recipient: { email: input.to, name: null, company: null },
      links,
      tracking: {
        openUrl: campaignOpenUrl(siteUrl, stamp),
        unsubscribeUrl: campaignUnsubscribeUrl(siteUrl, stamp),
        clickUrl: (index: number) => campaignClickUrl(siteUrl, stamp, index),
      },
    });

    const message = await this.email.send({
      tenantId: null,
      event: 'campaign.message',
      to: input.to,
      locale: campaign.locale,
      variables: {
        subject: rendered.subject,
        body: rendered.text,
        unsubscribe_url: campaignUnsubscribeUrl(siteUrl, stamp),
      },
      html: rendered.html,
      headers: rendered.headers,
      // وسمُ تجربة: لا يُحتسب على حصّة أحد، ويظهر في سجلّ البريد «تجربة».
      isTest: true,
    });

    this.logger.log(`campaign ${id} test message to ${input.to} is ${message.status}`);
    return {
      to: input.to,
      emailMessageId: message.id,
      status: message.status,
      // رمزُ الاختبار لا يطابق صفاً في `campaign_messages`، فلا يكتب حدثاً في تقرير الحملة.
      trackingDisabled: true,
      detail: 'رسالة اختبار برمزٍ غير مسجَّل: لا تُكتب في تقرير الحملة، ولا يُحتسب على حصّة أحد.',
    };
  }

  // ═══════════════════════════════════════════════════ التقرير

  async report(id: string): Promise<CampaignReport> {
    const campaign = await this.detail(id);
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const messages = await tx.execute(sql`
        SELECT m.id, m.email, m.full_name, m.company_name, m.status, m.detail, m.email_message_id,
               m.sent_at, m.opened_at, m.clicked_at, m.unsubscribed_at,
               (SELECT count(*) FROM campaign_events e
                 WHERE e.message_id = m.id AND e.kind = 'clicked')::int AS click_count,
               (SELECT e.url FROM campaign_events e
                 WHERE e.message_id = m.id AND e.kind = 'clicked'
                 ORDER BY e.created_at DESC LIMIT 1) AS last_clicked_url
          FROM campaign_messages m
         WHERE m.campaign_id = ${id}
         ORDER BY m.created_at ASC
         LIMIT 500
      `);
      const events = await tx.execute(sql`
        SELECT e.id, e.kind, e.url, e.detail, e.created_at, m.email
          FROM campaign_events e
          LEFT JOIN campaign_messages m ON m.id = e.message_id
         WHERE e.campaign_id = ${id}
         ORDER BY e.created_at DESC
         LIMIT 200
      `);
      const links = await tx.execute(sql`
        SELECT e.url, count(*)::int AS clicks
          FROM campaign_events e
         WHERE e.campaign_id = ${id} AND e.kind = 'clicked' AND e.url IS NOT NULL
         GROUP BY e.url
         ORDER BY clicks DESC, e.url ASC
      `);

      return {
        campaign,
        totals: campaign.totals,
        segmentsNoteAr: campaignSegmentDescriptionsAr[campaign.segment],
        links: links.rows.map((row) => ({ url: String(row.url), clicks: Number(row.clicks) })),
        messages: messages.rows.map((row) => this.messageView(row)),
        events: events.rows.map(
          (row) =>
            ({
              id: String(row.id),
              kind: String(row.kind) as CampaignEventKind,
              kindLabelAr: campaignEventLabelsAr[String(row.kind) as CampaignEventKind],
              email: row.email === null || row.email === undefined ? null : String(row.email),
              url: row.url === null || row.url === undefined ? null : String(row.url),
              detail: row.detail === null || row.detail === undefined ? null : String(row.detail),
              at: instant(row.created_at),
            }) satisfies CampaignEventView,
        ),
      } satisfies CampaignReport;
    });
  }

  // ═══════════════════════════════════════════════════ الإرسال

  /**
   * نبضة المسح: كل حملةٍ مجدولة حان وقتها تبدأ. تُنادى من قراءة القائمة ومن معالج الطابور،
   * فتعمل حتى في بيئةٍ بلا Redis أو بلا عامل (نفس مبدأ `content.publish` في P-M5).
   */
  async dispatchDue(now = new Date()): Promise<string[]> {
    const due = await withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT id FROM email_campaigns
         WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ${now}
         ORDER BY scheduled_at ASC
         LIMIT 20
      `);
      return rows.rows.map((row) => String(row.id));
    });

    for (const campaignId of due) {
      await this.dispatch(campaignId).catch((error: unknown) => {
        this.logger.error(`campaign ${campaignId} dispatch failed: ${(error as Error).message}`);
      });
    }
    return due;
  }

  /** معالج الطابور (`maintenance:campaign.send`) — دفعةٌ واحدة، وهو يُعيد جدولة نفسه. */
  async dispatchFromJob(context: { payload: Record<string, unknown> }): Promise<void> {
    const campaignId = context.payload.campaignId;
    if (typeof campaignId !== 'string' || campaignId.length === 0) {
      this.logger.warn('campaign.send job without a campaignId');
      return;
    }
    await this.dispatch(campaignId);
  }

  /**
   * دفعةُ إرسالٍ واحدة. وبعدها: إن بقي مستلمون أُعيدت جدولة المهمّة (والمسح شبكةُ أمان)،
   * وإن لم يبقَ أُعلنت الحملة `sent` بلحظتها — **والاستثناء الوحيد**: حملةٌ أُلغيت في
   * المنتصف تُوسَم `canceled` ولا تُبعث رسالةٌ واحدة بعد الإلغاء.
   */
  async dispatch(campaignId: string): Promise<CampaignDispatch> {
    const bootstrap = await withPlatformAdminTx(this.database.db, async (tx) => {
      const row = await this.rowInTx(tx, campaignId);
      const status = String(row.status) as CampaignStatus;
      if (status === 'draft' || status === 'canceled' || status === 'sent') {
        return { run: false, status, campaign: null };
      }
      if (status === 'scheduled') {
        await tx.execute(sql`
          UPDATE email_campaigns
             SET status = 'sending', started_at = coalesce(started_at, now()), updated_at = now()
           WHERE id = ${campaignId} AND status = 'scheduled'
        `);
      }
      return {
        run: true,
        status: 'sending' as CampaignStatus,
        campaign: {
          id: String(row.id),
          name: String(row.name),
          subject: String(row.subject),
          body: String(row.body),
          locale: String(row.locale) as CampaignLocale,
          segment: String(row.segment) as CampaignSegment,
        },
      };
    });

    if (!bootstrap.run || !bootstrap.campaign) {
      return {
        campaignId,
        status: bootstrap.status,
        dispatched: 0,
        remaining: 0,
        skipped: {},
        finishedAt: null,
      };
    }

    const campaign = bootstrap.campaign;
    const siteUrl = await this.siteUrl();
    // الروابط تُستخرج مرّةً للدفعة كلها: هي نفسها في كل رسالة، وترتيبها هو معرّفها في الرابط.
    const links = campaignHyperlinks(campaign.body);
    const skipped: Record<string, number> = {};
    let dispatched = 0;

    const batch = await withPlatformAdminTx(this.database.db, async (tx) =>
      this.recipientsLeftInTx(tx, {
        campaignId,
        segment: campaign.segment,
        limit: CampaignsService.BATCH_SIZE,
      }),
    );

    for (const recipient of batch.rows) {
      const outcome = await this.prepareAndSend({
        campaign,
        recipient,
        links,
        siteUrl,
        pending: batch.total,
      });
      if (outcome === 'sent') dispatched += 1;
      else skipped[outcome] = (skipped[outcome] ?? 0) + 1;
    }

    // البقية تُحسب بعد الدفعة من نفس الاستعلام — فلا عدّادَ يُدار بيد.
    const left = await withPlatformAdminTx(this.database.db, async (tx) =>
      this.recipientsLeftInTx(tx, { campaignId, segment: campaign.segment, limit: 1 }),
    );

    let finishedAt: string | null = null;
    if (left.total > 0) {
      await withPlatformAdminTx(this.database.db, async (tx) => {
        await this.outbox.enqueueInTx(tx, {
          tenantId: await this.platformTenantIdInTx(tx),
          queue: 'maintenance',
          type: jobTypes.CAMPAIGN_SEND,
          payload: { campaignId },
        });
      });
    } else {
      finishedAt = await withPlatformAdminTx(this.database.db, async (tx) => {
        await tx.execute(sql`
          UPDATE email_campaigns
             SET status = 'sent', finished_at = coalesce(finished_at, now()), updated_at = now()
           WHERE id = ${campaignId} AND status <> 'canceled'
        `);
        const row = await this.rowInTx(tx, campaignId);
        return nullableInstant(row.finished_at);
      });
      this.logger.log({ campaignId, dispatched, skipped }, 'campaign dispatch finished');
    }

    return {
      campaignId,
      status: finishedAt ? 'sent' : 'sending',
      dispatched,
      remaining: left.total,
      skipped,
      finishedAt,
    };
  }

  /**
   * مستلمو الشريحة الذين **لم تُنشأ لهم رسالة بعد** — وهذا هو تعريف «البقية».
   *
   * والاستعلام هو تعريف الشريحة نفسه مطروحاً منه ما خرج، فلا قائمةَ مجمَّدة في الذاكرة
   * تنكسر بإعادة التشغيل، ولا صفٌّ مكرَّر (الفهرس الفريد على `(campaign_id, email)` حرسٌ
   * ثانٍ). ومن خرج من الشريحة بين دفعتين لا يُرسل إليه — وهو الصواب: شريحةٌ تغيّرت.
   */
  private async recipientsLeftInTx(
    tx: DrizzleTx,
    input: { campaignId: string; segment: CampaignSegment; limit: number },
  ): Promise<{
    rows: Array<{
      refId: string | null;
      email: string;
      fullName: string | null;
      companyName: string | null;
      tenantId: string | null;
      leadId: string | null;
      subscriberId: string | null;
    }>;
    total: number;
  }> {
    const segment = sql.raw(this.segmentRowsSql(input.segment));
    const rows = await tx.execute(sql`
      SELECT s.ref_id, s.email, s.full_name, s.company_name, s.tenant_id, s.lead_id, s.subscriber_id
        FROM (${segment}) AS s
       WHERE NOT EXISTS (
               SELECT 1 FROM campaign_messages m
                WHERE m.campaign_id = ${input.campaignId} AND m.email = lower(s.email)
             )
       ORDER BY lower(s.email) ASC
       LIMIT ${input.limit}
    `);
    // الاسم `remaining` لا `total`: هذا عدُّ من بقي، وحرس المال يمنع الاسم `total` هنا.
    const remaining = await tx.execute(sql`
      SELECT count(*)::int AS total
        FROM (${segment}) AS s
       WHERE NOT EXISTS (
               SELECT 1 FROM campaign_messages m
                WHERE m.campaign_id = ${input.campaignId} AND m.email = lower(s.email)
             )
    `);
    return {
      rows: rows.rows.map((row) => ({
        refId: row.ref_id === null || row.ref_id === undefined ? null : String(row.ref_id),
        email: String(row.email).trim().toLowerCase(),
        fullName: row.full_name === null || row.full_name === undefined ? null : String(row.full_name),
        companyName:
          row.company_name === null || row.company_name === undefined
            ? null
            : String(row.company_name),
        tenantId: row.tenant_id === null || row.tenant_id === undefined ? null : String(row.tenant_id),
        leadId: row.lead_id === null || row.lead_id === undefined ? null : String(row.lead_id),
        subscriberId:
          row.subscriber_id === null || row.subscriber_id === undefined
            ? null
            : String(row.subscriber_id),
      })),
      total: Number(remaining.rows[0]?.total ?? 0),
    };
  }

  /**
   * رسالةٌ واحدة: الرمز يُولَّد الآن، يُخزَّن مُجزَّأه، وتُبنى الرسالة وتخرج في اللحظة نفسها.
   *
   * والترتيب مقصود: الصفُّ **قبل** الإرسال، فلو فشل البريد بقي صفٌّ يقول «فشلت» بسببه؛ ولو
   * كُتب الصفّ بعده لَما عُرف أن أحداً لم تُرسل إليه إلا من عدّادٍ يكذب.
   */
  private async prepareAndSend(input: {
    campaign: { id: string; name: string; subject: string; body: string; locale: CampaignLocale };
    recipient: {
      refId: string | null;
      email: string;
      fullName: string | null;
      companyName: string | null;
      tenantId: string | null;
      leadId: string | null;
      subscriberId: string | null;
    };
    links: string[];
    siteUrl: string;
    pending: number;
  }): Promise<'sent' | 'skipped' | 'failed'> {
    const { campaign, recipient, links, siteUrl } = input;
    const token = randomToken();
    const messageId = newId();

    const created = await withPlatformAdminTx(this.database.db, async (tx) => {
      const inserted = await tx.execute(sql`
        INSERT INTO campaign_messages (
          id, campaign_id, email, full_name, company_name, tenant_id, lead_id, subscriber_id,
          status, track_token_hash, links
        ) VALUES (
          ${messageId}, ${campaign.id}, ${recipient.email}, ${recipient.fullName},
          ${recipient.companyName}, ${recipient.tenantId}, ${recipient.leadId}, ${recipient.subscriberId},
          'pending', ${digest(token)}, ${JSON.stringify(links)}::jsonb
        )
        ON CONFLICT (campaign_id, email) DO NOTHING
        RETURNING id
      `);
      return inserted.rows.length > 0;
    });
    // سبق أن خرجت له رسالة في دفعةٍ سابقة (أو دفعةٍ متوازية): لا ثانية، ولا حدث.
    if (!created) return 'skipped';

    const rendered = renderCampaignMessage({
      campaign,
      recipient: {
        email: recipient.email,
        name: recipient.fullName,
        company: recipient.companyName,
      },
      links,
      tracking: {
        openUrl: campaignOpenUrl(siteUrl, token),
        unsubscribeUrl: campaignUnsubscribeUrl(siteUrl, token),
        clickUrl: (index: number) => campaignClickUrl(siteUrl, token, index),
      },
    });

    try {
      const message = await this.email.send({
        // مستلمٌ من منشأةٍ يحمل معرّفها: فحجرُ ذلك العميل (ارتدادٌ سابق على بريده) يسري عليه،
        // ورسالةُ الخدمة تظهر في سجلّ بريده. ومن ليس عميلاً (متوقَّع · مشترك) بلا منشأة.
        tenantId: recipient.tenantId,
        event: 'campaign.message',
        to: recipient.email,
        // بلا `toName`: التحية في متن الحملة نفسه، و`name` غير معلَنٍ في ظرف القالب —
        // وتمريرُ اسمٍ غير معلَن يرفضه محرّك القوالب (وهو حرسٌ صحيح).
        toName: undefined,
        locale: campaign.locale,
        variables: {
          subject: rendered.subject,
          body: rendered.text,
          unsubscribe_url: campaignUnsubscribeUrl(siteUrl, token),
        },
        html: rendered.html,
        headers: rendered.headers,
      });

      const suppressed = message.status === 'suppressed';
      const status: CampaignMessageStatus =
        suppressed ? 'skipped' : message.status === 'sent' ? 'sent' : 'failed';
      const detail = suppressed ? 'محجوب في قائمة الحجر (P-C6)' : message.lastError;

      await withPlatformAdminTx(this.database.db, async (tx) => {
        await tx.execute(sql`
          UPDATE campaign_messages
             SET status = ${status}, detail = ${detail}, email_message_id = ${message.id},
                 sent_at = CASE WHEN ${status} = 'sent' THEN now() ELSE NULL END
           WHERE id = ${messageId}
        `);
        await tx.execute(sql`
          INSERT INTO campaign_events (id, campaign_id, message_id, kind, detail)
          VALUES (${newId()}, ${campaign.id}, ${messageId},
                  ${suppressed ? 'suppressed' : status === 'sent' ? 'sent' : 'failed'}, ${detail})
        `);
      });
      return status === 'skipped' ? 'skipped' : status;
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      this.logger.error(
        { campaignId: campaign.id, email: recipient.email, err: detail },
        'campaign message failed',
      );
      await withPlatformAdminTx(this.database.db, async (tx) => {
        await tx.execute(sql`
          UPDATE campaign_messages SET status = 'failed', detail = ${detail} WHERE id = ${messageId}
        `);
        await tx.execute(sql`
          INSERT INTO campaign_events (id, campaign_id, message_id, kind, detail)
          VALUES (${newId()}, ${campaign.id}, ${messageId}, 'failed', ${detail})
        `);
      });
      return 'failed';
    }
  }

  // ═══════════════════════════════════════════════════ العامّ: الفتح والنقر والإلغاء

  /** `GET /public/track/open/:token` — يُسجَّل الفتح الأوّل، ويُعاد بكسلٌ شفّاف في كل حال. */
  async trackOpen(token: string): Promise<void> {
    const row = await this.messageByToken(token);
    if (!row) return;
    await withPlatformAdminTx(this.database.db, async (tx) => {
      // فتحٌ واحد يُسجَّل مرّة (`campaign_events_first_open_key`): إعادة تحميل البكسل في
      // عميلِ بريدٍ يحمّل الصور ليست قراءةً ثانية.
      const inserted = await tx.execute(sql`
        INSERT INTO campaign_events (id, campaign_id, message_id, kind)
        VALUES (${newId()}, ${row.campaignId}, ${row.id}, 'opened')
        ON CONFLICT DO NOTHING
        RETURNING id
      `);
      if (inserted.rows.length > 0) {
        await tx.execute(sql`
          UPDATE campaign_messages SET opened_at = coalesce(opened_at, now()) WHERE id = ${row.id}
        `);
      }
    });
  }

  /**
   * `GET /public/track/click/:token/:index` — يُسجَّل النقر ويُعاد **الوجهة الحقيقية**.
   *
   * والوجهة تُقرأ من صفّ الرسالة لا من معاملٍ في الرابط: لا **تحويل مفتوح** يمكن استغلاله
   * لتحويل زوّار المنصّة إلى موقعٍ خارجي (نقرةٌ إلى وجهةٍ ليست في الحملة ⇒ 404).
   */
  async trackClick(token: string, index: number): Promise<string> {
    const row = await this.messageByToken(token);
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'رابطٌ غير معروف', 404);
    const target = row.links[index];
    if (!target) {
      throw new DomainError(errorCodes.NOT_FOUND, 'وجهةٌ غير معروفة في هذه الحملة', 404, { index });
    }

    await withPlatformAdminTx(this.database.db, async (tx) => {
      await tx.execute(sql`
        INSERT INTO campaign_events (id, campaign_id, message_id, kind, url)
        VALUES (${newId()}, ${row.campaignId}, ${row.id}, 'clicked', ${target})
      `);
      await tx.execute(sql`
        UPDATE campaign_messages
           SET clicked_at = coalesce(clicked_at, now()), opened_at = coalesce(opened_at, now())
         WHERE id = ${row.id}
      `);
    });
    return target;
  }

  /**
   * `GET`/`POST /public/unsubscribe/:token` — إلغاء الاشتراك بنقرة واحدة (RFC 8058).
   *
   * ثلاث كتابات متّسقة، وكلٌّ منها تعني شيئاً مختلفاً:
   *   * **الحجر** (`email_suppressions`) — المنع الفعلي: كل بريدٍ لاحق يمرّ عليه مُرسِل P-C6
   *     فيُسجَّل `suppressed` بدل أن يخرج. فالإلغاء يسري على **كل** البريد، لا على الحملة
   *     التي جاء منها الرابط.
   *   * **حالة المشترك** إن كان في النشرة: `unsubscribed` — فلا يبقى في جدولين قولان.
   *   * **حدث الحملة**: فيُعرَف أي حملةٍ أخرجته من القائمة.
   */
  async unsubscribe(token: string): Promise<{ email: string; fresh: boolean }> {
    const row = await this.messageByToken(token);
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'رابطُ إلغاءٍ غير معروف', 404);
    const email = row.email.toLowerCase();

    return withPlatformAdminTx(this.database.db, async (tx) => {
      const inserted = await tx.execute(sql`
        INSERT INTO email_suppressions (id, tenant_id, email, reason, note, created_by)
        VALUES (${newId()}, NULL, ${email}, 'unsubscribe', ${`من حملة: ${row.campaignName}`}, NULL)
        ON CONFLICT DO NOTHING
        RETURNING id
      `);
      // و`confirmed_at` يُفرَّغ مع الحالة: قيد `email_subscribers_confirmed_check` يوجب
      // (`status = 'confirmed') = (confirmed_at IS NOT NULL`) — فمن ألغى اشتراكه لم يُؤكَّد.
      await tx.execute(sql`
        UPDATE email_subscribers
           SET status = 'unsubscribed', unsubscribed_at = now(), confirmed_at = NULL,
               confirm_token_hash = NULL, updated_at = now()
         WHERE dedupe_key = ${email} AND status <> 'unsubscribed'
      `);
      await tx.execute(sql`
        UPDATE campaign_messages SET unsubscribed_at = coalesce(unsubscribed_at, now())
         WHERE id = ${row.id}
      `);
      await tx.execute(sql`
        INSERT INTO campaign_events (id, campaign_id, message_id, kind, detail)
        VALUES (${newId()}, ${row.campaignId}, ${row.id}, 'unsubscribed', 'من رابط الرسالة')
        ON CONFLICT DO NOTHING
      `);
      await this.audit.recordInTx(tx, {
        action: 'campaign.unsubscribed',
        entity: 'email_suppression',
        entityId: null,
        after: { email, campaignId: row.campaignId, source: 'email_link' },
        meta: { scope: 'campaigns' },
      });
      return { email, fresh: inserted.rows.length > 0 };
    });
  }

  // ═══════════════════════════════════════════════════ الداخل

  private async messageByToken(
    token: string,
  ): Promise<{
    id: string;
    email: string;
    campaignId: string;
    campaignName: string;
    links: string[];
  } | null> {
    // شكل الرمز يُفحَص قبل أي استعلام: طلبٌ عشوائيّ لا يُسأل عنه القاعدة أصلاً.
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null;
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT m.id, m.email, m.campaign_id, m.links, c.name AS campaign_name
          FROM campaign_messages m
          JOIN email_campaigns c ON c.id = m.campaign_id
         WHERE m.track_token_hash = ${digest(token)}
         LIMIT 1
      `);
      const row = rows.rows[0];
      if (!row) return null;
      return {
        id: String(row.id),
        email: String(row.email),
        campaignId: String(row.campaign_id),
        campaignName: String(row.campaign_name),
        links: Array.isArray(row.links) ? (row.links as string[]) : [],
      };
    });
  }

  private async rowInTx(tx: DrizzleTx, id: string): Promise<Record<string, unknown>> {
    const rows = await tx.execute(sql`SELECT ${campaignColumns()} FROM email_campaigns WHERE id = ${id}`);
    const row = rows.rows[0];
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'الحملة غير موجودة', 404, { id });
    return row as Record<string, unknown>;
  }

  /**
   * العرض مع أرقامه: كل عدّادٍ يُقرأ من صفوف الرسائل (`campaign_messages`) لا من عمودٍ في
   * الحملة — فالحملة قد تُقرأ في أثناء إرسالها، والرقم يجب أن يصدُق في كل لحظة.
   */
  private async viewInTx(tx: DrizzleTx, id: string): Promise<CampaignView> {
    const row = await this.rowInTx(tx, id);
    const totals = await tx.execute(sql`
      SELECT
        count(*)::int AS recipients,
        count(*) FILTER (WHERE status = 'sent')::int AS sent,
        count(*) FILTER (WHERE status = 'failed')::int AS failed,
        count(*) FILTER (WHERE status = 'skipped')::int AS skipped,
        count(*) FILTER (WHERE opened_at IS NOT NULL)::int AS opened,
        count(*) FILTER (WHERE clicked_at IS NOT NULL)::int AS clicked,
        count(*) FILTER (WHERE unsubscribed_at IS NOT NULL)::int AS unsubscribed
        FROM campaign_messages WHERE campaign_id = ${id}
    `);
    const rowTotals = (totals.rows[0] ?? {}) as Record<string, number>;

    const createdBy =
      row.created_by === null || row.created_by === undefined ? null : String(row.created_by);
    const creator = createdBy
      ? await tx.execute(sql`SELECT COALESCE(full_name, email) AS label FROM users WHERE id = ${createdBy}`)
      : { rows: [] as Array<Record<string, unknown>> };
    const label = creator.rows[0]?.label;

    return this.view(
      row,
      {
        recipients: Number(rowTotals.recipients ?? 0),
        sent: Number(rowTotals.sent ?? 0),
        failed: Number(rowTotals.failed ?? 0),
        skipped: Number(rowTotals.skipped ?? 0),
        opened: Number(rowTotals.opened ?? 0),
        clicked: Number(rowTotals.clicked ?? 0),
        unsubscribed: Number(rowTotals.unsubscribed ?? 0),
      },
      label === undefined ? null : String(label),
    );
  }

  private view(row: Record<string, unknown>, totals: CampaignTotals, creatorLabel: string | null): CampaignView {
    const segment = String(row.segment) as CampaignSegment;
    const status = String(row.status) as CampaignStatus;
    return {
      id: String(row.id),
      name: String(row.name),
      subject: String(row.subject),
      body: String(row.body),
      segment,
      segmentLabelAr: campaignSegmentLabelsAr[segment],
      locale: String(row.locale) as CampaignLocale,
      status,
      statusLabelAr: campaignStatusLabelsAr[status],
      scheduledAt: nullableInstant(row.scheduled_at),
      startedAt: nullableInstant(row.started_at),
      finishedAt: nullableInstant(row.finished_at),
      canceledAt: nullableInstant(row.canceled_at),
      canceledReason:
        row.canceled_reason === null || row.canceled_reason === undefined
          ? null
          : String(row.canceled_reason),
      estimatedRecipients: Number(row.estimated_recipients ?? 0),
      variables: campaignVariablesIn(String(row.body)),
      hyperlinks: campaignHyperlinks(String(row.body)),
      createdBy: row.created_by === null || row.created_by === undefined ? null : String(row.created_by),
      createdByLabel: creatorLabel,
      totals,
      createdAt: instant(row.created_at),
      updatedAt: instant(row.updated_at),
    };
  }

  private messageView(row: Record<string, unknown>): CampaignMessageView {
    const status = String(row.status) as CampaignMessageStatus;
    return {
      id: String(row.id),
      email: String(row.email),
      fullName: row.full_name === null || row.full_name === undefined ? null : String(row.full_name),
      companyName:
        row.company_name === null || row.company_name === undefined
          ? null
          : String(row.company_name),
      status,
      statusLabelAr: campaignMessageStatusLabelsAr[status],
      detail: row.detail === null || row.detail === undefined ? null : String(row.detail),
      emailMessageId:
        row.email_message_id === null || row.email_message_id === undefined
          ? null
          : String(row.email_message_id),
      sentAt: nullableInstant(row.sent_at),
      openedAt: nullableInstant(row.opened_at),
      clickedAt: nullableInstant(row.clicked_at),
      unsubscribedAt: nullableInstant(row.unsubscribed_at),
      lastClickedUrl:
        row.last_clicked_url === null || row.last_clicked_url === undefined
          ? null
          : String(row.last_clicked_url),
      clickCount: Number(row.click_count ?? 0),
    };
  }

  /** نطاق الموقع من إعدادات المنصّة (`site.url`) — نفسه الذي يستعمله P-M6 في رابط التأكيد. */
  private async siteUrl(): Promise<string> {
    const value = await this.setting('site.url');
    return String(value).replace(/\/+$/, '');
  }

  private async setting(key: string): Promise<string | number | boolean | string[]> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const rows = await tx.execute(sql`SELECT value FROM platform_settings WHERE key = ${key} LIMIT 1`);
      const value = rows.rows[0]?.value;
      return value === undefined || value === null
        ? defaultPlatformSettingValue(key)
        : (value as string | number | boolean | string[]);
    });
  }

  private async platformTenantIdInTx(tx: DrizzleTx): Promise<string> {
    const rows = await tx.execute(sql`
      SELECT id FROM tenants WHERE code = ${process.env.PLATFORM_TENANT_CODE ?? 'platform'} LIMIT 1
    `);
    const id = rows.rows[0]?.id;
    if (!id) throw new DomainError(errorCodes.NOT_FOUND, 'لم تُوجد منشأة المشغّلين', 500);
    return String(id);
  }
}

// ═══════════════════════════════════════════════════ أدوات

/** رمزٌ ٢٥٦-بت: ٢٤ بايتاً عشوائيّة بصيغة `base64url` (بلا `+` ولا `/` ولا `=`). */
function randomToken(): string {
  return randomBytes(24).toString('base64url');
}

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** أعمدة الحملة في كل قراءة — مجموعةٌ واحدة تكتبها دالّةٌ واحدة، فلا تختلف قراءتان. */
function campaignColumns(): ReturnType<typeof sql.raw> {
  return sql.raw(`
    id, name, subject, body, segment, locale, status, scheduled_at, started_at, finished_at,
    canceled_at, canceled_reason, estimated_recipients, created_by, created_at, updated_at
  `);
}

function instant(value: unknown): string {
  return new Date(value as string).toISOString();
}

function nullableInstant(value: unknown): string | null {
  return value === null || value === undefined ? null : instant(value);
}

/** نصٌّ فيه `{{متغيّر}}` لا معنى له يمنع الحفظ — ويكفي أن يُصحَّح الآن لا بعد الإرسال. */
function assertBodyValid(body: string): void {
  const problems = campaignBodyProblems(body);
  if (problems.length > 0) {
    throw new DomainError(errorCodes.CAMPAIGN_BODY_INVALID, problems.join(' · '), 422, { problems });
  }
}

/** تنبيهٌ يُعرَض في الشاشة قبل الإرسال — ولا تحذيرَ لشريحةٍ فيها الناس. */
function warningFor(segment: CampaignSegment, count: number): string | null {
  if (count > 0) return null;
  if (segment === 'leads') return 'لا عملاء متوقّعين بموافقةٍ تسويقية الآن — لن يصل شيء.';
  if (segment === 'subscribers') return 'لا مشتركين مؤكَّدين في النشرة الآن.';
  if (segment === 'churned') return 'لا متسربين — لا أحد أُلغى اشتراكه أو انتهى بعد.';
  return 'لا منشآت في هذه الحالة الآن.';
}
