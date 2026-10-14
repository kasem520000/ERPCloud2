import { runMigrationsDown } from '../index.js';

/** `pnpm db:migrate:down [steps]` — reverts the most recently applied migrations. */
async function main(): Promise<void> {
  const steps = Number.parseInt(process.argv[2] ?? '1', 10);
  const outcome = await runMigrationsDown(undefined, {
    steps: Number.isFinite(steps) && steps > 0 ? steps : 1,
    log: (message) => console.log(message),
  });
  console.log(`migrations reverted: ${outcome.applied.join(', ') || 'none'}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
