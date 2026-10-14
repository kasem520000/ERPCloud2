#!/usr/bin/env node
/** PHASE_10 smoke check. A live warehouse is not required. */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let checks = 0;

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}
function check(label, condition, detail = '') {
  checks += 1;
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('■ wms and manufacturing verification');
const migration = read('packages/database/migrations/0106_wms_bom.sql');
check(
  'migration creates bins, balances, boms and manufacturing orders',
  /warehouse_bins/.test(migration) && /bin_balances/.test(migration) && /CREATE TABLE IF NOT EXISTS boms/.test(migration) && /manufacturing_orders/.test(migration) && /manufacturing_moves/.test(migration),
);
check(
  'migration forces RLS and does not alter warehouse stock or old production orders',
  /FORCE ROW LEVEL SECURITY/.test(migration) && !/ALTER TABLE stock_balances/.test(migration) && !/ALTER TABLE production_orders/.test(migration),
);
check(
  'migration registers bin and manufacturing permissions',
  /inventory\.bins\.manage/.test(migration) && /manufacturing\.view/.test(migration) && /manufacturing\.produce/.test(migration),
);
check('down migration drops the phase tables', /DROP TABLE IF EXISTS warehouse_bins/.test(read('packages/database/migrations/down/0106_wms_bom.down.sql')));
const wms = read('apps/api/src/modules/inventory/wms.controller.ts');
const manufacturing = read('apps/api/src/modules/inventory/manufacturing.controller.ts');
check(
  'API exposes bins, transfers, boms and produce',
  /@Post\('bins'\)/.test(wms) && /bin-transfers/.test(wms) && /@Post\('boms'\)/.test(manufacturing) && /orders\/:id\/produce/.test(manufacturing),
);
const service = read('apps/api/src/modules/inventory/wms-bom.service.ts');
check(
  'stock posts stay tenant-scoped and use the moving-average engine',
  /tenant_id = \$\{tenantId\}::uuid/.test(service) && /recordInTx/.test(service) && /manufacturing_order/.test(service),
);
check(
  'staff screens exist',
  existsSync(join(root, 'apps/staff/app/inventory/bins/page.tsx')) &&
    existsSync(join(root, 'apps/staff/app/inventory/bin-balances/page.tsx')) &&
    existsSync(join(root, 'apps/staff/app/manufacturing/boms/page.tsx')) &&
    existsSync(join(root, 'apps/staff/app/manufacturing/orders/page.tsx')),
);
const spec = read('apps/api/src/modules/inventory/wms-bom.spec.ts');
check('mock spec declares 10 cases', (spec.match(/^\s*it\(/gm) ?? []).length === 10);
const unit = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.unit.config.ts', 'src/modules/inventory/wms-bom.spec.ts'], {
  cwd: join(root, 'apps/api'),
  encoding: 'utf8',
  timeout: 120_000,
});
check('mock suite passes', unit.status === 0, (unit.stdout || unit.stderr || '').split('\n').slice(-8).join(' | '));
if (unit.status !== 0) console.log(unit.stdout || unit.stderr);

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
