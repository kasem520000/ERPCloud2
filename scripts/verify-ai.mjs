#!/usr/bin/env node
/**
 * PHASE_08 smoke check. Twelve contract points are verified from the workspace, then the
 * mock suite is executed. A live model and database are not required.
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

console.log('■ accounting assistant verification');
const migration = read('packages/database/migrations/0104_ai_assistant.sql');
check(
  'migration creates conversations, settings, usage and suggestions',
  /ai_conversations/.test(migration) && /ai_settings/.test(migration) && /ai_usage_logs/.test(migration) && /ai_suggestions/.test(migration),
);
check(
  'migration enables and forces RLS and hides the platform key from tenants',
  /ENABLE ROW LEVEL SECURITY/.test(migration) && /FORCE ROW LEVEL SECURITY/.test(migration) && /ai_conversations_tenant_isolation/.test(migration) && /platform_admin_plane ON ai_platform_settings/.test(migration),
);
check('migration registers the two permissions', /ai\.assistant\.use/.test(migration) && /ai\.settings\.manage/.test(migration));
check('down migration drops the phase tables', /DROP TABLE IF EXISTS ai_conversations/.test(read('packages/database/migrations/down/0104_ai_assistant.down.sql')));
const controller = read('apps/api/src/modules/ai/ai.controller.ts');
check(
  'API exposes chat, conversations, suggest and skills',
  /@Post\('chat'\)/.test(controller) && /@Get\('conversations'\)/.test(controller) && /@Post\('suggest'\)/.test(controller) && /@Get\('skills'\)/.test(controller),
);
check('chat requires ai.assistant.use and can stream', /ai\.assistant\.use/.test(controller) && /text\/event-stream/.test(controller));
check('settings write requires ai.settings.manage', /ai\.settings\.manage/.test(controller) && /@Put\('settings'\)/.test(controller));
const engine = read('apps/api/src/modules/ai/ai-engine.ts');
check('engine refuses automatic journal posting', /wantsAutomaticPosting/.test(engine) && /لا أُنشئ قيوداً/.test(engine));
const facts = read('apps/api/src/modules/ai/ai.service.ts');
check(
  'fact queries stay tenant-scoped and avoid identity columns',
  /tenant_id = \$\{tenantId\}::uuid/.test(facts) && /sales_invoices/.test(facts) && /stock_balances/.test(facts) && !/national_id/.test(facts) && !/employees/.test(facts),
);
check(
  'staff screens and floating button exist',
  existsSync(join(root, 'apps/staff/app/assistant/page.tsx')) &&
    existsSync(join(root, 'apps/staff/app/settings/ai/page.tsx')) &&
    /AssistantLauncher/.test(read('apps/staff/components/app-shell.tsx')),
);
const help = read('apps/api/src/modules/ai/ai-help.ts');
check(
  'help corpus links the sales invoice screen and indexes navigation plus the system guide',
  /\/sales\/invoices\/new/.test(help) &&
    /REPORT_DEFINITIONS/.test(help) &&
    /navigationArticlesFromSource/.test(help) &&
    /NAVIGATION_SNAPSHOT/.test(help) &&
    /SYSTEM_GUIDE/.test(help) &&
    /apps\/staff\/lib\/navigation\.ts/.test(read('apps/api/src/modules/ai/navigation-snapshot.ts')),
);
const spec = read('apps/api/src/modules/ai/ai-assistant.spec.ts');
check('mock spec declares 8 cases', (spec.match(/^\s*it\(/gm) ?? []).length === 8);
const unit = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.unit.config.ts', 'src/modules/ai/ai-assistant.spec.ts'], {
  cwd: join(root, 'apps/api'),
  encoding: 'utf8',
  timeout: 120_000,
});
check('mock suite passes', unit.status === 0, (unit.stdout || unit.stderr || '').split('\n').slice(-8).join(' | '));
if (unit.status !== 0) console.log(unit.stdout || unit.stderr);

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
