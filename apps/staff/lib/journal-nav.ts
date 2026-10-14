/**
 * ⏮ ◀ ▶ ⏭ — متنقّل القيود.
 *
 * `Form_WPF/FrmNewEntry.xaml` L427–431 يحمل خمسة أزرار في تذييل نافذة القيد:
 * «✖» خروج · «⏮» الأول · «◀» السابق · «▶» التالي · «⏭» الأخير، وعناوينها (`ToolTip`)
 * حرفية: «خروج» · «الأول» · «السابق» · «التالي» · «الأخير». و`FrmNewEntry.xaml.cs`
 * L843–861 يُنفّذها بأربعة استعلامات على `Entry` بترتيب المعرّف (أي ترتيب الإنشاء):
 * الأول `id asc` · الأخير `id desc` · السابق `id <` · التالي `id >`.
 *
 * وهذا الملف هو القرار وحده — لا شبكة ولا نداء — لأن الأحكام أربعةٌ دقيقة: من أين يبدأ
 * العدّ، وماذا يعني «مُعطَّل»، وأي نطاقٍ يبقى مع السهم حين ينتقل المُدخِل. فتُختبر بلا
 * متصفّح، وتُقرأ الشاشة منها.
 */

/** صفٌّ مختصر من `GET /journal-entries/:id/neighbours` — يكفي للزرّ ولعنوانه. */
export type JournalNeighbour = {
  id: string;
  number: string | null;
  date: string;
  description: string | null;
  status: string;
};

export type JournalNeighbours = {
  first: JournalNeighbour | null;
  previous: JournalNeighbour | null;
  next: JournalNeighbour | null;
  last: JournalNeighbour | null;
  /** موضع القيد في النطاق — يبدأ من 1 عند **الأقدم**، كما يعدّ الديسكتوب. */
  position: number;
  /** عدد قيود النطاق كلّه (لا الصفحة). */
  total: number;
};

export type NavKey = 'first' | 'previous' | 'next' | 'last';

/**
 * النصوص حرفية من نافذة الديسكتوب (`ToolTip` للأزرار الأربعة)، والرموز رمزُها.
 * والترتيب ترتيبُها في التذييل: خروج · الأول · السابق · التالي · الأخير.
 */
export const NAV_ITEMS: ReadonlyArray<{ key: NavKey; glyph: string; label: string }> = [
  { key: 'first', glyph: '⏮', label: 'الأول' },
  { key: 'previous', glyph: '◀', label: 'السابق' },
  { key: 'next', glyph: '▶', label: 'التالي' },
  { key: 'last', glyph: '⏭', label: 'الأخير' },
];

/**
 * نطاق السجل يبقى مع المُدخِل وهو يتنقّل: الفترة والحالة والفرع. ولو ضاع لخرج السهم من
 * الفترة المعروضة — وهو أسوأ من غياب السهم.
 */
export function scopeQuery(scope: { from?: string; to?: string; status?: string; branchId?: string }): string {
  const params = new URLSearchParams();
  if (scope.from) params.set('from', scope.from);
  if (scope.to) params.set('to', scope.to);
  if (scope.status) params.set('status', scope.status);
  if (scope.branchId) params.set('branchId', scope.branchId);
  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * أزرار التنقّل: زرٌّ بلا جارٍ **يُعطَّل ولا يُخفى** — فغيابه يُقرأ «لا يوجد» كما في
 * النافذة المكتبية حيث الأزرار ثابتة و`sender` هو ما يمنع القفز.
 */
export function navTargets(
  neighbours: JournalNeighbours | undefined,
  scope: { from?: string; to?: string; status?: string; branchId?: string } = {},
): Array<{ key: NavKey; glyph: string; label: string; href: string | null; title: string }> {
  const query = scopeQuery(scope);
  return NAV_ITEMS.map((item) => {
    const target = neighbours ? neighbours[item.key] : null;
    return {
      key: item.key,
      glyph: item.glyph,
      label: item.label,
      href: target ? `/accounting/journal-entries/${target.id}${query}` : null,
      // العنوان يسمّي القيد الذي سيُفتح، فيعرف المُدخِل أين يذهب قبل أن يقفز.
      title: target ? `${item.label} — ${target.number ?? 'بلا رقم'} · ${target.date}` : `${item.label} — لا قيد`,
    };
  });
}

/**
 * «موضع القيد: 13 من 29» — تسميةٌ سحابيّة صريحة (لا نصَّ لها في النافذة المكتبية).
 * وسببُها أنّ السجل يعرض **الأحدث أولاً** والتنقّل يمشي **زمنياً للأمام**: بلا مؤشّر
 * قد يُظنّ أنّ «التالي» هو الصفّ الذي تحت الصفّ، وهو عندنا القيد الأحدث.
 */
export function positionLabel(neighbours: JournalNeighbours | undefined): string {
  if (!neighbours) return 'موضع القيد: —';
  // قيدٌ خارج النطاق المعروض (رابطٌ مباشر إلى فترةٍ أخرى): يُقال صريحاً بدل رقمٍ كاذب.
  if (neighbours.position === 0) return 'موضع القيد: خارج النطاق المعروض';
  return `موضع القيد: ${neighbours.position} من ${neighbours.total}`;
}
