import { readFile, readdir } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { canonicalizePermissionCode, isKnownPermissionCode } from '@erp/contracts';

/**
 * AUD-12 — لوحة المنصة تشترك مع واجهة الموظفين في خطأ الجدول المحلي نفسه:
 * خرائط aliases فيه أسماء لا وجود لها (`tenant.profile.view`…). التحقق هنا يمرّ
 * بمُحلّل العقود، وكل رمز يُفحص في اللوحة يجب أن يكون معروفاً (كنسيّاً أو قديمَ الاسم).
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

describe('AUD-12 — رموز الصلاحيات في لوحة المنصة', () => {
  it('لا جدول aliases محلياً — التحقق يمرّ بـcanonicalizePermissionCode', async () => {
    const source = await readFile(new URL('lib/session.tsx', ROOT), 'utf8');
    expect(source).not.toContain('PERMISSION_ALIASES');
    expect(source).toContain('canonicalizePermissionCode');
  });

  it('كل رمز يُفحص في اللوحة موجودٌ في السجلّ', async () => {
    const files = [...(await collectSources('app/')), ...(await collectSources('lib/')), ...(await collectSources('components/'))];
    const offenders: Array<{ file: string; code: string }> = [];
    const looksLikePermissionCode = (code: string) => /^[a-z][a-z0-9_]*(\.[a-z0-9_*]+)+$/.test(code);
    for (const file of files) {
      const text = await readFile(new URL(file, ROOT), 'utf8');
      for (const match of text.matchAll(/can(?:Console)?\(\s*'([^']+)'/g)) {
        const code = match[1]!;
        if (looksLikePermissionCode(code) && !isKnownPermissionCode(code)) offenders.push({ file, code });
      }
      for (const match of text.matchAll(/permission:\s*'([^']+)'/g)) {
        const code = match[1]!;
        if (looksLikePermissionCode(code) && !isKnownPermissionCode(code)) offenders.push({ file, code });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('الرموز القديمة تُطبَّع إلى الكنسية في الطبقتين', () => {
    expect(canonicalizePermissionCode('platform.tenant.view')).toBe('tenant.view');
    expect(isKnownPermissionCode('tenant.profile.view')).toBe(false);
  });
});
