import { describe, expect, it } from 'vitest';

import { MigrationEngine } from '../engine.js';
import { registryByDependencyOrder, validateRegistry } from '../registry/maps.js';

const tenantId = '00000000-0000-4000-8000-000000000015';

describe('Phase 15 migration engine', () => {
  it('validates the registry and keeps wave dependency order', () => {
    expect(validateRegistry()).toEqual([]);
    const ordered = registryByDependencyOrder();
    expect(ordered[0]?.wave).toBe('W1');
    expect(ordered.findIndex((map) => map.entity === 'accounts')).toBeLessThan(ordered.findIndex((map) => map.entity === 'journal_entries'));
    expect(ordered.findIndex((map) => map.entity === 'invoice_lines')).toBeLessThan(ordered.findIndex((map) => map.entity === 'inventory_replay'));
  });

  it('analyze mode emits machine-readable RC answers', async () => {
    const engine = new MigrationEngine({ tenantId });
    const run = await engine.start('analyze');
    expect(run.status).toBe('succeeded');
    expect(JSON.stringify(run.summary)).toContain('RC-DOCTYPE');
    expect(JSON.stringify(run.summary)).toContain('RC-POSTED-STATE');
  });

  it('dry-run stages without loading, import is idempotent, and reconcile passes fixture', async () => {
    const engine = new MigrationEngine({ tenantId });
    const dryRun = await engine.start('dry_run');
    expect(dryRun.status).toBe('succeeded');
    expect(engine.countLoaded('invoices')).toBe(0);

    const firstImport = await engine.start('import');
    expect(firstImport.status).toBe('succeeded');
    expect(engine.countLoaded('invoices')).toBe(1);

    const secondImport = await engine.start('import');
    expect(secondImport.status).toBe('succeeded');
    const waves = secondImport.summary.waves as Record<string, { skipped: number }>;
    expect(waves.invoices?.skipped).toBe(1);
    expect(engine.countLoaded('invoices')).toBe(1);

    const reconcile = await engine.start('reconcile');
    expect(reconcile.reconciliation?.checks.every((check) => check.status === 'pass')).toBe(true);
  });

  it('rollback removes rows linked to the selected run', async () => {
    const engine = new MigrationEngine({ tenantId });
    const imported = await engine.start('import');
    expect(engine.countLoaded('vouchers')).toBe(1);
    const rollback = engine.rollback(imported.id);
    expect(rollback.pristine).toBe(true);
    expect(engine.countLoaded('vouchers')).toBe(0);
  });
});
