import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { env } from '@erp/config';
import { DomainError, errorCodes, newId } from '@erp/contracts';
import { withPlatformAdminTx, withTenantTx, type DatabaseHandle, type DrizzleTx } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { openSecret, sealSecret } from '../platform/auth/secret-box.js';

import {
  AI_SKILLS,
  assertFactsTenant,
  buildSuggestions,
  emptyFacts,
  redactSensitive,
  riyadhDate,
  runAssistantTurn,
  streamText,
  type AiProviderName,
  type TenantFacts,
} from './ai-engine.js';
import { workspaceHelpCorpus, type HelpArticle } from './ai-help.js';
import { createLlmPort, estimateCost } from './ai-llm.js';

/**
 * Tenant assistant. Fact queries filter `tenant_id` and read sales aggregates,
 * branch names and low-stock shortages only. Identity numbers and payroll lines
 * are never selected. The platform key is read on the admin plane and never
 * returned to a tenant response.
 */

export type ChatInput = { message?: string; conversationId?: string };
export type ChatResult = {
  conversationId: string;
  intent: string;
  text: string;
  hrefs: string[];
  tools: string[];
  provider: string;
  degraded: boolean;
  usage: { tokensIn: number; tokensOut: number; spent: string };
};

type StoredMessage = { role: 'user' | 'assistant'; content: string; at: string; intent?: string };
type PlatformRow = {
  provider: string;
  model: string;
  api_key_enc: string | null;
  base_url: string;
  enabled: boolean;
  default_monthly_token_limit: number;
  cost_per_million_in: string;
  cost_per_million_out: string;
};
type TenantRow = {
  enabled: boolean;
  platform_suspended: boolean;
  provider: string | null;
  model: string | null;
  api_key_enc: string | null;
  base_url: string | null;
  monthly_token_limit: number | null;
  monthly_cost_limit: string | null;
};

