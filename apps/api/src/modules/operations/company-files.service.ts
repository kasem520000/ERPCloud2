import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DomainError, errorCodes, newId } from '@erp/contracts';
import { companyFiles, withTenantTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { OrgProvisioningService } from '../organization/provisioning/org-provisioning.service.js';
import { PlatformAdminService } from '../platform/admin/platform-admin.service.js';
import { getAuthContext } from '../platform/context/tenant-context.js';

/**
 * Master data that can be carried into a new company file, in dependency order.
 *
 * `selfParent` marks a table whose rows point at their own siblings, so they are inserted
 * parents-first. Everything else is copied in list order and any uuid that was not itself
 * copied is nulled — a reference into the old file would be worse than no reference.
 */
const COPY_SETS = {
  structure: [
    { table: 'branches' },
    { table: 'warehouses' },
  ],
  accounts: [
    { table: 'accounts', selfParent: 'parent_id' },
    { table: 'cost_centers', selfParent: 'parent_id' },
  ],
  catalog: [
    { table: 'units_of_measure' },
    { table: 'item_categories', selfParent: 'parent_id' },
    { table: 'tax_groups' },
    { table: 'items' },
  ],
  parties: [
    { table: 'parties' },
  ],
} as const satisfies Record<string, ReadonlyArray<{ table: string; selfParent?: string }>>;

export type CopySet = keyof typeof COPY_SETS;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asJsonParam = (value: unknown) => (value !== null && typeof value === 'object' ? JSON.stringify(value) : value);

/**
 * إنشاء ملف — start a second company file for the same operator.
 *
 * In the desktop product this created another database on the same machine. The cloud
 * equivalent is another **tenant**, which is exactly what the isolation model already
 * gives us: the new file shares nothing with the old one but the person who owns both,
 * who lands in it through the ordinary tenant picker.
 *
 * Two rules keep this from being a hole in the platform plane. The new file is provisioned
 * **unlicensed** with a pending activation request (see `provisionCompanyFile`), and the
 * copy step carries master data only — charts of accounts, catalogs, parties — never
 * documents, balances or users. A new file starts empty by definition; if it started with
 * last year's ledger it would not be a new file.
 */
@Injectable()
export class CompanyFilesService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly admin: PlatformAdminService,
    private readonly provisioning: OrgProvisioningService,
  ) {}

  async list(tenantId: string) {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(companyFiles).where(eq(companyFiles.tenantId, tenantId)).orderBy(desc(companyFiles.createdAt)).limit(100));
  }

  async create(tenantId: string, input: { code: string; name: string; baseCurrency?: string; timezone?: string; countryCode?: string; copy?: CopySet[] }) {
    const auth = getAuthContext();
    const code = (input.code ?? '').trim().toLowerCase();
    const name = (input.name ?? '').trim();
    if (name.length < 2) throw new DomainError(errorCodes.VALIDATION_FAILED, 'The new file needs a name', 422);

    const [owner] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.execute(sql`SELECT email, full_name FROM users WHERE id = ${auth.userId}`).then((result) => result.rows as Array<{ email: string; full_name: string }>));
    if (!owner) throw new DomainError(errorCodes.NOT_FOUND, 'Current user was not found', 404);

    const [source] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.execute(sql`SELECT base_currency, timezone, country_code FROM tenants WHERE id = ${tenantId}`).then((result) => result.rows as Array<{ base_currency: string; timezone: string; country_code: string }>));

    const created = await this.admin.provisionCompanyFile({
      code,
      name,
      baseCurrency: input.baseCurrency ?? source?.base_currency ?? 'SAR',
      timezone: input.timezone ?? source?.timezone ?? 'Asia/Riyadh',
      countryCode: input.countryCode ?? source?.country_code ?? 'SA',
      ownerEmail: owner.email,
      ownerFullName: owner.full_name,
    });

    const sets = (input.copy ?? []).filter((set): set is CopySet => set in COPY_SETS);
    const copied = sets.length
      ? await this.copyMasters(tenantId, created.tenantId, sets)
      : await this.provisioning.provisionOrgDefaults(created.tenantId, { actorUserId: created.ownerUserId }).then(() => ({}));

    // A copied structure already carries branches/warehouses; anything else still needs the
    // baseline so the new file is usable on first login.
    if (sets.length && !sets.includes('structure')) {
      await this.provisioning.provisionOrgDefaults(created.tenantId, { actorUserId: created.ownerUserId });
    }

    const id = newId();
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await tx.insert(companyFiles).values({
        id, tenantId, newTenantId: created.tenantId, code: created.tenantCode, name,
        status: 'created', copied, createdBy: auth.userId,
      });
      const [row] = await tx.select().from(companyFiles).where(and(eq(companyFiles.tenantId, tenantId), eq(companyFiles.id, id)));
      return { ...row, subscriptionStatus: created.subscriptionStatus, activationRequestId: created.activationRequestId };
    });
  }

  /**
   * Copy master rows across tenants, rewriting every id on the way.
   *
   * One map of old id → new id spans all tables: uuids are unique, so a value that appears
   * in the map is by definition a reference to something already copied. A uuid that is not
   * in the map points at a row we chose not to carry, and is nulled rather than left
   * dangling into the source file.
   */
  private async copyMasters(sourceTenantId: string, targetTenantId: string, sets: CopySet[]) {
    const idMap = new Map<string, string>();
    const copied: Record<string, number> = {};
    const tables = sets.flatMap((set) => COPY_SETS[set] as ReadonlyArray<{ table: string; selfParent?: string }>);

    for (const spec of tables) {
      const rows = await withTenantTx(this.database.db, sourceTenantId, async (tx) => {
        const result = await tx.execute(sql`SELECT to_jsonb(t) AS row FROM ${sql.identifier(spec.table)} t`);
        return result.rows.map((row) => (row as { row: Record<string, unknown> }).row);
      });
      if (!rows.length) continue;

      for (const row of rows) idMap.set(String(row.id), newId());
      const ordered = spec.selfParent ? orderByParent(rows, spec.selfParent) : rows;

      await withTenantTx(this.database.db, targetTenantId, async (tx) => {
        for (const row of ordered) {
          const columns = Object.keys(row);
          const values = columns.map((column) => {
            const value = row[column];
            if (column === 'tenant_id') return targetTenantId;
            if (column === 'id') return idMap.get(String(value));
            if (column === 'created_by' || column === 'updated_by' || column === 'deleted_by') return null;
            if (typeof value === 'string' && UUID.test(value)) return idMap.get(value) ?? null;
            return asJsonParam(value ?? null);
          });
          await tx.execute(sql`
            INSERT INTO ${sql.identifier(spec.table)} (${sql.join(columns.map((column) => sql.identifier(column)), sql`, `)})
            VALUES (${sql.join(values.map((value) => sql`${value}`), sql`, `)})
            ON CONFLICT DO NOTHING
          `);
        }
      });
      copied[spec.table] = rows.length;
    }

    return copied;
  }
}

/** Parents before children, so a self-referencing FK never looks forward. */
function orderByParent(rows: Array<Record<string, unknown>>, parentColumn: string) {
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const depth = (row: Record<string, unknown>, seen = new Set<string>()): number => {
    const parent = row[parentColumn];
    if (typeof parent !== 'string' || !byId.has(parent) || seen.has(parent)) return 0;
    seen.add(parent);
    return 1 + depth(byId.get(parent)!, seen);
  };
  return [...rows].sort((left, right) => depth(left) - depth(right));
}
