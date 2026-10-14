import { connect as connectNet } from 'node:net';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { env } from '@erp/config';
import { DomainError, errorCodes, newId } from '@erp/contracts';
import { dashboardWidgets, dashboards, withTenantTx, type DatabaseHandle, type DrizzleTx } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { isUniqueViolation } from '../organization/shared/org-support.js';

import {
  DashboardRuleError,
  WIDGET_CACHE_TTL_MS,
  WIDGET_CATALOG,
  applyLayout,
  assertWidgetRequest,
  catalogByKey,
  dashboardPdf,
  isCacheFresh,
  keepOneDefault,
  placeWidget,
  starterWidgets,
  widgetCacheKey,
  type Cell,
  type WidgetPayload,
} from './bi-dashboard.js';
import { queryWidget } from './widget-queries.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type BoardRow = { id: string; name: string; isDefault: boolean; updatedAt: Date | string; widgetCount: string | number };
type WidgetRow = {
  id: string;
  widgetKey: string;
  titleAr: string;
  kind: string;
  positionX: number;
  positionY: number;
  width: number;
  height: number;
};

type Figure = WidgetPayload & {
  id: string;
  key: string;
  titleAr: string;
  kind: string;
  unit: string;
  comparisonAr?: string;
  positionX: number;
  positionY: number;
  width: number;
  height: number;
  cached: boolean;
  error?: string;
};

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);
}

function asBool(value: unknown): boolean {
  return value === true || value === 't' || value === 'true' || value === 1;
}

function ruleError(error: unknown): never {
  if (error instanceof DashboardRuleError) {
    const message =
      error.code === 'UNKNOWN_WIDGET'
        ? 'هذا المؤشر غير موجود في الكتالوج'
        : error.code === 'RAW_SQL'
          ? 'لا يُقبل SQL من الشاشة. اختر مؤشراً من الكتالوج'
          : error.code === 'LAYOUT_OVERLAP'
            ? 'الويدجتات متداخلة'
            : 'ترتيب اللوحة غير صالح';
    throw new DomainError(errorCodes.VALIDATION_FAILED, message, 400);
  }
  throw error;
}

function redisTarget(): { host: string; port: number; password?: string } | undefined {
  if (!env.REDIS_URL) return undefined;
  try {
    const url = new URL(env.REDIS_URL);
    if (url.protocol === 'rediss:') return undefined;
    return { host: url.hostname, port: Number(url.port || 6379), password: url.password || undefined };
  } catch {
    return undefined;
  }
}

function encodeRedis(parts: string[]): string {
  return `*${parts.length}\r\n${parts.map((part) => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join('')}`;
}

/**
 * كاش اختياري. غياب Redis — أو تعطله — لا يوقف اللوحة: الأرقام تُحفظ في ذاكرة العملية
 * بنفس المفتاح والمدة، كما يتدهور الطابور حين لا يوجد Redis.
 */
function redisCommand(parts: string[]): Promise<string | undefined> {
  const target = redisTarget();
  if (!target) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const socket = connectNet({ host: target.host, port: target.port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(undefined);
    }, 200);
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    socket.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    const commands = target.password ? [encodeRedis(['AUTH', target.password]), encodeRedis(parts)] : [encodeRedis(parts)];
    socket.end(commands.join(''));
  });
}

function bulkValue(reply: string | undefined): string | undefined {
  if (!reply) return undefined;
  const marker = reply.lastIndexOf('\r\n$');
  if (marker < 0) return undefined;
  const rest = reply.slice(marker + 3);
  const lengthEnd = rest.indexOf('\r\n');
  if (lengthEnd < 0) return undefined;
  const length = Number(rest.slice(0, lengthEnd));
  if (!Number.isFinite(length) || length < 0) return undefined;
  return rest.slice(lengthEnd + 2, lengthEnd + 2 + length);
}

@Injectable()
export class DashboardsService {
  private readonly logger = new Logger(DashboardsService.name);
  private readonly memory = new Map<string, { at: number; json: string }>();
  private redisDown = redisTarget() === undefined;

  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  catalog() {
    return WIDGET_CATALOG.map((item) => ({
      key: item.key,
      titleAr: item.titleAr,
      titleEn: item.titleEn,
      kind: item.kind,
      unit: item.unit,
      width: item.width,
      height: item.height,
      source: item.source,
      comparisonAr: item.comparisonAr,
    }));
  }