function maskSecretKey(raw: string | undefined): string | null {
  if (!raw) return null;
  if (raw.length <= 8) return '••••••••';
  return `${raw.slice(0, 4)}••••${raw.slice(-4)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const articlesCache: { value?: HelpArticle[] } = {};

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: T[] } | null)?.rows;
  return rows ?? [];
}

function asProvider(value: unknown, allowEmpty: boolean): AiProviderName | null {
  if (value === null || value === undefined || value === '') return allowEmpty ? null : 'local';
  if (
    value === 'openai' ||
    value === 'anthropic' ||
    value === 'gemini' ||
    value === 'custom' ||
    value === 'local'
  ) {
    return value;
  }
  throw new DomainError(errorCodes.VALIDATION_FAILED, 'مزود غير مدعوم', 422);
}

function asLimit(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 50_000_000) {
    throw new DomainError(errorCodes.VALIDATION_FAILED, 'حد التوكنز غير صالح', 422);
  }
  return parsed;
}

function asMoneyCap(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new DomainError(errorCodes.VALIDATION_FAILED, 'حد التكلفة غير صالح', 422);
  }
  if (!/^\d+(\.\d+)?$/.test(String(value))) {
    throw new DomainError(errorCodes.VALIDATION_FAILED, 'حد التكلفة غير صالح', 422);
  }
  return Number(value).toFixed(4);
}

function cleanBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new DomainError(errorCodes.VALIDATION_FAILED, 'رابط المزود غير صالح', 422);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new DomainError(errorCodes.VALIDATION_FAILED, 'رابط المزود يجب أن يكون http أو https', 422);
  }
  return trimmed.replace(/\/+$/, '');
}

function openKey(sealed: string | null): string | undefined {
  if (sealed) {
    try {
      return openSecret(sealed).toString('utf8');
    } catch {
      return env.AI_API_KEY || undefined;
    }
  }
  return env.AI_API_KEY || undefined;
}

function monthStart(now = new Date()): string {
  return `${riyadhDate(now).slice(0, 7)}-01T00:00:00+03:00`;
}

function articles(): HelpArticle[] {
  articlesCache.value ??= workspaceHelpCorpus();
  return articlesCache.value;
}

@Injectable()
export class AiService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  skills() {
    return AI_SKILLS;
  }

  async chat(tenantId: string, userId: string, input: ChatInput): Promise<ChatResult> {
    const message = input.message?.trim() ?? '';
    if (!message) throw new DomainError(errorCodes.VALIDATION_FAILED, 'اكتب سؤالاً أولاً', 422);
    if (message.length > 2000) throw new DomainError(errorCodes.VALIDATION_FAILED, 'السؤال أطول من الحد', 422);
    const conversationId = input.conversationId ? this.uuid(input.conversationId) : undefined;
    const gate = await this.gate(tenantId);
    if (!gate.allowed) throw new DomainError(errorCodes.FORBIDDEN, gate.reason, 403);

    const facts = await this.loadFacts(tenantId);
    assertFactsTenant(facts, tenantId);
    const provider = gate.provider;
    const degraded = provider !== 'local' && !gate.apiKey;
    const turn = await runAssistantTurn({
      tenantId,
      message,
      facts,
      articles: articles(),
      llm: createLlmPort({
        provider: degraded ? 'local' : provider,
        model: gate.model,
        apiKey: gate.apiKey,
        baseUrl: gate.baseUrl,
      }),
      usage: gate.usage,
    });
    const spent = turn.blocked ? '0.000000' : estimateCost(turn.tokensIn, turn.tokensOut, gate.perMillionIn, gate.perMillionOut);
    const savedId = await this.persist(tenantId, userId, conversationId, redactSensitive(message), turn, provider, spent);
    if (!turn.blocked) await this.meter(tenantId, turn.tokensIn + turn.tokensOut);
    return {
      conversationId: savedId,
      intent: turn.intent,
      text: turn.text,
      hrefs: turn.hrefs,
      tools: turn.tools,
      provider: degraded || provider === 'local' ? 'local' : provider,
      degraded,
      usage: { tokensIn: turn.tokensIn, tokensOut: turn.tokensOut, spent },
    };
  }

  streamOf(result: ChatResult) {
    return (async function* events() {
      yield { type: 'meta' as const, conversationId: result.conversationId, intent: result.intent, provider: result.provider };
      for (const text of streamText(result.text)) yield { type: 'delta' as const, text };
      yield { type: 'done' as const, ...result };
    })();
  }

  async listConversations(tenantId: string, userId: string) {
    const result = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.execute(sql`
        SELECT id::text, title, updated_at
        FROM ai_conversations
        WHERE tenant_id = ${tenantId}::uuid AND user_id = ${userId}::uuid
        ORDER BY updated_at DESC
        LIMIT 30
      `),
    );
    return rowsOf<{ id: string; title: string; updated_at: string }>(result);
  }

  async readConversation(tenantId: string, userId: string, id: string) {
    const conversationId = this.uuid(id);
    const result = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.execute(sql`
        SELECT id::text, title, messages, updated_at
        FROM ai_conversations
        WHERE tenant_id = ${tenantId}::uuid AND user_id = ${userId}::uuid AND id = ${conversationId}::uuid
        LIMIT 1
      `),
    );
    const row = rowsOf<{ id: string; title: string; messages: unknown; updated_at: string }>(result)[0];
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'المحادثة غير موجودة', 404);
    return { ...row, messages: parseMessages(row.messages) };
  }

  async settingsView(tenantId: string) {
    const gate = await this.gate(tenantId);
    return {
      enabled: gate.tenantEnabled,
      platformSuspended: gate.suspended,
      platformEnabled: gate.platformEnabled,
      provider: gate.tenantProvider,
      effectiveProvider: gate.apiKey || gate.provider === 'local' ? gate.provider : 'local',
      model: gate.tenantModel,
      effectiveModel: gate.model,
      baseUrl: gate.tenantBaseUrl,
      effectiveBaseUrl: gate.baseUrl,
      monthlyTokenLimit: gate.tenantTokenLimit,
      monthlyCostLimit: gate.tenantCostLimit,
      hasPlatformKey: Boolean(gate.apiKey),
      hasTenantApiKey: gate.hasTenantApiKey,
      apiKeyMasked: gate.apiKeyMasked,
      usage: {
        tokens: gate.usage.tokensUsed,
        spent: gate.usage.costUsed,
        tokenLimit: gate.usage.tokenLimit,
        costLimit: gate.usage.costLimit,
        period: riyadhDate(new Date()).slice(0, 7),
      },
    };
  }

  async updateSettings(tenantId: string, input: Record<string, unknown>) {
    const enabled = input.enabled === undefined ? true : Boolean(input.enabled);
    const provider = asProvider(input.provider, true);
    const model = input.model === null || input.model === undefined || input.model === '' ? null : String(input.model).slice(0, 80);
    const baseUrl =
      input.baseUrl === null || input.baseUrl === undefined || input.baseUrl === ''
        ? null
        : cleanBaseUrl(String(input.baseUrl));
    const monthlyTokenLimit = asLimit(input.monthlyTokenLimit);
    const monthlyCostLimit = asMoneyCap(input.monthlyCostLimit);

    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const currentRes = await tx.execute(sql`
        SELECT api_key_enc, base_url FROM ai_settings WHERE tenant_id = ${tenantId}::uuid LIMIT 1
      `);
      const current = rowsOf<{ api_key_enc: string | null; base_url: string | null }>(currentRes)[0];
      let sealedKey = current?.api_key_enc ?? null;
      if (input.clearApiKey === true) {
        sealedKey = null;
      } else if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
        sealedKey = sealSecret(input.apiKey.trim());
      }
      const nextBaseUrl = input.baseUrl === undefined ? (current?.base_url ?? null) : baseUrl;

      await tx.execute(sql`
        INSERT INTO ai_settings (
          tenant_id, enabled, provider, model, api_key_enc, base_url,
          monthly_token_limit, monthly_cost_limit, updated_at
        )
        VALUES (
          ${tenantId}::uuid, ${enabled}, ${provider}, ${model}, ${sealedKey}, ${nextBaseUrl},
          ${monthlyTokenLimit}, ${monthlyCostLimit}, now()
        )
        ON CONFLICT (tenant_id) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          provider = EXCLUDED.provider,
          model = EXCLUDED.model,
          api_key_enc = EXCLUDED.api_key_enc,
          base_url = EXCLUDED.base_url,
          monthly_token_limit = EXCLUDED.monthly_token_limit,
          monthly_cost_limit = EXCLUDED.monthly_cost_limit,
          updated_at = now()
      `);
    });
    return this.settingsView(tenantId);
  }

  async testConnection(tenantId: string) {
    const gate = await this.gate(tenantId);
    const startedAt = Date.now();
    const port = createLlmPort({
      provider: gate.apiKey || gate.provider === 'local' ? gate.provider : 'local',
      model: gate.model,
      apiKey: gate.apiKey,
      baseUrl: gate.baseUrl,
    });
    let reply = '';
    for await (const chunk of port.complete({
      system: 'أنت مساعد محاسبي ذكي في نظام ERP سحابي. أجب باختصار باللغة العربية.',
      user: 'اختبار اتصال API للمساعد الذكي.',
      grounded: 'الاتصال بالمساعد الذكي يعمل بنجاح ومربوط ببيانات المنشأة.',
    })) {
      if (chunk.type === 'done') reply = chunk.text;
    }
    return {
      ok: true,
      provider: gate.apiKey || gate.provider === 'local' ? gate.provider : 'local',
      model: gate.model,
      hasApiKey: Boolean(gate.apiKey),
      latencyMs: Date.now() - startedAt,
      reply,
    };
  }

  async suggest(tenantId: string) {
    const gate = await this.gate(tenantId);
    if (!gate.allowed) throw new DomainError(errorCodes.FORBIDDEN, gate.reason, 403);
    return this.writeSuggestions(tenantId);
  }

  async runDailySuggestions(tenantId: string) {
    const gate = await this.gate(tenantId);
    if (!gate.allowed) return { skipped: true, suggestions: [] as ReturnType<typeof buildSuggestions> };
    return { skipped: false, suggestions: await this.writeSuggestions(tenantId) };
  }

  async listSuggestions(tenantId: string) {
    const period = riyadhDate(new Date());
    const result = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.execute(sql`
        SELECT kind, title, body, period::text, created_at
        FROM ai_suggestions
        WHERE tenant_id = ${tenantId}::uuid AND period = ${period}::date
        ORDER BY kind
      `),
    );
    return rowsOf(result);
  }

  async platformView() {
    const row = await this.readPlatform();
    return {
      provider: row?.provider ?? 'local',
      model: row?.model ?? 'local-grounded',
      baseUrl: row?.base_url ?? '',
      enabled: row?.enabled ?? true,
      defaultMonthlyTokenLimit: row?.default_monthly_token_limit ?? 200000,
      costPerMillionIn: row?.cost_per_million_in ?? '0',
      costPerMillionOut: row?.cost_per_million_out ?? '0',
      hasApiKey: Boolean(row?.api_key_enc || env.AI_API_KEY),
    };
  }

  async updatePlatform(input: Record<string, unknown>) {
    const provider = asProvider(input.provider, false) ?? 'local';
    const model = String(input.model ?? (provider === 'local' ? 'local-grounded' : '')).slice(0, 80) || 'local-grounded';
    const baseUrl = cleanBaseUrl(String(input.baseUrl ?? ''));
    const enabled = input.enabled === undefined ? true : Boolean(input.enabled);
    const tokenLimit = asLimit(input.defaultMonthlyTokenLimit) ?? 200000;
    const perMillionIn = asMoneyCap(input.costPerMillionIn) ?? '0.0000';
    const perMillionOut = asMoneyCap(input.costPerMillionOut) ?? '0.0000';
    const current = await this.readPlatform();
    let sealed = current?.api_key_enc ?? null;
    if (input.clearApiKey === true) sealed = null;
    if (typeof input.apiKey === 'string' && input.apiKey.trim()) sealed = sealSecret(input.apiKey.trim());
    await withPlatformAdminTx(this.database.db, (tx) =>
      tx.execute(sql`
        INSERT INTO ai_platform_settings (
          id, provider, model, api_key_enc, base_url, enabled, default_monthly_token_limit,
          cost_per_million_in, cost_per_million_out, updated_at
        ) VALUES (
          true, ${provider}, ${model}, ${sealed}, ${baseUrl}, ${enabled}, ${tokenLimit},
          ${perMillionIn}, ${perMillionOut}, now()
        )
        ON CONFLICT (id) DO UPDATE SET
          provider = EXCLUDED.provider,
          model = EXCLUDED.model,
          api_key_enc = EXCLUDED.api_key_enc,
          base_url = EXCLUDED.base_url,
          enabled = EXCLUDED.enabled,
          default_monthly_token_limit = EXCLUDED.default_monthly_token_limit,
          cost_per_million_in = EXCLUDED.cost_per_million_in,
          cost_per_million_out = EXCLUDED.cost_per_million_out,
          updated_at = now()
      `),
    );
    return this.platformView();
  }

  async setSuspension(tenantId: string, suspended: boolean) {
    const id = this.uuid(tenantId);
    const found = await withPlatformAdminTx(this.database.db, (tx) =>
      tx.execute(sql`SELECT id::text FROM tenants WHERE id = ${id}::uuid LIMIT 1`),
    );
    if (!rowsOf(found)[0]) throw new DomainError(errorCodes.NOT_FOUND, 'المنشأة غير موجودة', 404);
    await withPlatformAdminTx(this.database.db, (tx) =>
      tx.execute(sql`
        INSERT INTO ai_settings (tenant_id, platform_suspended, updated_at)
        VALUES (${id}::uuid, ${suspended}, now())
        ON CONFLICT (tenant_id) DO UPDATE SET platform_suspended = EXCLUDED.platform_suspended, updated_at = now()
      `),
    );
    return { tenantId: id, platformSuspended: suspended };
  }

  private uuid(value: string): string {
    if (!UUID.test(value)) throw new DomainError(errorCodes.VALIDATION_FAILED, 'معرّف غير صالح', 422);
    return value;
  }

  private async readPlatform(): Promise<PlatformRow | null> {
    const result = await withPlatformAdminTx(this.database.db, (tx) =>
      tx.execute(sql`
        SELECT provider, model, api_key_enc, base_url, enabled, default_monthly_token_limit,
               cost_per_million_in::text, cost_per_million_out::text
        FROM ai_platform_settings
        WHERE id = true
        LIMIT 1
      `),
    );
    return rowsOf<PlatformRow>(result)[0] ?? null;
  }

  private async gate(tenantId: string) {
    const platform = await this.readPlatform();
    const tenantResult = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.execute(sql`
        SELECT enabled, platform_suspended, provider, model, api_key_enc, base_url,
               monthly_token_limit, monthly_cost_limit::text
        FROM ai_settings
        WHERE tenant_id = ${tenantId}::uuid
        LIMIT 1
      `),
    );
    const usageResult = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.execute(sql`
        SELECT COALESCE(SUM(tokens_in + tokens_out), 0)::int AS tokens,
               COALESCE(SUM(cost), 0)::text AS spent
        FROM ai_usage_logs
        WHERE tenant_id = ${tenantId}::uuid AND created_at >= ${monthStart()}::timestamptz
      `),
    );
    const tenant = rowsOf<TenantRow>(tenantResult)[0];
    const usageRow = rowsOf<{ tokens: number; spent: string }>(usageResult)[0];
    const provider = (tenant?.provider as AiProviderName | null) || (platform?.provider as AiProviderName | undefined) || env.AI_PROVIDER || 'local';
    const safeProvider: AiProviderName =
      provider === 'openai' || provider === 'anthropic' || provider === 'gemini' || provider === 'custom'
        ? provider
        : 'local';
    const tokenLimit = tenant?.monthly_token_limit ?? platform?.default_monthly_token_limit ?? 200000;
    const suspended = tenant?.platform_suspended === true;
    const platformEnabled = platform?.enabled !== false;
    const tenantEnabled = tenant?.enabled !== false;
    const tenantApiKey = tenant?.api_key_enc ? openKey(tenant.api_key_enc) : undefined;
    const effectiveApiKey = tenantApiKey ?? openKey(platform?.api_key_enc ?? null);
    let reason = '';
    if (!platformEnabled) reason = 'المساعد متوقف من المنصة.';
    else if (suspended) reason = 'أوقف مشغّل المنصة المساعد لهذه المنشأة.';
    else if (!tenantEnabled) reason = 'المساعد غير مفعّل في إعدادات المنشأة.';
    return {
      allowed: platformEnabled && tenantEnabled && !suspended,
      reason,
      provider: safeProvider,
      model: tenant?.model || platform?.model || env.AI_MODEL || 'local-grounded',
      apiKey: effectiveApiKey,
      hasTenantApiKey: Boolean(tenant?.api_key_enc),
      apiKeyMasked: maskSecretKey(tenantApiKey ?? effectiveApiKey),
      tenantBaseUrl: tenant?.base_url ?? null,
      baseUrl: tenant?.base_url || platform?.base_url || env.AI_BASE_URL || '',
      perMillionIn: platform?.cost_per_million_in ?? '0',
      perMillionOut: platform?.cost_per_million_out ?? '0',
      tenantEnabled,
      platformEnabled,
      suspended,
      tenantProvider: tenant?.provider ?? null,
      tenantModel: tenant?.model ?? null,
      tenantTokenLimit: tenant?.monthly_token_limit ?? null,
      tenantCostLimit: tenant?.monthly_cost_limit ?? null,
      usage: {
        tokensUsed: Number(usageRow?.tokens ?? 0),
        tokenLimit,
        costUsed: usageRow?.spent ?? '0',
        costLimit: tenant?.monthly_cost_limit ?? null,
      },
    };
  }

  private async loadFacts(tenantId: string): Promise<TenantFacts> {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const facts = emptyFacts(tenantId);
      facts.branches = await this.branches(tx, tenantId);
      facts.sales = await this.sales(tx, tenantId);
      facts.overdue = await this.overdue(tx, tenantId);
      facts.lowStock = await this.lowStock(tx, tenantId);
      return facts;
    });
  }

  private async branches(tx: DrizzleTx, tenantId: string) {
    const result = await tx.execute(sql`
      SELECT id::text, COALESCE(name_ar, name_en, code) AS name
      FROM branches
      WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
      ORDER BY name_ar
      LIMIT 100
    `);
    return rowsOf<{ id: string; name: string }>(result);
  }

  private async sales(tx: DrizzleTx, tenantId: string) {
    const result = await tx.execute(sql`
      SELECT to_char((si.posted_at AT TIME ZONE 'Asia/Riyadh'), 'YYYY-MM-DD') AS day,
             COALESCE(si.branch_id::text, '') AS branch_id,
             COALESCE(b.name_ar, b.name_en, b.code, 'بدون فرع') AS branch_name,
             SUM(si.total)::text AS sales_total,
             SUM(si.profit)::text AS profit_total,
             COUNT(*)::int AS invoice_count
      FROM sales_invoices si
      LEFT JOIN branches b ON b.id = si.branch_id AND b.tenant_id = si.tenant_id
      WHERE si.tenant_id = ${tenantId}::uuid
        AND si.kind = 'sale'
        AND si.status = 'posted'
        AND si.posted_at IS NOT NULL
        AND si.posted_at >= now() - interval '400 days'
      GROUP BY 1, 2, 3
    `);
    return rowsOf<{
      day: string;
      branch_id: string;
      branch_name: string;
      sales_total: string;
      profit_total: string;
      invoice_count: number;
    }>(result).map((row) => ({
      day: row.day,
      branchId: row.branch_id,
      branchName: row.branch_name,
      salesTotal: row.sales_total,
      profitTotal: row.profit_total,
      count: Number(row.invoice_count),
    }));
  }

  private async overdue(tx: DrizzleTx, tenantId: string) {
    const result = await tx.execute(sql`
      SELECT COUNT(*)::int AS invoice_count,
             COALESCE(SUM(si.total - si.paid_total), 0)::text AS remaining,
             COALESCE(MAX(EXTRACT(DAY FROM now() - si.posted_at)), 0)::int AS oldest_days
      FROM sales_invoices si
      WHERE si.tenant_id = ${tenantId}::uuid
        AND si.kind = 'sale'
        AND si.status = 'posted'
        AND si.payment_status IN ('unpaid', 'partial')
        AND si.total > si.paid_total
        AND si.posted_at < now() - interval '30 days'
    `);
    const row = rowsOf<{ invoice_count: number; remaining: string; oldest_days: number }>(result)[0];
    return {
      count: Number(row?.invoice_count ?? 0),
      remaining: row?.remaining ?? '0.00',
      oldestDays: Number(row?.oldest_days ?? 0),
    };
  }

  private async lowStock(tx: DrizzleTx, tenantId: string) {
    const result = await tx.execute(sql`
      SELECT i.sku, i.name_ar AS name, SUM(i.min_qty - sb.quantity)::text AS shortage
      FROM stock_balances sb
      JOIN items i ON i.id = sb.item_id AND i.tenant_id = sb.tenant_id
      WHERE sb.tenant_id = ${tenantId}::uuid
        AND i.deleted_at IS NULL
        AND i.min_qty > 0
        AND sb.quantity <= i.min_qty
      GROUP BY i.sku, i.name_ar
      ORDER BY SUM(i.min_qty - sb.quantity) DESC
      LIMIT 20
    `);
    return rowsOf<{ sku: string; name: string; shortage: string }>(result);
  }

  private async writeSuggestions(tenantId: string) {
    const facts = await this.loadFacts(tenantId);
    assertFactsTenant(facts, tenantId);
    const suggestions = buildSuggestions(facts);
    const period = riyadhDate(new Date());
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await tx.execute(sql`
        DELETE FROM ai_suggestions
        WHERE tenant_id = ${tenantId}::uuid AND period = ${period}::date
      `);
      for (const suggestion of suggestions) {
        await tx.execute(sql`
          INSERT INTO ai_suggestions (id, tenant_id, kind, period, title, body, payload)
          VALUES (
            ${newId()}::uuid, ${tenantId}::uuid, ${suggestion.kind}, ${period}::date,
            ${suggestion.title}, ${suggestion.body}, ${JSON.stringify({ count: suggestion.kind === 'low_stock' ? facts.lowStock.length : facts.overdue.count })}::jsonb
          )
          ON CONFLICT (tenant_id, kind, period) DO UPDATE SET
            title = EXCLUDED.title,
            body = EXCLUDED.body,
            payload = EXCLUDED.payload,
            created_at = now()
        `);
      }
    });
    return suggestions;
  }

  private async persist(
    tenantId: string,
    userId: string,
    conversationId: string | undefined,
    message: string,
    turn: { intent: string; text: string; tokensIn: number; tokensOut: number; blocked: boolean },
    provider: string,
    spent: string,
  ): Promise<string> {
    const now = new Date().toISOString();
    const next: StoredMessage[] = [
      { role: 'user', content: message.slice(0, 2000), at: now },
      { role: 'assistant', content: turn.text, at: now, intent: turn.intent },
    ];
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      let id = conversationId ?? newId();
      if (conversationId) {
        const existing = await tx.execute(sql`
          SELECT messages FROM ai_conversations
          WHERE tenant_id = ${tenantId}::uuid AND user_id = ${userId}::uuid AND id = ${conversationId}::uuid
          LIMIT 1
        `);
        const row = rowsOf<{ messages: unknown }>(existing)[0];
        if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'المحادثة غير موجودة', 404);
        const messages = [...parseMessages(row.messages), ...next].slice(-40);
        await tx.execute(sql`
          UPDATE ai_conversations
          SET messages = ${JSON.stringify(messages)}::jsonb, updated_at = now()
          WHERE tenant_id = ${tenantId}::uuid AND id = ${conversationId}::uuid
        `);
      } else {
        const messages = next;
        await tx.execute(sql`
          INSERT INTO ai_conversations (id, tenant_id, user_id, title, messages)
          VALUES (
            ${id}::uuid, ${tenantId}::uuid, ${userId}::uuid,
            ${message.slice(0, 80)}, ${JSON.stringify(messages)}::jsonb
          )
        `);
      }
      if (!turn.blocked) {
        await tx.execute(sql`
          INSERT INTO ai_usage_logs (id, tenant_id, conversation_id, user_id, tokens_in, tokens_out, cost, provider)
          VALUES (
            ${newId()}::uuid, ${tenantId}::uuid, ${id}::uuid, ${userId}::uuid,
            ${turn.tokensIn}, ${turn.tokensOut}, ${spent}, ${provider}
          )
        `);
      }
      return id;
    });
  }

  private async meter(tenantId: string, tokens: number) {
    if (tokens <= 0) return;
    const period = riyadhDate(new Date()).slice(0, 7);
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.execute(sql`
        INSERT INTO usage_counters (id, tenant_id, metric, period, value, created_at, updated_at)
        VALUES (${newId()}::uuid, ${tenantId}::uuid, 'ai.tokens', ${period}, ${tokens}, now(), now())
        ON CONFLICT (tenant_id, metric, period)
        DO UPDATE SET value = usage_counters.value + ${tokens}, updated_at = now()
      `),
    );
  }
}

function parseMessages(value: unknown): StoredMessage[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? (parsed as StoredMessage[]) : [];
}
