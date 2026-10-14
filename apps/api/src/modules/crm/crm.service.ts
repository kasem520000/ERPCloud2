import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DomainError, errorCodes, newId } from '@erp/contracts';
import {
  CrmRuleError,
  assertDealValue,
  assertProbability,
  assertTitle,
  defaultStages,
  forecastOpenDeals,
  inboundText,
  moveDeal,
  renderTemplate,
  whatsappActivity,
  withTenantTx,
  type CrmStage,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { WhatsappService, normalizePhone } from '../integrations/whatsapp/whatsapp.service.js';
import { setAuditTenantId } from '../../request-context/request-context.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVITY = new Set(['call', 'meeting', 'whatsapp', 'email', 'note']);

@Injectable()
export class CrmService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly whatsapp: WhatsappService,
  ) {}

  async pipelines(tenantId: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.ensureDefaults(tx, tenantId);
      return rows(await tx.execute(sql`
        SELECT id, name, stages, is_default
        FROM crm_pipelines
        WHERE tenant_id = ${tenantId}::uuid
        ORDER BY is_default DESC, created_at
      `)).map(toPipeline);
    });
  }

  async createPipeline(tenantId: string, input: { name?: unknown; stages?: unknown }) {
    const name = this.rules(() => assertTitle(String(input.name ?? '')));
    if (name.length > 80) throw new DomainError(errorCodes.VALIDATION_FAILED, 'اسم المسار حتى 80 حرفاً', 422);
    const stages = normaliseStages(input.stages ?? defaultStages());
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const existing = first(await tx.execute(sql`SELECT id FROM crm_pipelines WHERE tenant_id = ${tenantId}::uuid LIMIT 1`));
      const inserted = first(await tx.execute(sql`
        INSERT INTO crm_pipelines (id, tenant_id, name, stages, is_default)
        VALUES (${newId()}::uuid, ${tenantId}::uuid, ${name}, ${JSON.stringify(stages)}::jsonb, ${!existing})
        RETURNING id, name, stages, is_default
      `));
      if (!inserted) throw new DomainError(errorCodes.INTERNAL, 'تعذر حفظ المسار', 500);
      return toPipeline(inserted);
    });
  }

  async deals(tenantId: string, query: { pipelineId?: string; stageId?: string; ownerId?: string }) {
    const pipelineId = this.optionalFilterUuid(query.pipelineId);
    const ownerId = this.optionalFilterUuid(query.ownerId);
    const stageId = query.stageId?.trim() || null;
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.ensureDefaults(tx, tenantId);
      const found = rows(await tx.execute(sql`
        SELECT d.id, d.pipeline_id, d.stage_id, d.party_id, d.title, d.amount::text AS deal_value,
               d.probability, d.expected_close, d.owner_id, d.status, d.lost_reason,
               p.name AS party_name, p.phone AS party_phone
        FROM crm_deals d
        LEFT JOIN parties p ON p.id = d.party_id AND p.tenant_id = d.tenant_id
        WHERE d.tenant_id = ${tenantId}::uuid
          AND (${pipelineId}::uuid IS NULL OR d.pipeline_id = ${pipelineId}::uuid)
          AND (${stageId}::text IS NULL OR d.stage_id = ${stageId})
          AND (${ownerId}::uuid IS NULL OR d.owner_id = ${ownerId}::uuid)
        ORDER BY d.updated_at DESC
      `));
      return found.map(toDeal);
    });
  }

  async createDeal(tenantId: string, userId: string, input: Record<string, unknown>) {
    const title = this.rules(() => assertTitle(String(input.title ?? '')));
    const probability = this.rules(() => assertProbability(Number(input.probability ?? 10)));
    const dealValue = this.rules(() => assertDealValue(String(input.value ?? input.dealValue ?? input.amount ?? '0')));
    const pipelineId = this.uuid(String(input.pipelineId ?? input.pipeline_id ?? ''), 'المسار غير موجود');
    const partyId = optionalUuid(input.partyId ?? input.party_id);
    const expectedClose = dateOrNull(input.expectedClose ?? input.expected_close);
    const requestedStage = input.stageId ?? input.stage_id;
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const pipeline = await this.pipeline(tx, tenantId, pipelineId);
      const stageId = String(requestedStage ?? pipeline.stages[0]?.id ?? '');
      this.rules(() => moveDeal({ stageId: pipeline.stages[0]?.id ?? stageId, status: 'open', value: dealValue, probability }, pipeline.stages, stageId));
      const id = newId();
      await tx.execute(sql`
        INSERT INTO crm_deals (
          id, tenant_id, pipeline_id, stage_id, party_id, title, amount, probability, expected_close, owner_id
        ) VALUES (
          ${id}::uuid, ${tenantId}::uuid, ${pipelineId}::uuid, ${stageId}, ${partyId}::uuid,
          ${title}, ${dealValue}::numeric, ${probability}, ${expectedClose}::date, ${userId}::uuid
        )
      `);
      return this.dealInside(tx, tenantId, id);
    });
  }

  async deal(tenantId: string, id: string) {
    this.uuid(id, 'الصفقة غير موجودة');
    return withTenantTx(this.database.db, tenantId, (tx) => this.dealInside(tx, tenantId, id));
  }

  async move(tenantId: string, userId: string, id: string, stageId: string) {
    this.uuid(id, 'الصفقة غير موجودة');
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const current = await this.dealRow(tx, tenantId, id);
      const pipeline = await this.pipeline(tx, tenantId, current.pipelineId);
      const next = this.rules(() => moveDeal(current, pipeline.stages, stageId));
      await tx.execute(sql`
        UPDATE crm_deals SET stage_id = ${next.stageId}, updated_at = now()
        WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid
      `);
      const stageName = pipeline.stages.find((stage) => stage.id === next.stageId)?.name ?? next.stageId;
      await this.insertActivity(tx, tenantId, userId, id, current.partyId, {
        type: 'note',
        description: `نُقلت إلى ${stageName}`,
        direction: '',
        subject: 'نقل',
      });
      return this.dealInside(tx, tenantId, id);
    });
  }

  async close(tenantId: string, id: string, input: { status?: unknown; lostReason?: unknown; lost_reason?: unknown }) {
    this.uuid(id, 'الصفقة غير موجودة');
    const status = input.status === 'won' || input.status === 'lost' ? input.status : '';
    if (!status) throw new DomainError(errorCodes.VALIDATION_FAILED, 'الحالة ربح أو خسارة', 422);
    const lostReason = String(input.lostReason ?? input.lost_reason ?? '').trim();
    if (status === 'lost' && lostReason.length < 2) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'سبب الخسارة مطلوب', 422, { field: 'lostReason' });
    }
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const updated = rows(await tx.execute(sql`
        UPDATE crm_deals
        SET status = ${status}, lost_reason = ${lostReason}, probability = ${status === 'won' ? 100 : 0}, updated_at = now()
        WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid AND status = 'open'
        RETURNING id
      `));
      if (!updated[0]) throw new DomainError(errorCodes.NOT_FOUND, 'الصفقة مغلقة أو غير موجودة', 404);
      return this.dealInside(tx, tenantId, id);
    });
  }

  async addActivity(tenantId: string, userId: string, id: string, input: { type?: unknown; description?: unknown }) {
    this.uuid(id, 'الصفقة غير موجودة');
    const type = String(input.type ?? 'note');
    if (!ACTIVITY.has(type) || type === 'whatsapp') {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'نوع النشاط غير مدعوم', 422);
    }
    const description = String(input.description ?? '').trim();
    if (!description) throw new DomainError(errorCodes.VALIDATION_FAILED, 'الوصف مطلوب', 422);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const current = await this.dealRow(tx, tenantId, id);
      return this.insertActivity(tx, tenantId, userId, id, current.partyId, {
        type,
        description,
        direction: '',
        subject: type,
      });
    });
  }

  async activities(tenantId: string, dealId?: string) {
    if (dealId) this.uuid(dealId, 'الصفقة غير موجودة');
    return withTenantTx(this.database.db, tenantId, async (tx) =>
      rows(await tx.execute(sql`
        SELECT a.id, a.deal_id, a.type, a.subject, a.description, a.at, a.direction, a.meta, d.title
        FROM crm_activities a
        JOIN crm_deals d ON d.id = a.deal_id
        WHERE a.tenant_id = ${tenantId}::uuid
          AND (${dealId ?? null}::uuid IS NULL OR a.deal_id = ${dealId ?? null}::uuid)
        ORDER BY a.at DESC
        LIMIT 200
      `)).map(toActivity),
    );
  }

  async sendWhatsapp(
    tenantId: string,
    userId: string,
    id: string,
    input: { templateId?: unknown; template_id?: unknown; message?: unknown; to?: unknown },
  ) {
    this.uuid(id, 'الصفقة غير موجودة');
    const draft = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const current = await this.dealRow(tx, tenantId, id);
      const templateId = String(input.templateId ?? input.template_id ?? '');
      if (templateId) this.uuid(templateId, 'القالب غير موجود');
      const template = templateId
        ? first(await tx.execute(sql`
            SELECT body FROM crm_whatsapp_templates
            WHERE id = ${templateId}::uuid AND tenant_id = ${tenantId}::uuid
          `))
        : undefined;
      const body = String(input.message ?? template?.body ?? '').trim();
      const text = this.rules(() =>
        renderTemplate(body || 'مرحبا {name} بخصوص {deal}', {
          name: current.partyName || 'العميل',
          deal: current.title,
        }),
      );
      const phone = String(input.to ?? current.partyPhone ?? '');
      return { current, text, phone };
    });
    const sent = await this.whatsapp.sendPlain(tenantId, {
      to: draft.phone,
      message: draft.text,
      partyId: draft.current.partyId,
    });
    if (!sent.ok) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, sent.error || 'تعذر إرسال واتساب', 422);
    }
    const activity = this.rules(() => whatsappActivity(sent.message, 'out'));
    return withTenantTx(this.database.db, tenantId, (tx) =>
      this.insertActivity(tx, tenantId, userId, id, draft.current.partyId, {
        ...activity,
        subject: 'واتساب',
        meta: { phone: sent.phone, providerMessageId: sent.providerMessageId, simulation: sent.simulation },
      }),
    );
  }

  async templates(tenantId: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.ensureDefaults(tx, tenantId);
      return rows(await tx.execute(sql`
        SELECT id, name, body FROM crm_whatsapp_templates WHERE tenant_id = ${tenantId}::uuid ORDER BY created_at
      `)).map((row) => ({ id: str(row.id), name: str(row.name), body: str(row.body) }));
    });
  }

  async createTemplate(tenantId: string, input: { name?: unknown; body?: unknown }) {
    const name = this.rules(() => assertTitle(String(input.name ?? '')));
    const body = String(input.body ?? '').trim();
    if (!body) throw new DomainError(errorCodes.VALIDATION_FAILED, 'نص القالب مطلوب', 422);
    const variables = [...body.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const inserted = first(await tx.execute(sql`
        INSERT INTO crm_whatsapp_templates (id, tenant_id, name, body, variables)
        VALUES (${newId()}::uuid, ${tenantId}::uuid, ${name}, ${body}, ${JSON.stringify(variables)}::jsonb)
        RETURNING id, name, body
      `));
      if (!inserted) throw new DomainError(errorCodes.INTERNAL, 'تعذر حفظ القالب', 500);
      return { id: str(inserted.id), name: str(inserted.name), body: str(inserted.body) };
    });
  }

  async settings(tenantId: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.ensureDefaults(tx, tenantId);
      const row = first(await tx.execute(sql`SELECT webhook_token FROM crm_settings WHERE tenant_id = ${tenantId}::uuid`));
      return { webhookPath: `/api/v1/crm/webhooks/whatsapp?token=${str(row?.webhook_token)}` };
    });
  }

  async forecast(tenantId: string, pipelineId?: string) {
    const deals = await this.deals(tenantId, { pipelineId });
    const summary = forecastOpenDeals(deals.map((deal) => ({
      stageId: deal.stageId,
      status: deal.status === 'won' || deal.status === 'lost' ? deal.status : 'open',
      value: deal.value,
      probability: deal.probability,
    })));
    return {
      weighted: summary.weighted,
      openCount: summary.openCount,
      count: summary.openCount,
      deals: deals.filter((deal) => deal.status === 'open'),
    };
  }

  async inbound(token: string, body: unknown) {
    const secret = token.trim();
    if (!secret) throw new DomainError(errorCodes.UNAUTHENTICATED, 'رمز الويب هوك مطلوب', 401);
    const parsed = inboundText(body);
    if (!parsed) return { matched: false };
    const tenantId = await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.lookup_webhook', ${secret}, true)`);
      const row = first(await tx.execute(sql`SELECT tenant_id FROM crm_settings WHERE webhook_token = ${secret} LIMIT 1`));
      return str(row?.tenant_id);
    });
    if (!tenantId) throw new DomainError(errorCodes.UNAUTHENTICATED, 'رمز الويب هوك غير صحيح', 401);
    // AUD-14 — الطلب عامّ فبدأ بلا سياق: نُعلن المستأجر المستخرج من الرمز كي يُنسب
    // سجلّ التدقيق إليه (لا تمنح هذه الدالة صلاحيات ولا عضوية).
    setAuditTenantId(tenantId);
    const phone = normalizePhone(parsed.phone);
    const activity = this.rules(() => whatsappActivity(parsed.text, 'in'));
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const deal = first(await tx.execute(sql`
        SELECT d.id, d.party_id
        FROM crm_deals d
        LEFT JOIN parties p ON p.id = d.party_id
        WHERE d.tenant_id = ${tenantId}::uuid AND d.status = 'open'
          AND (
            right(regexp_replace(coalesce(p.phone, ''), '\\D', '', 'g'), 9) = right(${phone}, 9)
            OR EXISTS (
              SELECT 1 FROM crm_activities a
              WHERE a.deal_id = d.id AND a.type = 'whatsapp' AND a.meta->>'phone' = ${phone}
            )
          )
        ORDER BY d.updated_at DESC
        LIMIT 1
      `));
      if (!deal) return { matched: false };
      await this.insertActivity(tx, tenantId, null, str(deal.id), str(deal.party_id) || null, {
        ...activity,
        subject: 'واتساب وارد',
        meta: { phone },
      });
      return { matched: true, dealId: str(deal.id) };
    });
  }

  private async ensureDefaults(tx: DrizzleTx, tenantId: string) {
    const pipeline = first(await tx.execute(sql`SELECT id FROM crm_pipelines WHERE tenant_id = ${tenantId}::uuid LIMIT 1`));
    if (!pipeline) {
      await tx.execute(sql`
        INSERT INTO crm_pipelines (id, tenant_id, name, stages, is_default)
        VALUES (${newId()}::uuid, ${tenantId}::uuid, 'المبيعات', ${JSON.stringify(defaultStages())}::jsonb, true)
      `);
    }
    const template = first(await tx.execute(sql`SELECT id FROM crm_whatsapp_templates WHERE tenant_id = ${tenantId}::uuid LIMIT 1`));
    if (!template) {
      await tx.execute(sql`
        INSERT INTO crm_whatsapp_templates (id, tenant_id, name, body, variables)
        VALUES (
          ${newId()}::uuid, ${tenantId}::uuid, 'ترحيب', 'مرحبا {name} بخصوص {deal}',
          '["name","deal"]'::jsonb
        )
      `);
    }
    const settings = first(await tx.execute(sql`SELECT tenant_id FROM crm_settings WHERE tenant_id = ${tenantId}::uuid`));
    if (!settings) {
      await tx.execute(sql`
        INSERT INTO crm_settings (tenant_id, webhook_token) VALUES (${tenantId}::uuid, ${randomBytes(24).toString('hex')})
      `);
    }
  }

  private async pipeline(tx: DrizzleTx, tenantId: string, id: string): Promise<{ id: string; stages: CrmStage[] }> {
    const row = first(await tx.execute(sql`
      SELECT id, stages FROM crm_pipelines WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid
    `));
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'المسار غير موجود', 404);
    return { id: str(row.id), stages: stagesOf(row.stages) };
  }

  private async dealRow(tx: DrizzleTx, tenantId: string, id: string) {
    const row = first(await tx.execute(sql`
      SELECT d.id, d.pipeline_id, d.stage_id, d.party_id, d.title, d.amount::text AS deal_value,
             d.probability, d.status, p.name AS party_name, p.phone AS party_phone
      FROM crm_deals d
      LEFT JOIN parties p ON p.id = d.party_id
      WHERE d.id = ${id}::uuid AND d.tenant_id = ${tenantId}::uuid
    `));
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'الصفقة غير موجودة', 404);
    return {
      id: str(row.id),
      pipelineId: str(row.pipeline_id),
      stageId: str(row.stage_id),
      partyId: str(row.party_id) || null,
      title: str(row.title),
      value: str(row.deal_value),
      probability: Number(row.probability ?? 0),
      status: str(row.status) as 'open' | 'won' | 'lost',
      partyName: str(row.party_name),
      partyPhone: str(row.party_phone),
    };
  }

  private async dealInside(tx: DrizzleTx, tenantId: string, id: string) {
    const row = first(await tx.execute(sql`
      SELECT d.id, d.pipeline_id, d.stage_id, d.party_id, d.title, d.amount::text AS deal_value,
             d.probability, d.expected_close, d.owner_id, d.status, d.lost_reason,
             p.name AS party_name, p.phone AS party_phone
      FROM crm_deals d
      LEFT JOIN parties p ON p.id = d.party_id
      WHERE d.id = ${id}::uuid AND d.tenant_id = ${tenantId}::uuid
    `));
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'الصفقة غير موجودة', 404);
    const activities = rows(await tx.execute(sql`
      SELECT id, deal_id, type, subject, description, at, direction, meta
      FROM crm_activities WHERE deal_id = ${id}::uuid AND tenant_id = ${tenantId}::uuid
      ORDER BY at DESC
    `)).map(toActivity);
    return { ...toDeal(row), activities };
  }

  private async insertActivity(
    tx: DrizzleTx,
    tenantId: string,
    userId: string | null,
    dealId: string,
    partyId: string | null,
    input: { type: string; description: string; direction: string; subject: string; meta?: Record<string, unknown> },
  ) {
    const inserted = first(await tx.execute(sql`
      INSERT INTO crm_activities (id, tenant_id, deal_id, party_id, type, subject, description, user_id, direction, meta)
      VALUES (
        ${newId()}::uuid, ${tenantId}::uuid, ${dealId}::uuid, ${partyId}::uuid, ${input.type},
        ${input.subject}, ${input.description}, ${userId}::uuid, ${input.direction}, ${JSON.stringify(input.meta ?? {})}::jsonb
      )
      RETURNING id, deal_id, type, subject, description, at, direction, meta
    `));
    if (!inserted) throw new DomainError(errorCodes.INTERNAL, 'تعذر حفظ النشاط', 500);
    return toActivity(inserted);
  }

  private optionalFilterUuid(value?: string): string | null {
    if (!value) return null;
    return this.uuid(value, 'المعرّف غير صالح');
  }

  private uuid(value: string, message: string) {
    if (!UUID.test(value)) throw new DomainError(errorCodes.NOT_FOUND, message, 404);
    return value;
  }

  private rules<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (error instanceof CrmRuleError) {
        throw new DomainError(errorCodes.VALIDATION_FAILED, ruleMessage(error.rule), 422);
      }
      throw error;
    }
  }
}

