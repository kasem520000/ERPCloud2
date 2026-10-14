import { configureDatabaseRoles } from '../index.js';

/**
 * `pnpm db:roles` — grants LOGIN to `erp_api` / `erp_migrator` and sets their
 * passwords from the environment. Credentials never appear in migration SQL
 * (PROJECT_CONTRACT §10). `erp_api` is pinned to NOBYPASSRLS here as well as in the
 * migration, so a re-run can never accidentally grant it an RLS bypass
 * (PROJECT_CONTRACT §13.4).
 */
async function main(): Promise<void> {
  const appPassword = process.env.DATABASE_APP_PASSWORD;
  const migratorPassword = process.env.DATABASE_MIGRATOR_PASSWORD;

  if (!appPassword && !migratorPassword) {
    console.error('Set DATABASE_APP_PASSWORD and/or DATABASE_MIGRATOR_PASSWORD to configure the roles.');
    process.exitCode = 1;
    return;
  }

  const touched = await configureDatabaseRoles(undefined, {
    appPassword,
    migratorPassword,
    log: (message) => console.log(message),
  });
  console.log(`roles configured: ${touched.join(', ') || 'none'}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
