import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError, newId } from '@erp/contracts';
import { printerReportLinks, withTenantTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { tryGetAuthContext } from '../platform/context/tenant-context.js';

import { PrintSettingsService, REPORT_SCOPE_PREFIX, PRINT_SCOPES } from './print-settings.service.js';
import { reportByKey } from './report-catalog.js';

export const printerLinkInputSchema = z.object({
  scope: z.string().trim().min(1).max(120),
  printName: z.string().trim().min(1).max(120),
  printerName: z.string().trim().min(1).max(120),
  rptUrl: z.string().trim().max(600).optional(),
  rptName: z.string().trim().max(120).optional(),
});

export type PrinterLinkInput = z.infer<typeof printerLinkInputSchema>;

export type PrinterLink = {
  id: string;
  scope: string;
  scopeLabelAr: string;
  printName: string;
  printerName: string;
  rptUrl: string;
  rptName: string;
  createdAt: string;
};

@Injectable()
export class PrinterLinksService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly printSettings: PrintSettingsService,
  ) {}

  /** Validate scope: fixed name or report:<key> */
  parseScope(raw: string): string {
    const value = (raw ?? '').trim();
    if (PRINT_SCOPES.includes(value as any)) return value;
    if (value.startsWith(REPORT_SCOPE_PREFIX)) {
      const key = value.slice(REPORT_SCOPE_PREFIX.length);
      if (!reportByKey.has(key)) throw new DomainError('REPORT_NOT_FOUND', 'Report key is not registered', 404);
      return value;
    }
    // also allow plain 'default'
    if (value === 'default') return value;
    // legacy Inv_Id integers? map 0..6 to scopes, and 9,11,12,14 to defaults
    const legacyMap: Record<string, string> = {
      '0': 'default',
      '1': 'purchases',
      '2': 'sales',
      '3': 'pos',
      '4': 'rental',
      '5': 'contracts',
      '6': 'reports',
      '9': 'default',
      '11': 'default',
      '12': 'reports',
      '14': 'rental',
    };
    if (legacyMap[value]) return legacyMap[value];
    throw new DomainError('PRINT_SCOPE_INVALID', 'Unknown print scope', 404);
  }

  async list(tenantId: string): Promise<{ data: PrinterLink[] }> {
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(printerReportLinks).where(eq(printerReportLinks.tenantId, tenantId)).orderBy(asc(printerReportLinks.scope), asc(printerReportLinks.printName)),
    );
    return { data: rows.map((r) => this.toLink(r)) };
  }

  async create(tenantId: string, input: PrinterLinkInput): Promise<PrinterLink> {
    const parsed = printerLinkInputSchema.parse(input);
    const scope = this.parseScope(parsed.scope);
    const id = newId();
    const now = new Date();
    const userId = tryGetAuthContext()?.userId ?? null;
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await tx.insert(printerReportLinks).values({
        id,
        tenantId,
        scope,
        printName: parsed.printName,
        printerName: parsed.printerName,
        rptUrl: parsed.rptUrl ?? '',
        rptName: parsed.rptName ?? '',
        createdAt: now,
        createdBy: userId,
        updatedAt: now,
        updatedBy: userId,
      });
    });
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(printerReportLinks).where(and(eq(printerReportLinks.tenantId, tenantId), eq(printerReportLinks.id, id))),
    );
    if (!row) throw new DomainError('NOT_FOUND', 'Link not found', 404);
    return this.toLink(row);
  }

  async update(tenantId: string, id: string, input: Partial<PrinterLinkInput>): Promise<PrinterLink> {
    const existing = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(printerReportLinks).where(and(eq(printerReportLinks.tenantId, tenantId), eq(printerReportLinks.id, id))),
    );
    if (!existing[0]) throw new DomainError('NOT_FOUND', 'Link not found', 404);
    const patch: Record<string, unknown> = {};
    if (input.scope !== undefined) patch.scope = this.parseScope(input.scope);
    if (input.printName !== undefined) patch.printName = input.printName.trim();
    if (input.printerName !== undefined) patch.printerName = input.printerName.trim();
    if (input.rptUrl !== undefined) patch.rptUrl = input.rptUrl.trim();
    if (input.rptName !== undefined) patch.rptName = input.rptName.trim();
    patch.updatedAt = new Date();
    patch.updatedBy = tryGetAuthContext()?.userId ?? null;
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.update(printerReportLinks).set(patch as any).where(and(eq(printerReportLinks.tenantId, tenantId), eq(printerReportLinks.id, id))),
    );
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(printerReportLinks).where(and(eq(printerReportLinks.tenantId, tenantId), eq(printerReportLinks.id, id))),
    );
    return this.toLink(row!);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const existing = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(printerReportLinks).where(and(eq(printerReportLinks.tenantId, tenantId), eq(printerReportLinks.id, id))),
    );
    if (!existing[0]) throw new DomainError('NOT_FOUND', 'Link not found', 404);
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.delete(printerReportLinks).where(and(eq(printerReportLinks.tenantId, tenantId), eq(printerReportLinks.id, id))),
    );
  }

  private toLink(row: typeof printerReportLinks.$inferSelect): PrinterLink {
    const scopeLabels: Record<string, string> = {
      default: 'الإفتراضي',
      purchases: 'مشتريات',
      sales: 'مبيعات',
      pos: 'نقطة بيع',
      rental: 'تأجير',
      contracts: 'عقود',
      reports: 'تقارير',
    };
    const label = row.scope.startsWith('report:')
      ? `تقرير:${row.scope.slice(7)}`
      : scopeLabels[row.scope] ?? row.scope;
    return {
      id: row.id,
      scope: row.scope,
      scopeLabelAr: label,
      printName: row.printName,
      printerName: row.printerName,
      rptUrl: row.rptUrl ?? '',
      rptName: row.rptName ?? '',
      createdAt: (row.createdAt as any)?.toISOString?.() ?? String(row.createdAt),
    };
  }
}