function normaliseStages(raw: unknown): CrmStage[] {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 8) {
    throw new DomainError(errorCodes.VALIDATION_FAILED, 'المسار يحتاج من مرحلتين إلى ثمانٍ', 422);
  }
  return raw.map((item, index) => {
    const stage = item as { id?: string; name?: string; color?: string; order?: number };
    const name = String(stage.name ?? '').trim();
    if (!name) throw new DomainError(errorCodes.VALIDATION_FAILED, 'اسم المرحلة مطلوب', 422);
    const color = /^#[0-9a-fA-F]{6}$/.test(String(stage.color ?? '')) ? String(stage.color).toLowerCase() : '#64748b';
    return { id: String(stage.id || `s${index + 1}`), name, color, order: index + 1 };
  });
}

function stagesOf(value: unknown): CrmStage[] {
  if (typeof value === 'string') {
    try {
      return stagesOf(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? normaliseStages(value) : [];
}

function toPipeline(row: Record<string, unknown>) {
  return {
    id: str(row.id),
    name: str(row.name),
    isDefault: row.is_default === true || row.is_default === 't',
    stages: stagesOf(row.stages),
  };
}

function toDeal(row: Record<string, unknown>) {
  return {
    id: str(row.id),
    pipelineId: str(row.pipeline_id),
    stageId: str(row.stage_id),
    partyId: str(row.party_id),
    partyName: str(row.party_name),
    partyPhone: str(row.party_phone),
    title: str(row.title),
    value: str(row.deal_value || '0.0000'),
    probability: Number(row.probability ?? 0),
    expectedClose: str(row.expected_close).slice(0, 10),
    ownerId: str(row.owner_id),
    status: str(row.status),
    lostReason: str(row.lost_reason),
  };
}

function toActivity(row: Record<string, unknown>) {
  return {
    id: str(row.id),
    dealId: str(row.deal_id),
    title: str(row.title),
    type: str(row.type),
    subject: str(row.subject),
    description: str(row.description),
    at: row.at instanceof Date ? row.at.toISOString() : str(row.at),
    direction: str(row.direction),
    meta: row.meta && typeof row.meta === 'object' ? row.meta : {},
  };
}

function optionalUuid(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value);
  if (!UUID.test(text)) throw new DomainError(errorCodes.VALIDATION_FAILED, 'العميل غير صالح', 422);
  return text;
}

function dateOrNull(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new DomainError(errorCodes.VALIDATION_FAILED, 'تاريخ الإغلاق غير صالح', 422);
  return text;
}

function ruleMessage(rule: string): string {
  if (rule === 'STAGE') return 'المرحلة ليست في هذا المسار';
  if (rule === 'CLOSED') return 'الصفقة مغلقة ولا تُنقل';
  if (rule === 'TITLE') return 'العنوان بين حرف و120 حرفاً';
  if (rule === 'PROBABILITY') return 'الاحتمال من 0 إلى 100';
  if (rule === 'VALUE') return 'القيمة رقم عشري';
  return 'الرسالة فارغة';
}

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function rows(result: unknown): Array<Record<string, unknown>> {
  return Array.isArray(result)
    ? (result as Array<Record<string, unknown>>)
    : ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []);
}

function first(result: unknown): Record<string, unknown> | undefined {
  return rows(result)[0];
}
