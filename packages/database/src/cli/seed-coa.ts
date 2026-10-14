import { Client } from 'pg';
import { env } from '@erp/config';

import { seedDefaultChartOfAccounts } from '../index.js';

/**
 * `pnpm db:seed:coa` — backfills the desktop default chart of accounts for tenants
 * that were created before provisioning seeded it automatically.
 *
 * Safety rule: only tenants with ZERO live accounts are touched. A tenant that
 * already has a (possibly hand-built or synthetic) chart is reported as skipped —
 * merging the desktop leaves under foreign roots would corrupt both charts, so that
 * case stays a deliberate, accountant-supervised migration, not a script.
 */
async function main(): Promise<void> {
  const client = new Client({
    connectionString: env.DATABASE_MIGRATOR_URL ?? env.DATABASE_URL,
  });
  await client.connect();
  try {
    const tenants = await client.query<{ id: string; code: string }>(
      `SELECT id, code FROM tenants ORDER BY code`,
    );
    let seeded = 0;
    let skipped = 0;
    for (const tenant of tenants.rows) {
      const existing = await client.query(`SELECT 1 FROM accounts WHERE tenant_id = $1 AND deleted_at IS NULL LIMIT 1`, [
        tenant.id,
      ]);
      if ((existing.rowCount ?? 0) > 0) {
        console.log(`skip  ${tenant.code}: already has a chart of accounts`);
        skipped += 1;
        continue;
      }
      await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenant.id]);
      const chart = await seedDefaultChartOfAccounts(client, tenant.id);
      console.log(`seed  ${tenant.code}: ${chart.inserted} accounts`);
      seeded += 1;
    }
    console.log(`done: ${seeded} seeded, ${skipped} skipped`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
