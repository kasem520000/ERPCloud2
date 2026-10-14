import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { DomainError, errorCodes, newId } from '@erp/contracts';
import { reportLayouts, withTenantTx, type DatabaseHandle, type ReportLayoutColumn } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { tryGetAuthContext } from '../platform/context/tenant-context.js';

import { reportByKey } from './report-catalog.js';

export type ReportLayoutInput = {
  reportKey: string;
  name: string;
  titleAr?: string | null;
  columns?: ReportLayoutColumn[];
  filters?: Record<string, string>;
  isDefault?: boolean;
};

/**
 * مصمم التقارير — the report designer, reduced to the part that is safe to expose.
 *
 * The desktop designer let a user author the report itself. On a multi-tenant service that
 * is a SQL injection surface with a friendly icon, so a layout here stores **presentation
 * only**: which of the report's own columns are shown, in what order, under what heading,
 * and which filters it opens with. The query stays in the server-side catalog, which also
 * means a layout can never outlive its report — an unknown key is rejected on save.
 */
@Injectable()
export class ReportLayoutsService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  async list(tenantId: string, reportKey?: string) {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(reportLayouts)
        .where(and(eq(reportLayouts.tenantId, tenantId), reportKey ? eq(reportLayouts.reportKey, reportKey) : undefined))
        .orderBy(asc(reportLayouts.reportKey), asc(reportLayouts.name)));
  }

  async create(tenantId: string, input: ReportLayoutInput) {
    const definition = this.requireReport(input.reportKey);
    const name = (input.name ?? '').trim();
    if (name.length < 2) throw new DomainError(errorCodes.VALIDATION_FAILED, 'The layout needs a name', 422);
    const columns = this.normalizeColumns(input.reportKey, input.columns ?? definition.columns.map((column) => ({ key: column.key, visible: true })));
    const id = newId();

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const clash = await tx.select({ id: reportLayouts.id }).from(reportLayouts)
        .where(and(eq(reportLayouts.tenantId, tenantId), eq(reportLayouts.reportKey, input.reportKey), eq(reportLayouts.name, name)));
      if (clash.length) throw new DomainError(errorCodes.VERSION_CONFLICT, 'A layout with that name already exists for this report', 409);
      if (input.isDefault) await this.clearDefault(tx, tenantId, input.reportKey);
      await tx.insert(reportLayouts).values({
        id, tenantId, reportKey: input.reportKey, name, titleAr: input.titleAr ?? null,
        columns, filters: input.filters ?? {}, isDefault: input.isDefault ?? false,
        createdBy: tryGetAuthContext()?.userId,
      });
      const [row] = await tx.select().from(reportLayouts).where(and(eq(reportLayouts.tenantId, tenantId), eq(reportLayouts.id, id)));
      return row;
    });
  }

  async update(tenantId: string, id: string, input: Partial<ReportLayoutInput>) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [existing] = await tx.select().from(reportLayouts).where(and(eq(reportLayouts.tenantId, tenantId), eq(reportLayouts.id, id)));
      if (!existing) throw new DomainError(errorCodes.NOT_FOUND, 'Layout was not found', 404);
      if (input.isDefault) await this.clearDefault(tx, tenantId, existing.reportKey);
      await tx.update(reportLayouts).set({
        name: input.name?.trim() ?? existing.name,
        titleAr: input.titleAr === undefined ? existing.titleAr : input.titleAr,
        columns: input.columns ? this.normalizeColumns(existing.reportKey, input.columns) : existing.columns,
        filters: input.filters ?? existing.filters,
        isDefault: input.isDefault ?? existing.isDefault,
        updatedAt: new Date(),
        updatedBy: tryGetAuthContext()?.userId,
      }).where(and(eq(reportLayouts.tenantId, tenantId), eq(reportLayouts.id, id)));
      const [row] = await tx.select().from(reportLayouts).where(and(eq(reportLayouts.tenantId, tenantId), eq(reportLayouts.id, id)));
      return row;
    });
  }

  async remove(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const result = await tx.delete(reportLayouts).where(and(eq(reportLayouts.tenantId, tenantId), eq(reportLayouts.id, id)));
      if (!result.rowCount) throw new DomainError(errorCodes.NOT_FOUND, 'Layout was not found', 404);
      return { id, deleted: true };
    });
  }

  /** Resolve a layout for a run: explicit id or name, otherwise the report's default. */
  async resolve(tenantId: string, reportKey: string, layoutRef?: string) {
    if (layoutRef === 'none') return null;
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rows = await tx.select().from(reportLayouts).where(and(eq(reportLayouts.tenantId, tenantId), eq(reportLayouts.reportKey, reportKey)));
      if (!rows.length) return null;
      if (!layoutRef) return rows.find((row) => row.isDefault) ?? null;
      const match = rows.find((row) => row.id === layoutRef || row.name === layoutRef);
      if (!match) throw new DomainError('REPORT_LAYOUT_NOT_FOUND', 'That layout does not exist for this report', 404);
      return match;
    });
  }

  private requireReport(key: string) {
    const definition = reportByKey.get(key);
    if (!definition) throw new DomainError('REPORT_NOT_FOUND', 'Report key is not registered', 404);
    return definition;
  }

  /** Drop anything the report does not actually produce; keep the caller's order. */
  private normalizeColumns(reportKey: string, columns: ReportLayoutColumn[]): ReportLayoutColumn[] {
    const known = new Set(this.requireReport(reportKey).columns.map((column) => column.key));
    const seen = new Set<string>();
    const kept: ReportLayoutColumn[] = [];
    for (const column of columns) {
      if (!known.has(column.key) || seen.has(column.key)) continue;
      seen.add(column.key);
      kept.push({ key: column.key, labelAr: column.labelAr?.trim() || undefined, visible: column.visible !== false });
    }
    if (!kept.some((column) => column.visible)) {
      throw new DomainError('REPORT_LAYOUT_EMPTY', 'A layout must leave at least one column visible', 422);
    }
    return kept;
  }

  private async clearDefault(tx: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> }, tenantId: string, reportKey: string) {
    await tx.execute(sql`UPDATE report_layouts SET is_default = false WHERE tenant_id = ${tenantId} AND report_key = ${reportKey}`);
  }
}
