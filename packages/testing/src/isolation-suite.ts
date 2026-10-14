import { expect } from 'vitest';
import { Client, type ClientBase } from 'pg';
import { TENANT_GUC, rlsProtectedTables } from '@erp/database';

/**
 * Tenant isolation harness — TESTING_STRATEGY §6 (canon, implemented in P03).
 *
 * `expectIsolation(http, { a, b }, probe, db)` runs the four mandatory proofs for any
 * tenant-scoped resource:
 *
 *  1. Tenant A cannot READ tenant B's row by id (404), nor see it in a list/search.
 *  2. Tenant A cannot WRITE tenant B's row (404/422) nor create a row carrying a
 *     foreign reference (404/422).
 *  3. RLS layer: a raw SQL query on the API role without the GUC returns zero rows,
 *     and with tenant A's GUC returns only A's rows (while B's rows demonstrably exist).
 *  4. Export/report endpoints obey the same isolation — pass `probe.exportRowIds` when
 *     the resource exposes one; the harness skips the proof (and says so) when it does not.
 *
 * The JWT negative cases (forged `tid`, suspended tenant) are exported separately so
 * phases without those flows are not forced to fake them.
 */

export type TenantActor = {
  label: string;
  tenantId: string;
  /** Access token bound to this actor's membership. */
  token: string;
};

export type IsolationHttpResponse = {
  status: number;
  body: unknown;
};

export type IsolationHttp = {
  get(actor: TenantActor, path: string): Promise<IsolationHttpResponse>;
  post(actor: TenantActor, path: string, body: unknown): Promise<IsolationHttpResponse>;
  patch(actor: TenantActor, path: string, body: unknown): Promise<IsolationHttpResponse>;
  put(actor: TenantActor, path: string, body: unknown): Promise<IsolationHttpResponse>;
  remove(actor: TenantActor, path: string): Promise<IsolationHttpResponse>;
};

export type IsolationProbe = {
  /** Resource name, used in assertion messages. */
  resource: string;
  /** Table the resource persists into — used by the RLS probe. */
  tableName: string;
  /** Creates a row owned by `actor`'s tenant and returns its id. */
  createRow(actor: TenantActor): Promise<string>;
  /** Reads a row by id, returning the HTTP status. */
  readById(actor: TenantActor, rowId: string): Promise<number>;
  /** Returns every row id visible to `actor` through the list/search endpoint. */
  listRowIds(actor: TenantActor): Promise<string[]>;
  /** Optional: writes to a row owned by the other tenant. */
  writeForeignRow?(actor: TenantActor, rowId: string): Promise<number>;
  /** Optional: creates a row that references a record owned by the other tenant. */
  createWithForeignReference?(actor: TenantActor, foreignRowId: string): Promise<number>;
  /** Optional: the export/report surface for the resource (proof 4). */
  exportRowIds?(actor: TenantActor): Promise<string[]>;
  /** Optional: raw-SQL cross-tenant write attempt; must be rejected by the RLS policy. */
  attemptForeignInsert?(client: ClientBase, foreignTenantId: string): Promise<void>;
};

export type IsolationDatabase = {
  /** `erp_api` (NOBYPASSRLS) connection string. */
  appUrl: string;
  /** `erp_migrator` (BYPASSRLS) connection string — used only to prove rows exist. */
  migratorUrl: string;
};

export type IsolationResult = {
  resource: string;
  readBlocked: boolean;
  listBlocked: boolean;
  writeBlocked: boolean;
  rlsBlocked: boolean;
  exportChecked: boolean;
};

const NOT_VISIBLE = [404, 422];

