#!/usr/bin/env node
/**
 * PHASE_07 smoke check. Twelve contract points are verified from the workspace, then the
 * mock suite is executed. A live API is not required: WPS/GOSI math and Moyasar signing
 * are covered by `mudad-moyasar.spec.ts`.
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
let failures = 0;

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

console.log('■ mudad / moyasar verification');
const migration = read('packages/database/migrations/0103_mudad_moyasar.sql');
check('migration creates WPS, GOSI and payment tables', /payroll_wps_files/.test(migration) && /payroll_gosi_files/.test(migration) && /payment_links/.test(migration) && /payment_provider_configs/.test(migration));
check('migration enables and forces RLS', /ENABLE ROW LEVEL SECURITY/.test(migration) && /FORCE ROW LEVEL SECURITY/.test(migration) && /payment_links_tenant_isolation/.test(migration));
check('migration registers the two permissions', /payroll\.wps\.export/.test(migration) && /payments\.links\.manage/.test(migration));
check('down migration drops the phase tables', /DROP TABLE IF EXISTS payment_links/.test(read('packages/database/migrations/down/0103_mudad_moyasar.down.sql')));
check('API exposes WPS preview/export and payment webhooks', /wps-preview/.test(read('apps/api/src/modules/hrm/hrm.controller.ts')) && /wps-export/.test(read('apps/api/src/modules/hrm/hrm.controller.ts')) && /payments\/webhooks\/:provider/.test(read('apps/api/src/modules/payments/payment-links.controller.ts')) && /payments\/links/.test(read('apps/api/src/modules/payments/payment-links.controller.ts')));
check('webhook route is public and verifies a shared secret', /@Public\(\)/.test(read('apps/api/src/modules/payments/payment-links.controller.ts')) && /verifySharedSecret/.test(read('apps/api/src/modules/payments/payment-links.service.ts')));
check('paid webhook creates a receipt voucher', /kind: 'receipt'/.test(read('apps/api/src/modules/payments/payment-links.service.ts')) && /addPayment/.test(read('apps/api/src/modules/payments/payment-links.service.ts')));
check('staff screens exist', existsSync(join(root, 'apps/staff/app/hrm/payroll/[id]/wps/page.tsx')) && existsSync(join(root, 'apps/staff/app/hrm/compliance/page.tsx')) && existsSync(join(root, 'apps/staff/app/settings/payments/page.tsx')));
check('customer portal pay page exists', existsSync(join(root, 'apps/customer-portal/app/portal/invoices/[id]/pay/page.tsx')) && /payment-link/.test(read('apps/api/src/modules/portal/portal.controller.ts')));
check('invoice screen can create a payment link', /إنشاء رابط دفع/.test(read('apps/staff/app/sales/invoices/[id]/page.tsx')));
const spec = read('apps/api/src/modules/payments/mudad-moyasar.spec.ts');
check('mock spec declares 8 cases', (spec.match(/^\s*it\(/gm) ?? []).length === 8);
const unit = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.unit.config.ts', 'src/modules/payments/mudad-moyasar.spec.ts'], {
  cwd: join(root, 'apps/api'),
  encoding: 'utf8',
  timeout: 120_000,
});
check('mock suite passes', unit.status === 0, (unit.stdout || unit.stderr || '').split('\n').slice(-8).join(' | '));
if (unit.status !== 0) console.log(unit.stdout || unit.stderr);

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
