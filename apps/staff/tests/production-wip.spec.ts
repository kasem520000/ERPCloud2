import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { POSTING_ACCOUNT_LABELS } from '../lib/posting';

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

/**
 * 🏭 M6.2 — مرحلة «تحت التشغيل» على شاشة أمر الإنتاج: المصدر يُثبَّت كما تُثبَّت بقية
 * عقود الواجهات (في الأصل نفسه لا في لقطات DOM):
 *   1. الحالة الجديدة مرئية بالعربية، والمسار ثلاث خطوات (مسودة ← تحت التشغيل ← منفَّذ)؛
 *   2. زر الصرف يظهر للمسودة خلف صلاحية الإكمال — الصرف يحرّك مخزونًا فهو القرينة
 *      المالية نفسها، لا كتابة وصفات؛
 *   3. التنفيذ متاح للمسودة والمصروف معًا (المسار المباشر الموروث والثنائي الجديد)؛
 *   4. الإلغاء للمسودة وحدها — المصروف حرّك مكوّناته ويجب أن يُستكمل؛
 *   5. مفتاح الربط الجديد معروض على المحاسب باسمٍ يقول ما هو.
 */
describe('production WIP screen contract (M6.2)', () => {
  it('labels the in_progress status and walks the three-step track', async () => {
    const code = await source('app/inventory/production/page.tsx');
    expect(code).toContain("in_progress: 'تحت التشغيل'");
    expect(code).toContain("steps={['مسودة', 'تحت التشغيل', 'مُنفَّذ']}");
  });

  it('offers issue behind the complete permission and completion for both paths', async () => {
    const code = await source('app/inventory/production/page.tsx');
    expect(code).toContain("act(row, 'issue')");
    expect(code).toContain("can('inventory.production.complete')");
    // الصرف للمسودة، والتنفيذ للمسودة أو المصروف.
    expect(code).toMatch(/row\.status === 'draft'[^]*act\(row, 'issue'\)/);
    expect(code).toMatch(/\(row\.status === 'draft' \|\| row\.status === 'in_progress'\)[^]*act\(row, 'complete'\)/);
  });

  it('keeps cancel draft-only', async () => {
    const code = await source('app/inventory/production/page.tsx');
    const lines = code.split('\n');
    const cancelLine = lines.findIndex((line) => line.includes("act(row, 'cancel')"));
    expect(cancelLine, 'the cancel action must exist').toBeGreaterThan(-1);
    const condition = lines.slice(Math.max(0, cancelLine - 3), cancelLine).join('\n');
    expect(condition).toContain("row.status === 'draft'");
    expect(condition).not.toContain('in_progress');
  });

  it('exposes the WIP posting key to the accountant by name', () => {
    expect(POSTING_ACCOUNT_LABELS.wipAccountId).toBe('إنتاج تحت التشغيل (مواد صُرفت ولم تُنتج)');
  });
});