  async list(tenantId: string, userId: string) {
    await this.ensureDefault(tenantId, userId);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.collapseDefaults(tx, tenantId, userId);
      const rows = rowsOf<BoardRow>(await tx.execute(sql`
        select d.id, d.name, d.is_default as "isDefault", d.updated_at as "updatedAt",
               count(w.id)::text as "widgetCount"
        from dashboards d
        left join dashboard_widgets w on w.dashboard_id = d.id and w.tenant_id = d.tenant_id
        where d.tenant_id = ${tenantId}::uuid and d.owner_user_id = ${userId}::uuid
        group by d.id
        order by d.is_default desc, d.updated_at desc
      `));
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        isDefault: asBool(row.isDefault),
        widgetCount: Number(row.widgetCount),
        updatedAt: new Date(row.updatedAt).toISOString(),
      }));
    });
  }

  async create(tenantId: string, userId: string, name: string) {
    const clean = name.trim();
    if (clean.length < 1 || clean.length > 80) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'اسم اللوحة بين حرف و80 حرفاً', 400);
    }
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const count = Number(rowsOf<{ value: unknown }>(await tx.execute(sql`
        select count(*)::text as value from dashboards
        where tenant_id = ${tenantId}::uuid and owner_user_id = ${userId}::uuid
      `))[0]?.value ?? 0);
      if (count >= 20) throw new DomainError(errorCodes.VALIDATION_FAILED, 'بلغت الحد الأقصى للوحات', 400);
      const id = newId();
      await tx.insert(dashboards).values({ id, tenantId, ownerUserId: userId, name: clean, isDefault: false });
      return { id, name: clean, isDefault: false };
    });
  }

  async get(tenantId: string, userId: string, dashboardId: string) {
    this.assertUuid(dashboardId);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const board = await this.owned(tx, tenantId, userId, dashboardId);
      const widgets = await this.widgetsOf(tx, tenantId, dashboardId);
      return { ...board, widgets };
    });
  }

  async addWidget(tenantId: string, userId: string, dashboardId: string, key: string, config: Record<string, unknown>) {
    this.assertUuid(dashboardId);
    const item = (() => {
      try {
        return assertWidgetRequest(key, config);
      } catch (error) {
        ruleError(error);
      }
    })();
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.owned(tx, tenantId, userId, dashboardId);
      const existing = await this.widgetsOf(tx, tenantId, dashboardId);
      if (existing.length >= 24) throw new DomainError(errorCodes.VALIDATION_FAILED, 'اللوحة ممتلئة', 400);
      let cell: Cell;
      try {
        cell = placeWidget(existing, item);
      } catch (error) {
        ruleError(error);
      }
      const id = newId();
      await tx.insert(dashboardWidgets).values({
        id,
        tenantId,
        dashboardId,
        widgetKey: item.key,
        titleAr: item.titleAr,
        kind: item.kind,
        config,
        positionX: cell.positionX,
        positionY: cell.positionY,
        width: cell.width,
        height: cell.height,
      });
      await tx.execute(sql`update dashboards set updated_at = now() where id = ${dashboardId}::uuid and tenant_id = ${tenantId}::uuid`);
      return { id, key: item.key, titleAr: item.titleAr, kind: item.kind, ...cell };
    });
  }

  async saveLayout(tenantId: string, userId: string, dashboardId: string, layout: Array<{ widgetId: string } & Cell>) {
    this.assertUuid(dashboardId);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.owned(tx, tenantId, userId, dashboardId);
      const current = await this.widgetsOf(tx, tenantId, dashboardId);
      let next: Array<{ id: string } & Cell>;
      try {
        next = applyLayout(current, layout);
      } catch (error) {
        ruleError(error);
      }
      for (const widget of next) {
        await tx.execute(sql`
          update dashboard_widgets
          set position_x = ${widget.positionX}, position_y = ${widget.positionY}, width = ${widget.width}, height = ${widget.height}
          where id = ${widget.id}::uuid and tenant_id = ${tenantId}::uuid and dashboard_id = ${dashboardId}::uuid
        `);
      }
      await tx.execute(sql`update dashboards set updated_at = now() where id = ${dashboardId}::uuid and tenant_id = ${tenantId}::uuid`);
      return next;
    });
  }

  async removeWidget(tenantId: string, userId: string, dashboardId: string, widgetId: string) {
    this.assertUuid(dashboardId);
    this.assertUuid(widgetId);
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.owned(tx, tenantId, userId, dashboardId);
      const removed = rowsOf<{ id: string }>(await tx.execute(sql`
        delete from dashboard_widgets
        where id = ${widgetId}::uuid and tenant_id = ${tenantId}::uuid and dashboard_id = ${dashboardId}::uuid
        returning id
      `));
      if (!removed[0]) throw new DomainError(errorCodes.NOT_FOUND, 'المؤشر غير موجود', 404);
    });
    this.memory.delete(widgetCacheKey(widgetId));
  }

  async setDefault(tenantId: string, userId: string, dashboardId: string) {
    this.assertUuid(dashboardId);
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.owned(tx, tenantId, userId, dashboardId);
      await tx.execute(sql`
        update dashboards set is_default = false, updated_at = now()
        where tenant_id = ${tenantId}::uuid and owner_user_id = ${userId}::uuid and is_default
      `);
      await tx.execute(sql`
        update dashboards set is_default = true, updated_at = now()
        where id = ${dashboardId}::uuid and tenant_id = ${tenantId}::uuid and owner_user_id = ${userId}::uuid
      `);
    });
  }

  async remove(tenantId: string, userId: string, dashboardId: string) {
    this.assertUuid(dashboardId);
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.owned(tx, tenantId, userId, dashboardId);
      await tx.execute(sql`delete from dashboards where id = ${dashboardId}::uuid and tenant_id = ${tenantId}::uuid and owner_user_id = ${userId}::uuid`);
      const left = rowsOf<{ id: string; isDefault: boolean }>(await tx.execute(sql`
        select id, is_default as "isDefault" from dashboards
        where tenant_id = ${tenantId}::uuid and owner_user_id = ${userId}::uuid
        order by updated_at desc
      `));
      if (left.length > 0 && !left.some((row) => asBool(row.isDefault))) {
        await tx.execute(sql`update dashboards set is_default = true where id = ${left[0]!.id}::uuid and tenant_id = ${tenantId}::uuid`);
      }
    });
  }

  async data(tenantId: string, userId: string, dashboardId: string) {
    this.assertUuid(dashboardId);
    const widgets = await withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.owned(tx, tenantId, userId, dashboardId);
      return this.widgetsOf(tx, tenantId, dashboardId);
    });
    const figures = [];
    for (const widget of widgets) {
      figures.push(await this.figure(tenantId, widget));
    }
    return { dashboardId, generatedAt: new Date().toISOString(), widgets: figures };
  }

  async pdf(tenantId: string, userId: string, dashboardId: string) {
    const figures = await this.data(tenantId, userId, dashboardId);
    const lines = figures.widgets.map((widget) => {
      const item = catalogByKey(widget.key);
      const value = widget.value ?? (widget.rows ? `${widget.rows.length} rows` : widget.error ?? 'n/a');
      return `${item?.titleEn ?? widget.key}: ${value}`;
    });
    return dashboardPdf({ title: 'ERP Cloud dashboard', lines });
  }

  private async figure(tenantId: string, widget: WidgetRow): Promise<Figure> {
    const item = catalogByKey(widget.widgetKey);
    const base = {
      id: widget.id,
      key: widget.widgetKey,
      titleAr: widget.titleAr,
      kind: widget.kind,
      unit: item?.unit ?? 'text',
      comparisonAr: item?.comparisonAr,
      positionX: widget.positionX,
      positionY: widget.positionY,
      width: widget.width,
      height: widget.height,
    };
    const cached = await this.readCache(widget.id);
    if (cached) {
      try {
        return { ...base, ...(JSON.parse(cached) as WidgetPayload), cached: true };
      } catch {
        this.memory.delete(widgetCacheKey(widget.id));
      }
    }
    try {
      const payload = await withTenantTx(this.database.db, tenantId, (tx) => queryWidget(tx, tenantId, widget.widgetKey));
      await this.writeCache(widget.id, JSON.stringify(payload));
      return { ...base, ...payload, cached: false };
    } catch (error) {
      this.logger.warn(`widget ${widget.widgetKey} failed: ${error instanceof Error ? error.message : 'unknown'}`);
      return { ...base, error: 'تعذر حساب هذا المؤشر', cached: false };
    }
  }

  private async readCache(widgetId: string): Promise<string | undefined> {
    const key = widgetCacheKey(widgetId);
    const local = this.memory.get(key);
    if (local && isCacheFresh(local.at, Date.now())) return local.json;
    if (local) this.memory.delete(key);
    if (this.redisDown) return undefined;
    const reply = await redisCommand(['GET', key]);
    if (reply === undefined) {
      this.redisDown = true;
      return undefined;
    }
    const value = bulkValue(reply);
    if (!value) return undefined;
    this.memory.set(key, { at: Date.now(), json: value });
    return value;
  }

  private async writeCache(widgetId: string, json: string): Promise<void> {
    const key = widgetCacheKey(widgetId);
    this.memory.set(key, { at: Date.now(), json });
    if (this.redisDown) return;
    const reply = await redisCommand(['SETEX', key, String(WIDGET_CACHE_TTL_MS / 1000), json]);
    if (reply === undefined) this.redisDown = true;
  }

  private async ensureDefault(tenantId: string, userId: string): Promise<void> {
    const existing = await withTenantTx(this.database.db, tenantId, async (tx) =>
      rowsOf<{ id: string }>(await tx.execute(sql`
        select id from dashboards where tenant_id = ${tenantId}::uuid and owner_user_id = ${userId}::uuid limit 1
      `)),
    );
    if (existing[0]) return;
    try {
      await withTenantTx(this.database.db, tenantId, async (tx) => {
        const id = newId();
        await tx.insert(dashboards).values({ id, tenantId, ownerUserId: userId, name: 'لوحتي', isDefault: true });
        for (const widget of starterWidgets()) {
          const item = catalogByKey(widget.key);
          if (!item) continue;
          await tx.insert(dashboardWidgets).values({
            id: newId(),
            tenantId,
            dashboardId: id,
            widgetKey: item.key,
            titleAr: item.titleAr,
            kind: item.kind,
            config: {},
            positionX: widget.positionX,
            positionY: widget.positionY,
            width: widget.width,
            height: widget.height,
          });
        }
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }

  private async collapseDefaults(tx: DrizzleTx, tenantId: string, userId: string): Promise<void> {
    const rows = rowsOf<{ id: string; isDefault: boolean; updatedAt: Date | string }>(await tx.execute(sql`
      select id, is_default as "isDefault", updated_at as "updatedAt"
      from dashboards
      where tenant_id = ${tenantId}::uuid and owner_user_id = ${userId}::uuid
    `));
    const decision = keepOneDefault(rows.map((row) => ({ id: row.id, isDefault: asBool(row.isDefault), updatedAt: new Date(row.updatedAt).toISOString() })));
    for (const id of decision.clearIds) {
      await tx.execute(sql`update dashboards set is_default = false where id = ${id}::uuid and tenant_id = ${tenantId}::uuid`);
    }
  }

  private async owned(tx: DrizzleTx, tenantId: string, userId: string, dashboardId: string) {
    const rows = rowsOf<{ id: string; name: string; isDefault: boolean }>(await tx.execute(sql`
      select id, name, is_default as "isDefault"
      from dashboards
      where id = ${dashboardId}::uuid and tenant_id = ${tenantId}::uuid and owner_user_id = ${userId}::uuid
    `));
    const board = rows[0];
    if (!board) throw new DomainError(errorCodes.NOT_FOUND, 'اللوحة غير موجودة', 404);
    return { id: board.id, name: board.name, isDefault: asBool(board.isDefault) };
  }

  private async widgetsOf(tx: DrizzleTx, tenantId: string, dashboardId: string): Promise<WidgetRow[]> {
    return rowsOf<WidgetRow>(await tx.execute(sql`
      select id, widget_key as "widgetKey", title_ar as "titleAr", kind,
             position_x as "positionX", position_y as "positionY", width, height
      from dashboard_widgets
      where tenant_id = ${tenantId}::uuid and dashboard_id = ${dashboardId}::uuid
      order by position_y, position_x
    `));
  }

  private assertUuid(value: string): void {
    if (!UUID.test(value)) throw new DomainError(errorCodes.NOT_FOUND, 'اللوحة غير موجودة', 404);
  }
}
