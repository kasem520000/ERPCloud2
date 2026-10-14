import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  accounts,
  branches,
  branchPostingProfiles,
  cashLocationBalances,
  cashLocations,
  currencies,
  DEMO_CHART_OF_ACCOUNTS,
  DEMO_POSTING_PROFILE,
  newId,
  parties,
  priceLists,
  salaryAdjustmentTypes,
  tailoringGarmentTypes,
  tailoringMeasurementAttributes,
  tailoringOrderStatuses,
  tenants,
  warehouses,
  withTenantTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.module.js';

/**
 * `provisionOrgDefaults(tenantId)` — PHASE_05 §5.7.
 *
 * A tenant that exists but has no branch cannot be used: documents cannot be numbered
 * (`document_sequences` is scoped by branch), stock has nowhere to live and money has
 * nowhere to sit. This service creates that minimum — base currency, main branch, main
 * warehouse, main safe with a zero balance, default price list — and is the seam the
 * PHASE_03 tenant factory and the PHASE_15 migrator both call.
 *
 * It is **idempotent**: every step is skipped when its row already exists, so calling it
 * twice (a retried provisioning job, a re-run import) is safe and returns the same ids.
 * It deliberately writes through the tables rather than through the CRUD services: it
 * runs outside any HTTP request, so there is no branch scope, no actor and no audit
 * interceptor to satisfy.
 */

export type OrgDefaults = {
  tenantId: string;
  branchId: string;
  warehouseId: string;
  cashLocationId: string;
  priceListId: string;
  currencyCode: string;
  /** False when everything already existed — the call was a no-op. */
  created: boolean;
};

export type ProvisionOptions = {
  actorUserId?: string | null;
  /** Defaults to `MAIN`; the migrator overrides it to match the legacy code. */
  code?: string;
  nameAr?: string;
  nameEn?: string;
};

const DEFAULT_CODE = 'MAIN';

@Injectable()
export class OrgProvisioningService {
  private readonly logger = new Logger(OrgProvisioningService.name);

  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  async provisionOrgDefaults(tenantId: string, options: ProvisionOptions = {}): Promise<OrgDefaults> {
    return withTenantTx(this.database.db, tenantId, (tx) => this.provisionInTx(tx, tenantId, options));
  }

