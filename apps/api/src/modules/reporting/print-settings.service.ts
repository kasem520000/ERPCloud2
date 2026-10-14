import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError, newId } from '@erp/contracts';
import { printSettings, withTenantTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { tryGetAuthContext } from '../platform/context/tenant-context.js';

import { reportByKey } from './report-catalog.js';

/**
 * 🎯 نطاقات إعدادات الطباعة — the radios of `frmSettings.xaml` «🧩 تفعيل إعدادات الطباعة»
 * (`ckAll` · `ckPurchInv` · `ckSaleInv` · `ckPOSInv` · `ckRentInv` · `ckContracts` ·
 * `ckReports`, lines 2095-2116 of `frmSettings.xaml.cs`). The desktop saves them as the
 * integers 0..6 of `SettingPrint.Inv_Id`; the cloud keeps the names, because the report
 * windows read a different set of integers entirely (`frmRptKhzna` L106 reads 12,
 * `frmRptEntries` reads 9, `frmRptRentInvoices` L541 reads 14).
 */
export const PRINT_SCOPES = ['default', 'purchases', 'sales', 'pos', 'rental', 'contracts', 'reports'] as const;
export type PrintScope = (typeof PRINT_SCOPES)[number];

/** The Arabic label of every scope, taken from the radio `Content` of `frmSettings.xaml`. */
export const PRINT_SCOPE_LABELS: Record<PrintScope, string> = {
  default: 'الإفتراضي',
  purchases: 'مشتريات',
  sales: 'مبيعات',
  pos: 'نقطة بيع',
  rental: 'تأجير',
  contracts: 'عقود',
  reports: 'تقارير',
};

/** `report:<key>` — one report's own settings, on top of the «تقارير» and «الإفتراضي» scopes. */
export const REPORT_SCOPE_PREFIX = 'report:';

export function reportScope(key: string): string {
  return `${REPORT_SCOPE_PREFIX}${key}`;
}

/**
 * 📝 الحقول — the settings of one scope.
 *
 * The defaults are the ones `Class/Print.cs` L54-L64 builds when the desktop finds no
 * `SettingPrint` row (`PrintType=2`, `PrintHeader=true`, `PrintNo=1`, `PrintItemType=1`,
 * no footer) — except `printType`, which defaults to 1 here because this platform prints
 * A4 PDFs, and the desktop's own «🖨️ افتراضي طباعة الفواتير» (`frmInvRptType`) opens with
 * «📄 ورقة A4» selected.
 */
export type PrintSettings = {
  scope: string;
  printType: 1 | 2;
  printHeader: boolean;
  printFooter: boolean;
  printStamp: boolean;
  printItemDetails: boolean;
  printItemGroups: boolean;
  printComponentsIndividually: boolean;
  printMakePay: boolean;
  printNo: number;
  printItemType: number;
  casherPrinter: string;
  kitchenPrinter: string;
  rptName: string;
  rptUrl: string;
  note: string;
  headerImageUrl: string;
  footerImageUrl: string;
  stampImageUrl: string;
  /** False when the row was read from the defaults rather than the database. */
  saved: boolean;
};

const defaults = (scope: string): PrintSettings => ({
  scope,
  printType: 1,
  printHeader: true,
  printFooter: false,
  printStamp: true,
  printItemDetails: false,
  printItemGroups: false,
  printComponentsIndividually: false,
  printMakePay: false,
  printNo: 1,
  printItemType: 1,
  casherPrinter: '',
  kitchenPrinter: '',
  rptName: '',
  rptUrl: '',
  note: '',
  headerImageUrl: '',
  footerImageUrl: '',
  stampImageUrl: '',
  saved: false,
});

/** 🌐 URL or nothing — the platform has no byte store, so images are links, not files. */
const url = z.string().trim().max(600).refine((value) => value === '' || /^https?:\/\/\S+$/i.test(value), { message: 'must be an http(s) URL' });
const shortText = z.string().trim().max(120);

export const printSettingsInputSchema = z.object({
  printType: z.coerce.number().int().min(1).max(2).optional(),
  printHeader: z.coerce.boolean().optional(),
  printFooter: z.coerce.boolean().optional(),
  printStamp: z.coerce.boolean().optional(),
  printItemDetails: z.coerce.boolean().optional(),
  printItemGroups: z.coerce.boolean().optional(),
  printComponentsIndividually: z.coerce.boolean().optional(),
  printMakePay: z.coerce.boolean().optional(),
  printNo: z.coerce.number().int().min(1).max(50).optional(),
  printItemType: z.coerce.number().int().min(1).max(9).optional(),
  casherPrinter: shortText.optional(),
  kitchenPrinter: shortText.optional(),
  rptName: shortText.optional(),
  rptUrl: shortText.optional(),
  note: z.string().trim().max(600).optional(),
  headerImageUrl: url.optional(),
  footerImageUrl: url.optional(),
  stampImageUrl: url.optional(),
});

export type PrintSettingsInput = z.infer<typeof printSettingsInputSchema>;

/**
 * 🖨️ إعدادات الطباعة — one row per scope per tenant.
 *
 * The desktop is single-tenant and one shop: `SettingPrint` has no branch or tenant, and
 * `frmSettings` deletes and re-inserts the row on every save. Here the row is
 * tenant-scoped (RLS `tenant_id`) and upserted, and an unknown scope is rejected with 404
 * — a typo must not create a row that silently prints nothing.
 */
@Injectable()
export class PrintSettingsService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  /** Step 1 — validate the scope: a fixed name, or `report:<key>` for a registered report. */
  parseScope(scope: string): string {
    const value = decodeURIComponent((scope ?? '').trim());
    if (PRINT_SCOPES.includes(value as PrintScope)) return value;
    if (value.startsWith(REPORT_SCOPE_PREFIX)) {
      const key = value.slice(REPORT_SCOPE_PREFIX.length);
      if (!reportByKey.has(key)) throw new DomainError('REPORT_NOT_FOUND', 'Report key is not registered', 404);
      return value;
    }
    throw new DomainError('PRINT_SCOPE_INVALID', 'Unknown print scope', 404);
  }

  /** 📋 الكل — every saved row, and the defaults for the scopes that were never saved. */
  async list(tenantId: string): Promise<{ data: PrintSettings[] }> {
    const saved = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(printSettings).where(eq(printSettings.tenantId, tenantId)).orderBy(asc(printSettings.scope)));
    const byScope = new Map(saved.map((row) => [row.scope, this.toSettings(row)]));
    const data = PRINT_SCOPES.map((scope) => byScope.get(scope) ?? defaults(scope));
    return { data };
  }

  /** 🔍 الواحد — the saved row of one scope, or the defaults. */
  async read(tenantId: string, rawScope: string): Promise<PrintSettings> {
    const scope = this.parseScope(rawScope);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(printSettings).where(and(eq(printSettings.tenantId, tenantId), eq(printSettings.scope, scope))));
    return row ? this.toSettings(row) : defaults(scope);
  }

  /** 💾 حفظ — upsert one scope; absent fields keep their current (or default) value. */
  async write(tenantId: string, rawScope: string, input: PrintSettingsInput): Promise<PrintSettings> {
    const scope = this.parseScope(rawScope);
    const parsed = printSettingsInputSchema.parse(input);
    const current = await this.read(tenantId, scope);
    const base = { ...current, ...parsed } as PrintSettings;
    const patch = {
      printType: base.printType,
      printHeader: base.printHeader,
      printFooter: base.printFooter,
      printStamp: base.printStamp,
      printItemDetails: base.printItemDetails,
      printItemGroups: base.printItemGroups,
      printComponentsIndividually: base.printComponentsIndividually,
      printMakePay: base.printMakePay,
      printNo: base.printNo,
      printItemType: base.printItemType,
      casherPrinter: base.casherPrinter,
      kitchenPrinter: base.kitchenPrinter,
      rptName: base.rptName,
      rptUrl: base.rptUrl,
      note: base.note,
      headerImageUrl: base.headerImageUrl,
      footerImageUrl: base.footerImageUrl,
      stampImageUrl: base.stampImageUrl,
      updatedAt: new Date(),
      updatedBy: tryGetAuthContext()?.userId ?? null,
    };

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      if (current.saved) {
        await tx.update(printSettings).set(patch).where(and(eq(printSettings.tenantId, tenantId), eq(printSettings.scope, scope)));
      } else {
        await tx.insert(printSettings).values({
          id: newId(),
          tenantId,
          scope,
          ...patch,
          createdBy: tryGetAuthContext()?.userId ?? null,
        });
      }
      const [row] = await tx.select().from(printSettings).where(and(eq(printSettings.tenantId, tenantId), eq(printSettings.scope, scope)));
      return this.toSettings(row!);
    });
  }

  /** 🗑️ حذف — back to the defaults, the way `frmSettings` deletes its row before saving. */
  async reset(tenantId: string, rawScope: string): Promise<PrintSettings> {
    const scope = this.parseScope(rawScope);
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.delete(printSettings).where(and(eq(printSettings.tenantId, tenantId), eq(printSettings.scope, scope))));
    return defaults(scope);
  }

  /**
   * 🧩 الفعلي — the settings the printer will actually use: the first scope that has a
   * saved row wins, walking `report:<key>` → «تقارير» → «الإفتراضي».
   */
  async effective(tenantId: string, scopes: string[]): Promise<PrintSettings> {
    const list = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(printSettings).where(and(eq(printSettings.tenantId, tenantId))));
    const byScope = new Map(list.map((row) => [row.scope, row]));
    for (const scope of scopes) {
      const row = byScope.get(scope);
      if (row) return this.toSettings(row);
    }
    return defaults(scopes[0] ?? 'default');
  }

  private toSettings(row: typeof printSettings.$inferSelect): PrintSettings {
    return {
      scope: row.scope,
      printType: row.printType === 2 ? 2 : 1,
      printHeader: row.printHeader,
      printFooter: row.printFooter,
      printStamp: row.printStamp,
      printItemDetails: row.printItemDetails,
      printItemGroups: row.printItemGroups,
      printComponentsIndividually: row.printComponentsIndividually,
      printMakePay: row.printMakePay,
      printNo: row.printNo,
      printItemType: row.printItemType,
      casherPrinter: row.casherPrinter ?? '',
      kitchenPrinter: row.kitchenPrinter ?? '',
      rptName: row.rptName ?? '',
      rptUrl: row.rptUrl ?? '',
      note: row.note ?? '',
      headerImageUrl: row.headerImageUrl ?? '',
      footerImageUrl: row.footerImageUrl ?? '',
      stampImageUrl: row.stampImageUrl ?? '',
      saved: true,
    };
  }
}
