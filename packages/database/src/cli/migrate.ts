import { runMigrations } from '../index.js';

/** `pnpm db:migrate` — applies every pending migration in filename order. */
async function main(): Promise<void> {
  const outcome = await runMigrations(undefined, { log: (message) => console.log(message) });
  console.log(`migrations applied: ${outcome.applied.length}, skipped: ${outcome.skipped.length}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
