import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import {
  DomainError,
  errorCodes,
  platformSettingDefinitions,
  usageAuditActions,
  usageMetricDefinition,
  usageMetricRegistry,
  usagePercentUsed,
  usagePeriodOf,
  usageSoftThresholdPercent,
  usageStateFor,
  type PlatformUsageGridResponse,
  type PlatformUsageGridRow,
  type UsageMetricKey,
  type UsageMetricState,
  type UsageMetricUsage,
  type UsageSnapshot,
} from '@erp/contracts';
import {
  newId,
  withPlatformAdminTx,
  withTenantTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
// مسار مباشر لا برميل: البرميل يعيد تصدير `PlatformServicesModule` الذي يوفّر
// `FilesService`، وهذا الأخير يستدعي `UsageService` — فكانت الحلقة (Nest: «circular
// dependency inside UsageModule»). الوحدة عالمية، و`AuditService` يُحقن منها بلا حاجة
// إلى استيراد الوحدة نفسها.
import { AuditService } from '../platform-services/audit/audit.service.js';

/** أرقام مقياسٍ واحد في لحظةٍ واحدة. */
type Measured = Record<UsageMetricKey, number>;

/** ما تحتاجه القراءة كلها: الأرقام، وسلسلة استدعاءات الـAPI، وحدود المقياس. */
type Measurement = {
  values: Map<string, Measured>;
  series: Map<string, { day: string; count: number }[]>;
};

type EffectiveLimit = {
  value: number | null;
  source: 'tenant' | 'platform' | 'default';
  enforced: boolean;
};

const SERIES_DAYS = 30;

/**
 * P-C5 — محرّك الاستخدام والحصص (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
 *
 * كل رقم في هذا الملف له **مصدر واحد**، والفهرس في `platform/usage.ts` هو مصدر التسمية:
 *
 *   - ستة مقاييس تُقرأ **حيّةً** من جداولها (`memberships` · `branches` · `items` ·
 *     `sales_invoices` · `whatsapp_messages` · `files`) — فلا يختلف «المستخدمون» في شاشة
 *     الحصص عن دليل المستخدمين، ولا يحتاج الأمر مزامنة.
 *   - مقياسان يُقرآن من `usage_counters` (استدعاءات الـAPI اليومية، وإرسالات البريد الشهرية
 *     التي تبقى صفراً حتى P-C6) — عدّادٌ يزيده الطلب نفسه.
 *
 * **الحدّ ومصدره.** الحدّ يُقرأ من `platform_settings` بالمفردات الثلاث نفسها التي أعلنها
 * P-C2 (`tenant` تجاوز العميل · `platform` افتراضٌ كتبه المشغّل · `default` فهرس P-C1)،
 * و`enforced` تقول أيقع الرفض أم لا: **الافتراضي يُبلَّغ عنه ولا يُطبَّق** (قرار P-C5 الثاني).
 *
 * **لماذا تمرّ قراءة الحدود بالطائرة الإدارية؟** صفوف المنصة في `platform_settings`
 * (`tenant_id IS NULL`) لا تراها جلسة المستأجر: سياسة العزل في 0066 تترك صفّ المنشأة وحده
 * **عمداً** («وهذا هو الفشل الآمن المقصود»). فالحدّ الذي يجب أن يُطبَّق على كتابةٍ من سطح
 * العميل يُقرأ في معاملة مشغّل — قراءةً فقط، ولا تكتب هذه الدالة صفاً واحداً هناك. وهذه هي
 * الحالة الوحيدة التي يعبر فيها سطح العميل إلى الطائرة الإدارية، وهي مذكورة في تقرير P-C5.
 *
 * **جدول `tenants` بلا RLS** (0000: «platform — no tenant_id, no RLS»)، لذلك كل قراءةٍ هنا
 * تُقيَّد بـ`t.id IN (…)`: في سطح العميل بالمعرّف الذي جاء من الرمز، وفي اللوحة بالمعرّفات
 * التي طلبتها اللوحة. والعزل الحقيقي للأرقام يقع في جداولها (`tenant_isolation`).
 *
 * **الذرّية.** الرفض قرارُ قراءةٍ ثم كتابة (عدا استدعاءات الـAPI: العدّاد يُزاد ثم يُفحص
 * فوراً، فلا يفلت طلبان متوازيان). كتابتان متوازيتان لنفس العميل قد تتجاوزان الحدّ بواحد —
 * والحدّ حصّة، لا قيداً في القاعدة، وهذا مُعلَن لا مخفيّ.
 */
@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly audit: AuditService,
  ) {}

  // ══════════════════════════════════════════════════ القراءة

  /** لقطة العميل نفسه — يُقرأ فيها سطح العميل بمعاملة مستأجر (العزل يضمن ألّا يرى غير نفسه). */
  async snapshotForTenant(tenantId: string, period: string = usagePeriodOf()): Promise<UsageSnapshot> {
    const limits = await this.limitsFor([tenantId]);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const tenant = await this.tenantInTx(tx, tenantId);
      const measured = await this.measureInTx(tx, [tenantId], period);
      return this.assemble(tenantId, tenant, period, measured, limits);
    });
  }

  /** لقطة عميلٍ من المنصة — تبويب «الاستخدام» في بطاقة العميل. */
  async snapshotForPlatform(tenantId: string, period: string = usagePeriodOf()): Promise<UsageSnapshot> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const tenant = await this.tenantInTx(tx, tenantId);
      const limits = await this.limitsInTx(tx, [tenantId]);
      const measured = await this.measureInTx(tx, [tenantId], period);
      return this.assemble(tenantId, tenant, period, measured, limits);
    });
  }

  /** شبكة اللوحة — كل العملاء باستعلامٍ لكل مقياس، لا استعلاماً لكل عميل. */
  async grid(period: string = usagePeriodOf()): Promise<PlatformUsageGridResponse> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const tenants = await tx.execute(sql`
        SELECT id, code, name, status FROM tenants
         WHERE status <> 'archived'
         ORDER BY code ASC
      `);
      const ids = tenants.rows.map((row) => String(row.id));
      const limits = await this.limitsInTx(tx, ids);
      const measured = await this.measureInTx(tx, ids, period);

      const rows: PlatformUsageGridRow[] = tenants.rows.map((tenant) => {
        const tenantId = String(tenant.id);
        const snapshot = this.assemble(
          tenantId,
          { code: String(tenant.code), name: String(tenant.name), status: String(tenant.status) },
          period,
          measured,
          limits,
        );
        return {
          tenantId,
          tenantCode: snapshot.tenantCode,
          tenantName: snapshot.tenantName,
          status: snapshot.tenantStatus,
          metrics: snapshot.metrics,
          worst: worstState(snapshot.metrics.map((metric) => metric.state)),
          softCount: snapshot.metrics.filter((metric) => metric.state === 'soft').length,
          hardCount: snapshot.metrics.filter((metric) => metric.state === 'hard').length,
        };
      });

      // «الأسوأ أولاً»: مَن بلغ الحدّ يُرى قبل مَن لا حدّ له.
      rows.sort(
        (a, b) => stateWeight(b.worst) - stateWeight(a.worst) || a.tenantCode.localeCompare(b.tenantCode, 'ar'),
      );

      const sum = (metric: UsageMetricKey) =>
        rows.reduce((acc, row) => acc + (row.metrics.find((entry) => entry.key === metric)?.used ?? 0), 0);

      return {
        period,
        periodStart: monthStartIso(period),
        periodEnd: monthEndIso(period),
        tenants: rows,
        totals: {
          tenants: rows.length,
          soft: rows.reduce((acc, row) => acc + row.softCount, 0),
          hard: rows.reduce((acc, row) => acc + row.hardCount, 0),
          apiCallsToday: sum('api_calls_per_day'),
          invoicesThisMonth: sum('invoices_per_month'),
        },
        generatedAt: new Date().toISOString(),
      };
    });
  }

  /** سطور تصدير الشبكة — تُبنى من الشبكة نفسها فلا يخرج ملفٌّ يخالف الشاشة. */
  async exportRows(period: string = usagePeriodOf()): Promise<string[][]> {
    const grid = await this.grid(period);
    const rows: string[][] = [
      [
        'period',
        'tenantCode',
        'tenantName',
        'metric',
        'labelAr',
        'used',
        'limit',
        'limitSource',
        'percentUsed',
        'state',
        'enforced',
      ],
    ];
    for (const tenant of grid.tenants) {
      for (const metric of tenant.metrics) {
        rows.push([
          grid.period,
          tenant.tenantCode,
          tenant.tenantName,
          metric.key,
          metric.labelAr,
          String(metric.used),
          metric.limit === null ? '' : String(metric.limit),
          metric.limitSource,
          metric.percentUsed === null ? '' : String(metric.percentUsed),
          metric.state,
          metric.enforced ? 'yes' : 'no',
        ]);
      }
    }
    return rows;
  }

  // ══════════════════════════════════════════════════ الكتابة

  /**
   * زيادة عدّادٍ ذرّية وإرجاع قيمته الجديدة. الفترة تُشتقّ من المقياس نفسه (يومي/شهري)، فلا
   * يكتب المستدعي تقويماً.
   */
  async record(tenantId: string, metric: UsageMetricKey, by = 1): Promise<number> {
    const definition = usageMetricDefinition(metric);
    if (definition.source !== 'counter') {
      // مقاييس الجدول لا تُعدّ: عدّادٌ لها يعني رقماً لا يُقرأ ويخالف الدليل.
      throw new DomainError(
        errorCodes.VALIDATION_FAILED,
        `${definition.labelAr} يُقاس من الجدول لا من عدّاد`,
        400,
        { metric },
      );
    }
    const period = definition.period === 'day' ? todayIso() : usagePeriodOf();
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const result = await tx.execute(sql`
        INSERT INTO usage_counters (id, tenant_id, metric, period, value, created_at, updated_at)
        VALUES (${newId()}, ${tenantId}, ${metric}, ${period}, ${by}, now(), now())
        ON CONFLICT (tenant_id, metric, period)
        DO UPDATE SET value = usage_counters.value + ${by}, updated_at = now()
        RETURNING value::int AS value
      `);
      return Number(result.rows[0]?.value ?? 0);
    });
  }

  /**
   * عدّاد استدعاءات الـAPI: يُزاد **ثم** يُفحص، فالرفض عند الحدّ لا يسمح بطلبٍ إضافي ولا
   * يفلت منه طلبان متوازيان. والقياس لا يُسقِط الطلب عند خطأ قاعدة: سجلٌّ مفقود أهون من
   * خدمةٍ معطَّلة.
   */
  async meterApiCall(tenantId: string): Promise<void> {
    let value: number;
    try {
      value = await this.record(tenantId, 'api_calls_per_day');
    } catch (error) {
      this.logger.warn(`usage meter failed for ${tenantId}: ${(error as Error).message}`);
      return;
    }
    const limit = (await this.limitsFor([tenantId])).get('api_calls_per_day');
    if (!limit || !limit.enforced || limit.value === null) return;
    if (value > limit.value) {
      await this.auditOnce(tenantId, usageAuditActions.limitReached, 'api_calls_per_day', {
        used: value,
        limit: limit.value,
        limitSource: limit.source,
      });
      throw new DomainError(
        errorCodes.USAGE_LIMIT_REACHED,
        `بلغ العميل حدّ ${usageMetricDefinition('api_calls_per_day').labelAr} (${value} من ${limit.value})`,
        409,
        { metric: 'api_calls_per_day', used: value, limit: limit.value },
      );
    }
    await this.notifySoft(tenantId, 'api_calls_per_day', value, limit);
  }

  /**
   * حرّاس الكتابة في سطح العميل: يُنادى **قبل** الإنشاء، ويرمي `USAGE_LIMIT_REACHED` (409)
   * حين يكون الحدّ مطبَّقاً ويبلغه العميل — ويُسجَّل الرفض في تدقيق العميل مرة واحدة للفترة.
   */
  async assertWithinLimit(tenantId: string, metric: UsageMetricKey, by = 1): Promise<void> {
    const limits = await this.limitsFor([tenantId]);
    const limit = limits.get(metric);
    if (!limit || !limit.enforced || limit.value === null) return;

    const used = await this.usedFor(tenantId, metric);
    const after = used + by;
    if (after > limit.value) {
      await this.auditOnce(tenantId, usageAuditActions.limitReached, metric, {
        used,
        would: after,
        limit: limit.value,
        limitSource: limit.source,
      });
      throw new DomainError(
        errorCodes.USAGE_LIMIT_REACHED,
        `بلغ العميل حدّ ${usageMetricDefinition(metric).labelAr} (${used} من ${limit.value})`,
        409,
        { metric, used, limit: limit.value, requested: by },
      );
    }
    await this.notifySoft(tenantId, metric, after, limit);
  }

  // ══════════════════════════════════════════════════ الحدود

  /** الحدود الفعّالة — استعلامٌ واحد لكل مقاييس العميل (أو العملاء). */
  private async limitsFor(tenantIds: string[]): Promise<Map<UsageMetricKey, EffectiveLimit>> {
    return withPlatformAdminTx(this.database.db, (tx) => this.limitsInTx(tx, tenantIds));
  }

  private async limitsInTx(tx: DrizzleTx, tenantIds: string[]): Promise<Map<UsageMetricKey, EffectiveLimit>> {
    const out = new Map<UsageMetricKey, EffectiveLimit>();
    const defaults = new Map(
      usageMetricRegistry.map((metric) => {
        const definition = platformSettingDefinitions.find((entry) => entry.key === metric.limitKey);
        return [
          metric.key,
          typeof definition?.defaultValue === 'number' ? definition.defaultValue : null,
        ] as const;
      }),
    );

    if (tenantIds.length === 0) {
      for (const metric of usageMetricRegistry) {
        out.set(metric.key, { value: defaults.get(metric.key) ?? null, source: 'default', enforced: false });
      }
      return out;
    }

    const rows = await tx.execute(sql`
      SELECT tenant_id, key, value FROM platform_settings
       WHERE key IN (${keyList()})
         AND (tenant_id IS NULL OR tenant_id IN (${uuidList(tenantIds)}))
    `);

    for (const metric of usageMetricRegistry) {
      const tenantRow = rows.rows.find(
        (row) =>
          row.key === metric.limitKey &&
          row.tenant_id !== null &&
          tenantIds.includes(String(row.tenant_id)),
      );
      const platformRow = rows.rows.find((row) => row.key === metric.limitKey && row.tenant_id === null);
      const row = tenantRow ?? platformRow;
      const value = numericValue(row?.value);
      const source: EffectiveLimit['source'] = tenantRow ? 'tenant' : platformRow ? 'platform' : 'default';
      out.set(metric.key, {
        // صفٌّ بقيمة `null` يعني «لا حدّ» (المشغّل أفرغه) — لا يعني «افتراضي».
        value: row ? value : (defaults.get(metric.key) ?? null),
        source,
        enforced: source !== 'default' && value !== null,
      });
    }
    return out;
  }

  /** استهلاك مقياسٍ واحد الآن — يُقرأ في الطائرة الإدارية (الفحص قبل الكتابة). */
  private async usedFor(tenantId: string, metric: UsageMetricKey): Promise<number> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const measured = await this.measureInTx(tx, [tenantId], usagePeriodOf());
      return measured.values.get(tenantId)?.[metric] ?? 0;
    });
  }

  // ══════════════════════════════════════════════════ القياس

  /** كل الأرقام في معاملةٍ واحدة، وسلسلة استدعاءات الـAPI لثلاثين يوماً بجانبها. */
  private async measureInTx(tx: DrizzleTx, tenantIds: string[], period: string): Promise<Measurement> {
    const values = new Map<string, Measured>();
    for (const tenantId of tenantIds) values.set(tenantId, emptyMeasured());
    if (tenantIds.length === 0) return { values, series: new Map() };

    const ids = uuidList(tenantIds);
    const start = monthStartIso(period);
    const end = monthEndIso(period);

    const derived = await tx.execute(sql`
      SELECT t.id AS tenant_id,
             COALESCE(m.n, 0)   AS users,
             COALESCE(b.n, 0)   AS branches,
             COALESCE(i.n, 0)   AS items,
             COALESCE(inv.n, 0) AS invoices_per_month,
             COALESCE(f.mb, 0)  AS storage_mb,
             COALESCE(w.n, 0)   AS whatsapp_per_month
        FROM tenants t
        LEFT JOIN (SELECT tenant_id, count(*)::int AS n FROM memberships
                    WHERE deleted_at IS NULL AND tenant_id IN (${ids}) GROUP BY 1) m ON m.tenant_id = t.id
        LEFT JOIN (SELECT tenant_id, count(*)::int AS n FROM branches
                    WHERE deleted_at IS NULL AND tenant_id IN (${ids}) GROUP BY 1) b ON b.tenant_id = t.id
        LEFT JOIN (SELECT tenant_id, count(*)::int AS n FROM items
                    WHERE deleted_at IS NULL AND tenant_id IN (${ids}) GROUP BY 1) i ON i.tenant_id = t.id
        LEFT JOIN (SELECT tenant_id, count(*)::int AS n FROM sales_invoices
                    WHERE tenant_id IN (${ids}) AND created_at >= ${start} AND created_at < ${end}
                    GROUP BY 1) inv ON inv.tenant_id = t.id
        LEFT JOIN (SELECT tenant_id, (COALESCE(sum(size_bytes), 0) / 1048576.0)::int AS mb FROM files
                    WHERE tenant_id IN (${ids}) AND status = 'ready' AND deleted_at IS NULL
                    GROUP BY 1) f ON f.tenant_id = t.id
        LEFT JOIN (SELECT tenant_id, count(*)::int AS n FROM whatsapp_messages
                    WHERE tenant_id IN (${ids}) AND status <> 'skipped'
                      AND created_at >= ${start} AND created_at < ${end} GROUP BY 1) w ON w.tenant_id = t.id
       WHERE t.id IN (${ids})
    `);
    for (const row of derived.rows) {
      const bucket = values.get(String(row.tenant_id));
      if (!bucket) continue;
      bucket.users = Number(row.users ?? 0);
      bucket.branches = Number(row.branches ?? 0);
      bucket.items = Number(row.items ?? 0);
      bucket.invoices_per_month = Number(row.invoices_per_month ?? 0);
      bucket.storage_mb = Number(row.storage_mb ?? 0);
      bucket.whatsapp_per_month = Number(row.whatsapp_per_month ?? 0);
    }

    const counters = await tx.execute(sql`
      SELECT tenant_id, metric, value::int AS value FROM usage_counters
       WHERE tenant_id IN (${ids})
         AND ((metric = 'api_calls_per_day' AND period = ${todayIso()})
           OR (metric = 'email_sends_per_month' AND period = ${period}))
    `);
    for (const row of counters.rows) {
      const bucket = values.get(String(row.tenant_id));
      if (!bucket) continue;
      const metric = String(row.metric) as UsageMetricKey;
      if (metric in bucket) bucket[metric] = Number(row.value ?? 0);
    }

    const series = await this.seriesInTx(tx, tenantIds);
    return { values, series };
  }

  /** سلسلة استدعاءات الـAPI لثلاثين يوماً — والأيام الغائبة تُملأ صفراً هنا لا في القاعدة. */
  private async seriesInTx(
    tx: DrizzleTx,
    tenantIds: string[],
    days = SERIES_DAYS,
  ): Promise<Map<string, { day: string; count: number }[]>> {
    const daysList: string[] = [];
    const cursor = new Date();
    cursor.setUTCHours(0, 0, 0, 0);
    for (let index = days - 1; index >= 0; index -= 1) {
      const day = new Date(cursor);
      day.setUTCDate(day.getUTCDate() - index);
      daysList.push(day.toISOString().slice(0, 10));
    }

    const perTenant = new Map<string, Map<string, number>>();
    for (const tenantId of tenantIds) perTenant.set(tenantId, new Map());
    if (tenantIds.length > 0) {
      const rows = await tx.execute(sql`
        SELECT tenant_id, period AS day, COALESCE(sum(value), 0)::int AS count FROM usage_counters
         WHERE metric = 'api_calls_per_day'
           AND tenant_id IN (${uuidList(tenantIds)})
           AND period >= ${daysList[0]}
         GROUP BY 1, 2
      `);
      for (const row of rows.rows) {
        const bucket = perTenant.get(String(row.tenant_id));
        if (!bucket) continue;
        bucket.set(String(row.day), Number(row.count ?? 0));
      }
    }

    const out = new Map<string, { day: string; count: number }[]>();
    for (const tenantId of tenantIds) {
      const counts = perTenant.get(tenantId) ?? new Map();
      out.set(
        tenantId,
        daysList.map((day) => ({ day, count: counts.get(day) ?? 0 })),
      );
    }
    return out;
  }

  // ══════════════════════════════════════════════════ التركيب

  private assemble(
    tenantId: string,
    tenant: { code: string; name: string; status: string },
    period: string,
    measured: Measurement,
    limits: Map<UsageMetricKey, EffectiveLimit>,
  ): UsageSnapshot {
    const values = measured.values.get(tenantId) ?? emptyMeasured();
    const metrics: UsageMetricUsage[] = usageMetricRegistry.map((definition) => {
      const limit = limits.get(definition.key) ?? { value: null, source: 'default' as const, enforced: false };
      const used = Number(values[definition.key] ?? 0);
      const state = usageStateFor(used, limit.value);
      return {
        key: definition.key,
        labelAr: definition.labelAr,
        unitAr: definition.unitAr,
        period: definition.period,
        used,
        limit: limit.value,
        limitSource: limit.source,
        percentUsed: usagePercentUsed(used, limit.value),
        state,
        enforced: limit.enforced,
        noticeAr: noticeFor(definition.labelAr, used, limit, state),
        enforcedAtAr: definition.enforcedAtAr,
      };
    });

    return {
      tenantId,
      tenantCode: tenant.code,
      tenantName: tenant.name,
      tenantStatus: tenant.status,
      period,
      periodStart: monthStartIso(period),
      periodEnd: monthEndIso(period),
      metrics,
      apiCallsPerDay: measured.series.get(tenantId) ?? [],
      generatedAt: new Date().toISOString(),
    };
  }

  private async tenantInTx(tx: DrizzleTx, tenantId: string): Promise<{ code: string; name: string; status: string }> {
    const rows = await tx.execute(sql`
      SELECT code, name, status FROM tenants WHERE id = ${tenantId}
    `);
    const row = rows.rows[0];
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'المنشأة غير موجودة', 404, { tenantId });
    return { code: String(row.code), name: String(row.name), status: String(row.status) };
  }

  // ══════════════════════════════════════════════════ الإشعار والتدقيق

  private async notifySoft(
    tenantId: string,
    metric: UsageMetricKey,
    after: number,
    limit: EffectiveLimit,
  ): Promise<void> {
    if (!limit.enforced || limit.value === null) return;
    const percent = usagePercentUsed(after, limit.value) ?? 0;
    if (percent < usageSoftThresholdPercent || after > limit.value) return;
    await this.auditOnce(tenantId, usageAuditActions.softLimit, metric, {
      used: after,
      limit: limit.value,
      percent,
      limitSource: limit.source,
    });
  }

  /** سطرٌ واحد لكل (منشأة، فعل، مقياس، فترة) — والوجود يُفحص في تدقيق العميل نفسه. */
  private async auditOnce(
    tenantId: string,
    action: string,
    metric: UsageMetricKey,
    meta: Record<string, unknown>,
  ): Promise<void> {
    const period = usagePeriodOf();
    try {
      await withTenantTx(this.database.db, tenantId, async (tx) => {
        const existing = await tx.execute(sql`
          SELECT 1 FROM audit_log
           WHERE tenant_id = ${tenantId} AND action = ${action}
             AND meta->>'metric' = ${metric} AND meta->>'period' = ${period}
           LIMIT 1
        `);
        if (existing.rows.length > 0) return;
        await this.audit.recordInTx(tx, {
          tenantId,
          action,
          entity: 'usage_counter',
          entityId: null,
          after: { metric, ...meta, period },
          meta: { metric, period, scope: 'platform_console' },
        });
      });
    } catch (error) {
      this.logger.warn(`usage audit failed for ${tenantId}: ${(error as Error).message}`);
    }
  }
}

