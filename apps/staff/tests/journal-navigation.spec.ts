import { describe, expect, it } from 'vitest';

import {
  NAV_ITEMS,
  navTargets,
  positionLabel,
  scopeQuery,
  type JournalNeighbours,
} from '../lib/journal-nav';

/**
 * ⏮ ◀ ▶ ⏭ — قرار التنقّل وحده (R10).
 *
 * الأزرار الأربعة ونصوصها من `Form_WPF/FrmNewEntry.xaml` L427–431، وسلوكُها من
 * `FrmNewEntry.xaml.cs` L843–861. وهذا السبيك يثبّت الأحكام التي تفصل «سهمٌ يعمل» عن
 * «سهمٍ يقفز إلى غير ما يتوقّعه المُدخِل»: الطرفان يُعطَّلان (ولا يُخفيان)، والنطاق يبقى،
 * والعنوان يسمّي الوجهة.
 */
describe('journal entry navigation (⏮ ◀ ▶ ⏭)', () => {
  const row = (id: string, number: string | null, date: string) => ({
    id,
    number,
    date,
    description: null,
    status: 'posted',
  });

  const middle: JournalNeighbours = {
    first: row('first-id', 'JE-000001', '2026-03-10'),
    previous: row('prev-id', 'JE-000002', '2026-03-11'),
    next: row('next-id', 'JE-000004', '2026-03-13'),
    last: row('last-id', 'JE-000005', '2026-03-14'),
    position: 3,
    total: 5,
  };

  it('يحمل الأزرار الأربعة برموزها ونصوصها المكتبية وترتيبها', () => {
    expect(NAV_ITEMS.map((item) => `${item.glyph}${item.label}`)).toEqual(['⏮الأول', '◀السابق', '▶التالي', '⏭الأخير']);
  });

  it('يربط كل زرٍّ بجارِه في النطاق نفسه', () => {
    const scope = { from: '2026-03-01', to: '2026-03-31', status: 'posted' };
    const targets = navTargets(middle, scope);
    const query = '?from=2026-03-01&to=2026-03-31&status=posted';
    expect(targets.map((target) => target.href)).toEqual([
      `/accounting/journal-entries/first-id${query}`,
      `/accounting/journal-entries/prev-id${query}`,
      `/accounting/journal-entries/next-id${query}`,
      `/accounting/journal-entries/last-id${query}`,
    ]);
    // العنوان يسمّي الوجهة: رقمها وتاريخها (فلا يقفز المُدخِل إلى قيدٍ لا يعرفه).
    expect(targets[2]?.title).toContain('JE-000004');
    expect(targets[2]?.title).toContain('2026-03-13');
  });

  it('يُعطّل الطرفين ويربط الوسط — ولا يُخفي زرّاً', () => {
    const atFirst: JournalNeighbours = { ...middle, previous: null };
    const targets = navTargets(atFirst);
    expect(targets).toHaveLength(4);
    expect(targets.map((target) => target.href === null)).toEqual([false, true, false, false]);
    expect(targets[1]?.title).toBe('السابق — لا قيد');
  });

  it('بلا نطاق لا يُلحَق استفهامٌ بالرابط', () => {
    expect(scopeQuery({})).toBe('');
    expect(scopeQuery({ from: '2026-03-01' })).toBe('?from=2026-03-01');
    expect(scopeQuery({ from: '', to: '', status: '', branchId: '' })).toBe('');
  });

  it('يعطّل الأربعة قبل وصول الجيران (حالة التحميل) بدل أن يقفز إلى `undefined`', () => {
    const targets = navTargets(undefined, { from: '2026-03-01' });
    expect(targets.every((target) => target.href === null)).toBe(true);
    expect(positionLabel(undefined)).toBe('موضع القيد: —');
  });

  it('يعدّ من الأقدم كما يعدّ الديسكتوب، ويقولها صريحةً خارج النطاق', () => {
    expect(positionLabel(middle)).toBe('موضع القيد: 3 من 5');
    // قيدٌ خارج النطاق: `position` صفر مهما كان عدد قيود النطاق — والرسالة لا رقم لها.
    expect(positionLabel({ ...middle, position: 0, total: 0 })).toBe('موضع القيد: خارج النطاق المعروض');
    expect(positionLabel({ ...middle, position: 0, total: 6 })).toBe('موضع القيد: خارج النطاق المعروض');
  });
});
