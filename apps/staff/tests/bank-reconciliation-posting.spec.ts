import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const source = () => readFile(new URL('../app/treasury/bank-reconciliation/page.tsx', import.meta.url), 'utf8');

/**
 * 🏦 M6.5 — الترحيل القابل للمراجعة على شاشة التسوية البنكية. العقد يُثبَّت في الأصل
 * نفسه كما في بقية عقود الواجهات:
 *   1. الحالة الجديدة «مُرحَّل قيد» مرئية بالعربية، والمرحَّل يقف في جانب المسوّى لا
 *      في جانب المراجعة؛
 *   2. زر الترحيل للمعلّق خلف صلاحية الإدارة، والنموذج يطلب حساباً مقابلاً صريحاً —
 *      الاقتراح تعبئة مسبقة لا أكثر (لا ترحيل صامت)؛
 *   3. النموذج يرسل إلى مسار الترحيل الصحيح بالحقول الثلاثة؛
 *   4. السطر المرحَّل يفتح قيده من سجل اليومية.
 */
describe('bank reconciliation posting screen contract (M6.5)', () => {
  it('labels the posted status and moves posted lines to the settled side', async () => {
    const code = await source();
    expect(code).toContain("if (status === 'posted') return 'مُرحَّل قيد'");
    expect(code).toContain("line.status === 'matched' || line.status === 'posted'");
    // The review table keeps only what still needs a decision: pending and ignored.
    expect(code).toContain("rows.filter((line) => line.status === 'pending' || line.status === 'ignored')");
  });

  it('offers posting only for pending lines, behind the manage permission, with an explicit account', async () => {
    const code = await source();
    expect(code).toContain("manage && row.status === 'pending'");
    expect(code).toContain("onClick={() => openPostForm(row)}");
    // The form's own guard: a suggestion pre-fills but never posts by itself.
    expect(code).toContain('الاقتراح لا يُرحَّل من تلقاء نفسه');
    expect(code).toContain("accountId: line.suggestedAccountId ?? ''");
    expect(code).toMatch(/select required value=\{postForm\.accountId\}/);
  });

  it('posts to the line-posting endpoint with the reviewed fields', async () => {
    const code = await source();
    expect(code).toContain('`/treasury/bank-statements/${effectiveStatementId}/lines/${form.line.id}/post`');
    expect(code).toContain('accountId: form.accountId');
    expect(code).toContain('costCenterId: form.costCenterId || undefined');
    expect(code).toContain('description: form.description.trim() || undefined');
  });

  it('links a posted line to its journal entry', async () => {
    const code = await source();
    expect(code).toContain('`/accounting/journal-entries/${row.postedJournalEntryId}`');
    expect(code).toContain('قيد {row.postedJournalNumber');
  });
});
