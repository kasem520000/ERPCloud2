import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * حارس انحراف مستند OpenAPI (R-21) — يصدّر المستند إلى ملفٍّ مؤقت ويقارنه
 * بالنسخة المتعقَّبة (`packages/contracts/openapi.json`). إن اختلفا فالبوابة حمراء:
 * مستندٌ متقادم لا يعبر بعد الآن بصمت لأن CI يعيد توليده ولا يقارن.
 *
 * التشغيل من جذر المستودع بعد بناء الـAPI:
 *   pnpm openapi:check
 * الإصلاح عند الفشل:
 *   pnpm openapi:export && git add packages/contracts/openapi.json
 */
const root = process.cwd();
const committed = path.join(root, 'packages', 'contracts', 'openapi.json');
const tempDir = mkdtempSync(path.join(tmpdir(), 'openapi-drift-check-'));
const generated = path.join(tempDir, 'openapi.json');

try {
  execFileSync(process.execPath, ['apps/api/dist/openapi/export-openapi-cli.js', generated], {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  const before = readFileSync(committed, 'utf8');
  const after = readFileSync(generated, 'utf8');
  if (before === after) {
    console.log('openapi:check passed — packages/contracts/openapi.json matches the exported document');
    process.exit(0);
  }

  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const firstDiff = beforeLines.findIndex((line, index) => line !== afterLines[index]);
  console.error('openapi:check FAILED — the committed document drifted from the exported one.');
  console.error(
    `first difference at line ${firstDiff + 1}: committed ${JSON.stringify(
      beforeLines[firstDiff],
    )} vs exported ${JSON.stringify(afterLines[firstDiff])} (${beforeLines.length} → ${afterLines.length} lines)`,
  );
  console.error('Fix: pnpm openapi:export && git add packages/contracts/openapi.json');
  process.exit(1);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
