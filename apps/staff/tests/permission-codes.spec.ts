import { readFile, readdir } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { canonicalizePermissionCode, isKnownPermissionCode, permissionAliases } from '@erp/contracts';

/**
 * AUD-12 — رموز الصلاحيات في واجهة الموظفين مصدرها سجلّ العقود.
 *
 * كان في `lib/session.tsx` جدول aliases محلي فيه أسماء **لا وجود لها** في السجلّ
 * (`tenant.profile.view`، `tenant.users.view`…)، و`app/page.tsx` يستعمل
 * `sales.invoices.view` بينما الـAPI يطلب `sales.view` — فيُخفى العنصر دائماً.
 *
 * الحارس: كل رمز يمرّ إلى `can()` أو يُعلَن `permission:` يجب أن يكون معروفاً في
 * `@erp/contracts` (كنسيّاً أو قديماً)، وأن يبقى التحقق عبر `canonicalizePermissionCode`.
 */

const ROOT = new URL('..', import.meta.url);

async function collectSources(dir: string): Promise<string[]> {
  const entries = await readdir(new URL(dir, ROOT), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = `${dir}${entry.name}`;
    if (entry.isDirectory()) files.push(...(await collectSources(`${relative}/`)));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.spec.ts')) files.push(relative);
  }
  return files;
}

const known = (code: string) => isKnownPermissionCode(code) || code in permissionAliases;

describe('AUD-12 — رموز الصلاحيات في الواجهة', () => {
  it('لا جدول aliases محلياً — التحقق يمرّ بـcanonicalizePermissionCode', async () => {
    const source = await readFile(new URL('lib/session.tsx', ROOT), 'utf8');
    expect(source).not.toContain('PERMISSION_ALIASES');
    expect(source).toContain('canonicalizePermissionCode');
  });

  it('كل رمز يُفحص في الواجهة موجودٌ في السجلّ', async () => {
    const files = [...(await collectSources('app/')), ...(await collectSources('lib/')), ...(await collectSources('components/'))];
    const offenders: Array<{ file: string; code: string }> = [];
    // رموز الصلاحيات وحدها: نقطة تفصل النطاق عن الإجراء، وبلا مسافات — كي لا يخلط
    // الفحص حقولاً محلية سمّاها الكود `permission` لمعنى آخر (زرّ `preview` مثلاً).
    const looksLikePermissionCode = (code: string) => /^[a-z][a-z0-9_]*(\.[a-z0-9_*]+)+$/.test(code);
    for (const file of files) {
      const text = await readFile(new URL(file, ROOT), 'utf8');
      for (const match of text.matchAll(/can\(\s*'([^']+)'/g)) {
        const code = match[1]!;
        if (looksLikePermissionCode(code) && !known(code)) offenders.push({ file, code });
      }
      for (const match of text.matchAll(/permission:\s*'([^']+)'/g)) {
        const code = match[1]!;
        if (looksLikePermissionCode(code) && !known(code)) offenders.push({ file, code });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('sales.invoices.view لم يبق — الـAPI يطلب sales.view', async () => {
    const page = await readFile(new URL('app/page.tsx', ROOT), 'utf8');
    expect(page).not.toContain('sales.invoices.view');
    expect(page).toContain("can('sales.view')");
  });

  it('الكنسي والقديم يحلّان إلى الشيء نفسه', () => {
    expect(canonicalizePermissionCode('platform.tenant.view')).toBe('tenant.view');
    expect(canonicalizePermissionCode('tenant.view')).toBe('tenant.view');
    // الرمز المخترع سابقاً ليس صلاحيةً — لا يُضاف إلى السجلّ ليُرضي الواجهة.
    expect(isKnownPermissionCode('tenant.profile.view')).toBe(false);
  });
});
