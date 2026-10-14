import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration (PHASE_02 §5.5).
 *
 * `pnpm db:generate` produces *draft* SQL from the Drizzle schema for review. The
 * applied migrations in `packages/database/migrations` are hand-written and idempotent
 * (AI_DEVELOPMENT_PROTOCOL §5: "Migrations: pnpm db:generate then review SQL before
 * applying"), so generated files land in `migrations/generated/` and are folded into a
 * numbered, reviewed migration by the author.
 */
export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations/generated',
  dialect: 'postgresql',
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_MIGRATOR_URL ?? process.env.DATABASE_URL ?? '',
  },
});