function emptyMeasured(): Measured {
  return {
    users: 0,
    branches: 0,
    items: 0,
    invoices_per_month: 0,
    storage_mb: 0,
    api_calls_per_day: 0,
    whatsapp_per_month: 0,
    email_sends_per_month: 0,
  };
}

/** `IN (${...})` — لا ``= ANY(${array})``: توسيع مصفوفة JavaScript يفشل كاستعلام (درس P-C4). */
function uuidList(values: string[]): SQL {
  return sql.join(
    values.map((value) => sql`${value}::uuid`),
    sql`, `,
  );
}

function keyList(): SQL {
  return sql.join(
    usageMetricRegistry.map((metric) => sql`${metric.limitKey}`),
    sql`, `,
  );
}

function numericValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Math.trunc(Number(value));
  }
  return null;
}

function noticeFor(
  labelAr: string,
  used: number,
  limit: EffectiveLimit,
  state: UsageMetricState,
): string | null {
  if (limit.value === null) return null;
  if (state === 'hard') {
    return limit.enforced
      ? `${labelAr}: بلغ العميل الحدّ (${used} من ${limit.value}) — الكتابة الجديدة تُرفض.`
      : `${labelAr}: بلغ المغلّف الافتراضي (${used} من ${limit.value}) — لا رفض (الحدّ لم يضبطه مشغّل).`;
  }
  if (state === 'soft') {
    return limit.enforced
      ? `${labelAr}: اقترب من الحدّ (${used} من ${limit.value}).`
      : `${labelAr}: اقترب من المغلّف الافتراضي (${used} من ${limit.value}) — لا رفض.`;
  }
  return null;
}

function stateWeight(state: UsageMetricState): number {
  return state === 'hard' ? 3 : state === 'soft' ? 2 : state === 'ok' ? 1 : 0;
}

function worstState(states: UsageMetricState[]): UsageMetricState {
  return states.reduce<UsageMetricState>(
    (worst, current) => (stateWeight(current) > stateWeight(worst) ? current : worst),
    'unlimited',
  );
}

/** `2026-09` → `2026-09-01`. */
function monthStartIso(period: string): string {
  return `${period}-01`;
}

/** `2026-09` → `2026-10-01` (بداية الشهر التالي، ونهاية المدى نصف المفتوحة). */
function monthEndIso(period: string): string {
  const [year = 1970, month = 1] = period.split('-').map((part) => Number(part));
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
