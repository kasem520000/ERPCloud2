#!/usr/bin/env node
/** PHASE_09 smoke check. Live GPS and a push provider are not required. */
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

console.log('■ employee mobile verification');
const migration = read('packages/database/migrations/0105_employee_mobile.sql');
check('migration creates attendance, requests, geofence and push tables', /employee_attendance/.test(migration) && /employee_requests/.test(migration) && /employee_geofences/.test(migration) && /employee_push_subscriptions/.test(migration));
check('migration forces RLS and does not alter fingerprint attendance', /FORCE ROW LEVEL SECURITY/.test(migration) && !/ALTER TABLE attendance_logs/.test(migration));
check('migration registers the three permissions', /employee\.self\.view/.test(migration) && /employee\.self\.manage/.test(migration) && /employee\.team\.approve/.test(migration));
check('down migration drops the phase tables', /DROP TABLE IF EXISTS employee_attendance/.test(read('packages/database/migrations/down/0105_employee_mobile.down.sql')));
const controller = read('apps/api/src/modules/employee/employee.controller.ts');
check('API exposes punch, sync, requests, payslips and push', /@Post\('attendance'\)/.test(controller) && /attendance\/sync/.test(controller) && /@Post\('requests'\)/.test(controller) && /payslips/.test(controller) && /push-subscription/.test(controller));
const service = read('apps/api/src/modules/employee/employee.service.ts');
check('fact queries stay tenant-scoped and omit identity columns', /tenant_id = \$\{tenantId\}::uuid/.test(service) && !/national_id/.test(service) && !/iban/.test(service));
check('staff PWA screens exist', existsSync(join(root, 'apps/staff/app/m/attendance/page.tsx')) && existsSync(join(root, 'apps/staff/app/m/approvals/page.tsx')) && existsSync(join(root, 'apps/staff/app/hrm/leaves/page.tsx')));
check('service worker caches the employee app and shows push', /\/m\/attendance/.test(read('apps/staff/public/sw.js')) && /showNotification/.test(read('apps/staff/public/sw.js')));
const spec = read('apps/api/src/modules/employee/employee-mobile.spec.ts');
check('mock spec declares 10 cases', (spec.match(/^\s*it\(/gm) ?? []).length === 10);
const unit = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.unit.config.ts', 'src/modules/employee/employee-mobile.spec.ts'], {
  cwd: join(root, 'apps/api'),
  encoding: 'utf8',
  timeout: 120_000,
});
check('mock suite passes', unit.status === 0, (unit.stdout || unit.stderr || '').split('\n').slice(-8).join(' | '));
if (unit.status !== 0) console.log(unit.stdout || unit.stderr);

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