export async function expectIsolation(
  http: IsolationHttp,
  actors: { a: TenantActor; b: TenantActor },
  probe: IsolationProbe,
  db: IsolationDatabase,
): Promise<IsolationResult> {
  const { a, b } = actors;

  const rowA = await probe.createRow(a);
  const rowB = await probe.createRow(b);
  expect(rowA, `${probe.resource}: tenant A row was created`).toBeTruthy();
  expect(rowB, `${probe.resource}: tenant B row was created`).toBeTruthy();

  // --- proof 1: read by id / list / search --------------------------------------
  const readStatus = await probe.readById(a, rowB);
  expect(readStatus, `${probe.resource}: A reading B's row by id must be 404`).toBe(404);

  const ownRead = await probe.readById(a, rowA);
  expect(ownRead, `${probe.resource}: A must still read its own row`).toBe(200);

  const visibleToA = await probe.listRowIds(a);
  expect(visibleToA, `${probe.resource}: A's list must contain its own row`).toContain(rowA);
  expect(visibleToA, `${probe.resource}: A's list must not contain B's row`).not.toContain(rowB);

  // --- proof 2: write / foreign reference ---------------------------------------
  let writeBlocked = false;
  if (probe.writeForeignRow) {
    const status = await probe.writeForeignRow(a, rowB);
    expect(
      NOT_VISIBLE.includes(status),
      `${probe.resource}: A writing B's row must be 404/422, got ${status}`,
    ).toBe(true);
    writeBlocked = true;
  }
  if (probe.createWithForeignReference) {
    const status = await probe.createWithForeignReference(a, rowB);
    expect(
      NOT_VISIBLE.includes(status),
      `${probe.resource}: A creating a row with B's reference must be 404/422, got ${status}`,
    ).toBe(true);
    writeBlocked = true;
  }

  // --- proof 3: RLS -------------------------------------------------------------
  const rls = await rlsProbe(db.appUrl, probe.tableName, a.tenantId);
  const rowCount = await countRows(db.migratorUrl, probe.tableName);

  expect(rls.visibleWithoutGuc, `${probe.resource}: RLS must hide everything without the GUC`).toBe(0);
  expect(rls.visibleWithGuc, `${probe.resource}: RLS must expose tenant A's rows`).toBeGreaterThan(0);
  expect(
    rls.visibleWithGuc,
    `${probe.resource}: RLS must hide tenant B's rows (${rowCount} rows exist, ${rls.visibleWithGuc} visible)`,
  ).toBeLessThan(rowCount);

  if (probe.attemptForeignInsert) {
    const client = new Client({ connectionString: db.appUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config($1, $2, true)`, [TENANT_GUC, a.tenantId]);
      let rejected = false;
      try {
        await probe.attemptForeignInsert(client, b.tenantId);
      } catch (error) {
        rejected = (error as { code?: string }).code === '42501';
      }
      await client.query('ROLLBACK');
      expect(rejected, `${probe.resource}: RLS must reject a cross-tenant INSERT (42501)`).toBe(true);
    } finally {
      await client.end();
    }
  }

  // --- proof 4: export/report surface -------------------------------------------
  let exportChecked = false;
  if (probe.exportRowIds) {
    const exported = await probe.exportRowIds(a);
    expect(exported, `${probe.resource}: export must contain A's row`).toContain(rowA);
    expect(exported, `${probe.resource}: export must not contain B's row`).not.toContain(rowB);
    exportChecked = true;
  }

  return {
    resource: probe.resource,
    readBlocked: true,
    listBlocked: true,
    writeBlocked,
    rlsBlocked: true,
    exportChecked,
  };
}

/**
 * The tenant-scoped tables that currently carry an RLS policy. Later phases extend
 * `rlsProtectedTables` in `@erp/database` and this list follows automatically.
 */
export function rlsProtectedTablesProbe(): readonly string[] {
  return rlsProtectedTables;
}

export type RlsProbeResult = {
  visibleWithoutGuc: number;
  visibleWithGuc: number;
};

/** Direct-SQL RLS probe on the API role (TESTING_STRATEGY §6, proof 3). */
export async function rlsProbe(appUrl: string, tableName: string, tenantId: string): Promise<RlsProbeResult> {
  assertSafeIdentifier(tableName);
  const client = new Client({ connectionString: appUrl });
  await client.connect();
  try {
    const visibleWithoutGuc = await countRowsFromClient(client, tableName);
    await client.query('BEGIN');
    await client.query(`SELECT set_config($1, $2, true)`, [TENANT_GUC, tenantId]);
    const visibleWithGuc = await countRowsFromClient(client, tableName);
    await client.query('ROLLBACK');
    return { visibleWithoutGuc, visibleWithGuc };
  } finally {
    await client.end();
  }
}

async function countRows(connectionString: string, tableName: string): Promise<number> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await countRowsFromClient(client, tableName);
  } finally {
    await client.end();
  }
}

async function countRowsFromClient(client: ClientBase, tableName: string): Promise<number> {
  assertSafeIdentifier(tableName);
  const result = await client.query(`SELECT count(*)::int AS total_rows FROM ${tableName}`);
  const rows = result.rows as Array<{ total_rows: number }>;
  return rows[0]?.total_rows ?? 0;
}

function assertSafeIdentifier(tableName: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(tableName)) {
    throw new Error(`Refusing to interpolate '${tableName}' into SQL: not a safe identifier.`);
  }
}

/**
 * Negative JWT case (TESTING_STRATEGY §6): a token whose `tid` claim names a tenant the
 * user is not a member of must be rejected — MULTI_TENANCY §4 "hard-block".
 */
export async function expectForgedTenantClaimRejected(
  http: IsolationHttp,
  actor: TenantActor,
  path: string,
): Promise<number> {
  const response = await http.get(actor, path);
  expect(
    [401, 403].includes(response.status),
    `forged tid claim must be rejected (401/403), got ${response.status}`,
  ).toBe(true);
  return response.status;
}

/**
 * Negative tenant case (TESTING_STRATEGY §6): a suspended tenant is rejected with the
 * stable `TENANT_SUSPENDED` code, never with a silent 404.
 */
export async function expectSuspendedTenantRejected(
  http: IsolationHttp,
  actor: TenantActor,
  path: string,
): Promise<IsolationHttpResponse> {
  const response = await http.get(actor, path);
  expect(response.status, `suspended tenant must return 423, got ${response.status}`).toBe(423);
  const body = response.body as { code?: string };
  expect(body.code, 'suspended tenant must use the TENANT_SUSPENDED code').toBe('TENANT_SUSPENDED');
  return response;
}