  /** Same work inside a caller's transaction — the tenant factory creates both at once. */
  async provisionInTx(tx: DrizzleTx, tenantId: string, options: ProvisionOptions = {}): Promise<OrgDefaults> {
    const actorUserId = options.actorUserId ?? null;
    const now = new Date();
    const code = (options.code ?? DEFAULT_CODE).toUpperCase();
    const nameAr = options.nameAr ?? 'الفرع الرئيسي';
    const nameEn = options.nameEn ?? 'Main branch';
    let created = false;

    const currencyCode = await this.ensureBaseCurrency(tx, tenantId, actorUserId, now);
    const mainCashAccountId = await this.ensureChartOfAccounts(tx, tenantId, actorUserId, now);
    if (mainCashAccountId) created = true;
    if (await this.ensurePostingProfile(tx, tenantId, actorUserId, now)) created = true;
    if (await this.ensureSalaryAdjustmentTypes(tx, tenantId, actorUserId, now)) created = true;
    if (await this.ensureTailoringOrderStatuses(tx, tenantId, actorUserId, now)) created = true;
    if (await this.ensureTailoringGarmentTypes(tx, tenantId, actorUserId, now)) created = true;
    if (await this.ensureMeasurementAttributes(tx, tenantId, actorUserId, now)) created = true;

    let branchId = await firstId(
      tx
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.tenantId, tenantId), eq(branches.isDefault, true), isNull(branches.deletedAt)))
        .limit(1),
    );
    if (!branchId) {
      branchId = newId();
      await tx.insert(branches).values({
        id: branchId,
        tenantId,
        code,
        nameAr,
        nameEn,
        isDefault: true,
        isActive: true,
        createdAt: now,
        createdBy: actorUserId,
      });
      created = true;
    }

    let warehouseId = await firstId(
      tx
        .select({ id: warehouses.id })
        .from(warehouses)
        .where(
          and(
            eq(warehouses.tenantId, tenantId),
            eq(warehouses.isDefault, true),
            isNull(warehouses.deletedAt),
          ),
        )
        .limit(1),
    );
    if (!warehouseId) {
      warehouseId = newId();
      await tx.insert(warehouses).values({
        id: warehouseId,
        tenantId,
        branchId,
        code,
        name: nameEn,
        isDefault: true,
        isActive: true,
        createdAt: now,
        createdBy: actorUserId,
      });
      created = true;
    }

    let cashLocationId = await firstId(
      tx
        .select({ id: cashLocations.id })
        .from(cashLocations)
        .where(
          and(
            eq(cashLocations.tenantId, tenantId),
            eq(cashLocations.kind, 'safe'),
            eq(cashLocations.isDefault, true),
            isNull(cashLocations.deletedAt),
          ),
        )
        .limit(1),
    );
    if (!cashLocationId) {
      cashLocationId = newId();
      await tx.insert(cashLocations).values({
        id: cashLocationId,
        tenantId,
        branchId,
        kind: 'safe',
        name: 'Main safe',
        // The desktop chart is seeded above, so the safe posts to 1211001 from day one.
        accountId: mainCashAccountId,
        currencyCode: null,
        isDefault: true,
        isActive: true,
        createdAt: now,
        createdBy: actorUserId,
      });
      created = true;
    }

    // PHASE_05 §11: a provisioned tenant's safe reports a balance, and it is zero.
    await tx
      .insert(cashLocationBalances)
      .values({ tenantId, cashLocationId, currencyCode, balance: '0' })
      .onConflictDoNothing();

    let priceListId = await firstId(
      tx
        .select({ id: priceLists.id })
        .from(priceLists)
        .where(
          and(
            eq(priceLists.tenantId, tenantId),
            eq(priceLists.isDefault, true),
            isNull(priceLists.deletedAt),
          ),
        )
        .limit(1),
    );
    if (!priceListId) {
      priceListId = newId();
      await tx.insert(priceLists).values({
        id: priceListId,
        tenantId,
        name: 'Default price list',
        currencyCode,
        isDefault: true,
        isActive: true,
        createdAt: now,
        createdBy: actorUserId,
      });
      created = true;
    }

    const defaultCustomer = await firstId(
      tx
        .select({ id: parties.id })
        .from(parties)
        .where(
          and(
            eq(parties.tenantId, tenantId),
            eq(parties.code, 'CUST-GEN'),
            isNull(parties.deletedAt),
          ),
        )
        .limit(1),
    );
    if (!defaultCustomer) {
      await tx
        .insert(parties)
        .values({
          id: newId(),
          tenantId,
          code: 'CUST-GEN',
          kind: 'customer',
          name: 'عميل عام',
          legalName: 'عميل عام',
          creditLimit: '0',
          createdAt: now,
          createdBy: actorUserId,
        })
        .onConflictDoNothing();
    }

    const defaultSupplier = await firstId(
      tx
        .select({ id: parties.id })
        .from(parties)
        .where(
          and(
            eq(parties.tenantId, tenantId),
            eq(parties.code, 'SUPP-GEN'),
            isNull(parties.deletedAt),
          ),
        )
        .limit(1),
    );
    if (!defaultSupplier) {
      await tx
        .insert(parties)
        .values({
          id: newId(),
          tenantId,
          code: 'SUPP-GEN',
          kind: 'supplier',
          name: 'مورد عام',
          legalName: 'مورد عام',
          creditLimit: '0',
          createdAt: now,
          createdBy: actorUserId,
        })
        .onConflictDoNothing();
    }

    if (created) {
      this.logger.log(
        { tenantId, branchId, warehouseId, cashLocationId },
        'organization defaults provisioned',
      );
    }

    return { tenantId, branchId, warehouseId, cashLocationId, priceListId, currencyCode, created };
  }

  /**
   * Seeds the desktop default chart of accounts (`Accounts_Index`, 112 accounts + the
   * cloud COGS extension) for a tenant that has none yet.
   *
   * Idempotent: a tenant with any live account is left untouched, so re-running
   * provisioning never duplicates or renames the accountant's chart. Parents precede
   * children in `DEMO_CHART_OF_ACCOUNTS`, so one ordered pass resolves every `parent_id`,
   * `level` and ltree `path` exactly the way `AccountingService.create` would.
   *
   * Returns the id of 1211001 (الصندوق الرئيسي) so the main safe can post to it —
   * or `null` when the chart already existed (the safe keeps whatever link it has).
   */
  private async ensureChartOfAccounts(
    tx: DrizzleTx,
    tenantId: string,
    actorUserId: string | null,
    now: Date,
  ): Promise<string | null> {
    /**
     * An existing chart is *completed*, never rewritten. Later phases add leaves to
     * `DEMO_CHART_OF_ACCOUNTS` (بضاعة تحت التحويل، تسويات المخزون …) and a tenant
     * provisioned before them would otherwise post every new document straight into
     * `ACCOUNT_PROFILE_MISSING` — with no way out short of hand-editing the chart.
     * Inserting the codes that are missing, and only those, keeps an accountant's
     * own edits intact while letting an old tenant use new features.
     */
    const existingRows = await tx
      .select({ id: accounts.id, code: accounts.code, path: accounts.path, level: accounts.level })
      .from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), isNull(accounts.deletedAt)));
    const idByCode = new Map(existingRows.map((row) => [row.code.trim(), row.id]));
    const pathByCode = new Map(existingRows.map((row) => [row.code.trim(), row.path]));
    const levelByCode = new Map(existingRows.map((row) => [row.code.trim(), row.level]));

    let inserted = 0;
    for (const account of DEMO_CHART_OF_ACCOUNTS) {
      if (idByCode.has(account.code)) continue;
      const id = newId();
      const parentId = account.parent ? idByCode.get(account.parent) : undefined;
      const parentPath = account.parent ? pathByCode.get(account.parent) : undefined;
      const level = account.parent ? (levelByCode.get(account.parent) ?? 0) + 1 : 0;
      const path = parentPath ? `${parentPath}.${id}` : id;
      await tx.insert(accounts).values({
        id,
        tenantId,
        code: account.code,
        nameAr: account.nameAr,
        nameEn: account.nameEn ?? null,
        parentId: parentId ?? null,
        level,
        path,
        type: account.type,
        normalBalance:
          account.normalBalance ??
          (account.type === 'asset' || account.type === 'expense' ? 'debit' : 'credit'),
        isPostable: account.postable !== false,
        allowManual: true,
        createdAt: now,
        createdBy: actorUserId,
        legacySource: 'desktop-erp',
        legacyId: `Accounts_Index:${account.code}`,
      });
      idByCode.set(account.code, id);
      pathByCode.set(account.code, path);
      levelByCode.set(account.code, level);
      inserted += 1;
    }

    if (inserted > 0) {
      this.logger.log({ tenantId, inserted, total: idByCode.size }, 'desktop chart of accounts seeded');
    }
    // A chart that already existed keeps whatever account its main safe is linked to.
    return existingRows.length > 0 ? null : (idByCode.get('1211001') ?? null);
  }

  /**
   * Seeds the tenant-wide posting profile (`branch NULL`, doc `*`) that every
   * auto-posting engine resolves through `PostingProfilesService` — the cloud heir
   * of the desktop `SettingGeneral.*Acc` defaults.
   *
   * Idempotent: an existing `*` profile is left untouched (the accountant may have
   * customised it). Codes that resolve to no account are omitted rather than
   * guessed — posting then fails with a named key error instead of corrupting the
   * ledger. Returns whether a profile was created.
   */
  /**
   * 🎁 أنواع الحوافز والجزاءات — the three rows `frmEmpSalaryAddSub` cannot work
   * without. `SalaryAddSubTypes` is a database table in the desktop and its seed is not
   * in the repository, but the code-behind names the three by id: 1 = مكافأة (an
   * addition), 2 = خصم, 3 = سلفة (both deductions). Migration `0050` inserts them for
   * every tenant that already existed; this does it for every tenant created after it,
   * in the same transaction that seeds the chart of accounts.
   */
  private async ensureSalaryAdjustmentTypes(
    tx: DrizzleTx,
    tenantId: string,
    actorUserId: string | null,
    now: Date,
  ): Promise<boolean> {
    const seed: Array<{ code: string; name: string; kind: string; sortOrder: number }> = [
      { code: 'bonus', name: 'مكافأة', kind: 'addition', sortOrder: 1 },
      { code: 'deduction', name: 'خصم', kind: 'deduction', sortOrder: 2 },
      { code: 'advance', name: 'سلفة', kind: 'deduction', sortOrder: 3 },
    ];
    const existing = await tx
      .select({ code: salaryAdjustmentTypes.code })
      .from(salaryAdjustmentTypes)
      .where(and(eq(salaryAdjustmentTypes.tenantId, tenantId), isNull(salaryAdjustmentTypes.deletedAt)));
    const present = new Set(existing.map((row) => row.code));
    const missing = seed.filter((row) => !present.has(row.code));
    if (!missing.length) return false;
    await tx.insert(salaryAdjustmentTypes).values(
      missing.map((row) => ({
        id: newId(),
        tenantId,
        code: row.code,
        name: row.name,
        kind: row.kind,
        sortOrder: row.sortOrder,
        isActive: true,
        createdAt: now,
        createdBy: actorUserId,
      })),
    );
    this.logger.log({ tenantId, inserted: missing.length }, 'salary adjustment types seeded');
    return true;
  }

  /**
   * 🧵 حالات طلب التفصيل — `OrderStatus` in `frmOrders.LoadStatusFilter` L54. The table's
   * seed is not in the repository; the one place the lifecycle is written in words is
   * `frmViewOrders.GetStateText` L119 (`مستلم · في الخياطة · جاهز · تم التسليم`).
   * Migration `0053` inserts them for every tenant that already existed; this does it
   * for every tenant created after it.
   */
  private async ensureTailoringOrderStatuses(
    tx: DrizzleTx,
    tenantId: string,
    actorUserId: string | null,
    now: Date,
  ): Promise<boolean> {
    const seed: Array<{ code: string; nameAr: string; displayOrder: number }> = [
      { code: 'received', nameAr: 'مستلم', displayOrder: 1 },
      { code: 'sewing', nameAr: 'في الخياطة', displayOrder: 2 },
      { code: 'ready', nameAr: 'جاهز', displayOrder: 3 },
      { code: 'delivered', nameAr: 'تم التسليم', displayOrder: 4 },
    ];
    const existing = await tx
      .select({ code: tailoringOrderStatuses.code })
      .from(tailoringOrderStatuses)
      .where(and(eq(tailoringOrderStatuses.tenantId, tenantId), isNull(tailoringOrderStatuses.deletedAt)));
    const present = new Set(existing.map((row) => row.code));
    const missing = seed.filter((row) => !present.has(row.code));
    if (!missing.length) return false;
    await tx.insert(tailoringOrderStatuses).values(
      missing.map((row) => ({
        id: newId(),
        tenantId,
        code: row.code,
        nameAr: row.nameAr,
        displayOrder: row.displayOrder,
        // ⚙️ الحالة النهائية — «تم التسليم», which is what ends ⌛ متأخّر.
        isFinal: row.code === 'delivered',
        active: true,
        createdAt: now,
        createdBy: actorUserId,
      })),
    );
    this.logger.log({ tenantId, inserted: missing.length }, 'tailoring order statuses seeded');
    return true;
  }

  /**
   * 👔 أنواع الثوب — `typeCB` in `AddNewSizes.xaml` L423 names its four items in the
   * markup (`سعودي · بحريني · اماراتي · كويتي`), unlike `OrderStatus` whose rows are
   * only data. Migration `0054` inserts them for every tenant that already existed;
   * this does it for every tenant created after it.
   */
  private async ensureTailoringGarmentTypes(
    tx: DrizzleTx,
    tenantId: string,
    actorUserId: string | null,
    now: Date,
  ): Promise<boolean> {
    const seed: Array<{ code: string; nameAr: string; displayOrder: number }> = [
      { code: 'saudi', nameAr: 'سعودي', displayOrder: 1 },
      { code: 'bahraini', nameAr: 'بحريني', displayOrder: 2 },
      { code: 'emirati', nameAr: 'اماراتي', displayOrder: 3 },
      { code: 'kuwaiti', nameAr: 'كويتي', displayOrder: 4 },
    ];
    const existing = await tx
      .select({ code: tailoringGarmentTypes.code })
      .from(tailoringGarmentTypes)
      .where(and(eq(tailoringGarmentTypes.tenantId, tenantId), isNull(tailoringGarmentTypes.deletedAt)));
    const present = new Set(existing.map((row) => row.code));
    const missing = seed.filter((row) => !present.has(row.code));
    if (!missing.length) return false;
    await tx.insert(tailoringGarmentTypes).values(
      missing.map((row) => ({
        id: newId(),
        tenantId,
        code: row.code,
        nameAr: row.nameAr,
        displayOrder: row.displayOrder,
        active: true,
        createdAt: now,
        createdBy: actorUserId,
      })),
    );
    this.logger.log({ tenantId, inserted: missing.length }, 'tailoring garment types seeded');
    return true;
  }

  /**
   * 📏 خصائص القياسات — `MeasurementAttributes(AttributeID, AttributeName, DisplayOrder,
   * IsActive)`. Rows of that table are data, and they are not in this repository; the
   * only place it names any خاصية is the add prompt of
   * `frmMeasurementAttributes.xaml.cs` `btnAdd_Click`:
   * «أدخل اسم الخاصية (مثل: الطول، العرض، الكم)» — so those three are seeded, in that
   * order, exactly as migration `0055` seeds them for tenants that already existed.
   */
  private async ensureMeasurementAttributes(
    tx: DrizzleTx,
    tenantId: string,
    actorUserId: string | null,
    now: Date,
  ): Promise<boolean> {
    const seed: Array<{ nameAr: string; displayOrder: number }> = [
      { nameAr: 'الطول', displayOrder: 1 },
      { nameAr: 'العرض', displayOrder: 2 },
      { nameAr: 'الكم', displayOrder: 3 },
    ];
    const existing = await tx
      .select({ nameAr: tailoringMeasurementAttributes.nameAr })
      .from(tailoringMeasurementAttributes)
      .where(and(eq(tailoringMeasurementAttributes.tenantId, tenantId), isNull(tailoringMeasurementAttributes.deletedAt)));
    const present = new Set(existing.map((row) => row.nameAr));
    const missing = seed.filter((row) => !present.has(row.nameAr));
    if (!missing.length) return false;
    await tx.insert(tailoringMeasurementAttributes).values(
      missing.map((row) => ({
        id: newId(),
        tenantId,
        nameAr: row.nameAr,
        displayOrder: row.displayOrder,
        active: true,
        createdAt: now,
        createdBy: actorUserId,
      })),
    );
    this.logger.log({ tenantId, inserted: missing.length }, 'measurement attributes seeded');
    return true;
  }

  private async ensurePostingProfile(
    tx: DrizzleTx,
    tenantId: string,
    actorUserId: string | null,
    now: Date,
  ): Promise<boolean> {
    const [existing] = await tx
      .select({ id: branchPostingProfiles.id, mapping: branchPostingProfiles.mapping })
      .from(branchPostingProfiles)
      .where(
        and(
          eq(branchPostingProfiles.tenantId, tenantId),
          isNull(branchPostingProfiles.branchId),
          eq(branchPostingProfiles.docType, '*'),
        ),
      )
      .limit(1);
    const codes = [...new Set(Object.values(DEMO_POSTING_PROFILE))];
    const rows = await tx
      .select({ id: accounts.id, code: accounts.code })
      .from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), isNull(accounts.deletedAt), inArray(accounts.code, codes)));
    const byCode = new Map(rows.map((row) => [row.code.trim(), row.id]));
    const mapping: Record<string, string | number> = { version: 1 };
    for (const [key, code] of Object.entries(DEMO_POSTING_PROFILE)) {
      const accountId = byCode.get(code);
      if (accountId) mapping[key] = accountId;
    }

    /**
     * The same reasoning as the chart: when a later phase adds a key
     * (`stockInTransitAccountId` …) an already-provisioned tenant would never see it.
     * Keys the accountant has *cleared* stay cleared — we only fill ones that are
     * absent, never overwrite ones she changed.
     */
    if (existing) {
      const current = (existing.mapping ?? {}) as Record<string, unknown>;
      const missing = Object.entries(mapping).filter(
        ([key, value]) => key !== 'version' && typeof value === 'string' && !(key in current),
      );
      if (!missing.length) return false;
      const nextMapping: Record<string, unknown> = {
        ...current,
        ...Object.fromEntries(missing),
        version: Number(current.version ?? 1) + 1,
      };
      await tx
        .update(branchPostingProfiles)
        .set({ mapping: nextMapping, updatedAt: now, updatedBy: actorUserId })
        .where(eq(branchPostingProfiles.id, existing.id));
      this.logger.log({ tenantId, added: missing.map(([key]) => key) }, 'tenant posting profile completed');
      return true;
    }

    await tx.insert(branchPostingProfiles).values({
      id: newId(),
      tenantId,
      branchId: null,
      docType: '*',
      mapping,
      createdAt: now,
      createdBy: actorUserId,
    });
    this.logger.log({ tenantId, keys: Object.keys(mapping).length - 1 }, 'tenant posting profile seeded');
    return true;
  }

  /**
   * The tenant record already names a base currency (PHASE_01 `tenants.base_currency`);
   * provisioning turns that string into an actual `currencies` row so FX and price lists
   * have something to reference.
   */
  private async ensureBaseCurrency(
    tx: DrizzleTx,
    tenantId: string,
    actorUserId: string | null,
    now: Date,
  ): Promise<string> {
    const [existingBase] = await tx
      .select({ code: currencies.code })
      .from(currencies)
      .where(and(eq(currencies.tenantId, tenantId), eq(currencies.isBase, true)))
      .limit(1);
    if (existingBase) return existingBase.code.trim();

    const [tenantRow] = await tx
      .select({ baseCurrency: tenants.baseCurrency })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const code = (tenantRow?.baseCurrency ?? 'SAR').trim().toUpperCase();

    await tx
      .insert(currencies)
      .values({
        tenantId,
        code,
        nameAr: code,
        nameEn: code,
        minorUnits: code === 'KWD' || code === 'BHD' || code === 'OMR' ? 3 : 2,
        isBase: true,
        isActive: true,
        createdAt: now,
        createdBy: actorUserId,
      })
      .onConflictDoNothing();

    // A tenant may already have the currency enabled without it being base.
    await tx
      .update(currencies)
      .set({ isBase: true })
      .where(and(eq(currencies.tenantId, tenantId), eq(currencies.code, code)));

    return code;
  }
}

async function firstId(query: PromiseLike<Array<{ id: string }>>): Promise<string | undefined> {
  const rows = await query;
  return rows[0]?.id;
}
