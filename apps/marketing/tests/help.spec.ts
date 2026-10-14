import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { publicComponentKeys, publicStatusLevels, publicStatusRollUp } from '@erp/contracts';

// امتدادات `.js` مقصودة في هذا الملف: `pnpm verify` يفحص المستودع كلّه ببرنامج TypeScript
// بترتيب NodeNext حيث الاستيراد النسبيّ بلا امتداد خطأ. (التفصيل في `tests/verify.spec.ts`.)
import {
  changelogByMonth,
  changelogVersionOf,
  helpCategoryChips,
  helpVoteKey,
  helpVoteValue,
  helpfulSummaryAr,
  latencyLabel,
  newVisitorId,
  statusToneClass,
  storedHelpVote,
  uptimeLabel,
  voteMessageAr,
} from '../lib/help.js';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', 'app');

/**
 * P-M9 — منطق مركز المساعدة وحالة الخدمة (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * كلُّ ما يُقاس هنا منطقٌ خالص يُقاس بلا خادمٍ ولا متصفّح: شرائح الفئات، وحفظ الصوت في
 * المتصفّح، وصياغة الجمل المعروضة. وما لا يُقاس هنا (النداءات والصفحات) تقيسه السبيكات
 * الخادمية والسكربت الحيّ.
 */
describe('P-M9 — مركز المساعدة', () => {
  it('شرائح الفئات: «الكل» أولاً بمجموعٍ حقيقي، ثم الأكثر مقالاتٍ — والمختارة مُعلَمة', () => {
    const chips = helpCategoryChips({
      categories: [
        { name: 'التقارير', count: 4 },
        { name: 'الفواتير', count: 2 },
      ],
      selected: 'الفواتير',
    });

    expect(chips.map((chip) => chip.key)).toEqual(['__all__', 'التقارير', 'الفواتير']);
    expect(chips[0]?.count).toBe(6);
    expect(chips[0]?.active).toBe(false);
    expect(chips[2]?.active).toBe(true);
    expect(chips[1]?.active).toBe(false);
    // رابط الفئة يحمل المرشّح، ورابط «الكل» لا يحمله (إسقاطُ المرشّح هو معناه).
    expect(chips[0]?.href).toBe('/help');
    expect(chips[2]?.href).toBe('/help?category=%D8%A7%D9%84%D9%81%D9%88%D8%A7%D8%AA%D9%8A%D8%B1');
  });

  it('البحث يبقى في الرابط عند التنقّل بين الفئات — ومن بحث لا يفقد بحثه', () => {
    const chips = helpCategoryChips({
      categories: [{ name: 'التقارير', count: 1 }],
      selected: null,
      query: 'فاتورة',
    });
    for (const chip of chips) expect(chip.href).toContain('q=%D9%81%D8%A7%D8%AA%D9%88%D8%B1%D8%A9');
    expect(chips[0]?.active).toBe(true);
  });

  it('صوت المتصفّح: مفتاحٌ لكل مقال، وقيمةٌ تُقرأ كما كُتبت', () => {
    expect(helpVoteKey('how-to-invoice')).toBe('help-vote:how-to-invoice');
    expect(helpVoteValue(true)).toBe('yes');
    expect(helpVoteValue(false)).toBe('no');
    expect(storedHelpVote('yes')).toBe(true);
    expect(storedHelpVote('no')).toBe(false);
    // ما ليس صوتاً يُقرأ «لم يصوّت» — لا يُخترع صوتٌ من قيمةٍ غريبة.
    expect(storedHelpVote(null)).toBeNull();
    expect(storedHelpVote('')).toBeNull();
    expect(storedHelpVote('maybe')).toBeNull();
  });

  it('معرّف المتصفّح يخرج بصيغة UUID — لأنه ما يتحقّق منه العقد', () => {
    const id = newVisitorId();
    // النسخة ٤ والبديل «٨/٩/a/b» — كما يولّده `crypto.randomUUID` في المتصفّح وفي Node.
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newVisitorId()).not.toBe(id);
  });

  it('الجمل تقول الحقيقة: الصوت المحسوب مرّةً سابقةً لا يُقدَّم كأنه جديد', () => {
    expect(voteMessageAr(true)).toContain('سُجّل');
    expect(voteMessageAr(false)).toContain('من قبل');
    // ولا تُعرض أصفارٌ فارغة، وتُعرض النسبة إن وُجدت أصوات.
    expect(helpfulSummaryAr(0, 0)).toBeNull();
    expect(helpfulSummaryAr(4, 0)).toContain('4');
    expect(helpfulSummaryAr(3, 1)).toContain('75');
  });
});

describe('P-M9 — سجلّ التغييرات', () => {
  it('التجميع بالشهر: الأحدث أولاً، ولا مدخل يضيع بين المجموعات', () => {
    const groups = changelogByMonth(
      [
        { slug: 'a', publishedAt: '2026-09-02T10:00:00.000Z' },
        { slug: 'b', publishedAt: '2026-09-20T10:00:00.000Z' },
        { slug: 'c', publishedAt: '2026-08-11T10:00:00.000Z' },
      ],
      'ar',
    );
    expect(groups.map((group) => group.key)).toEqual(['2026-09', '2026-08']);
    expect(groups[0]?.entries.map((entry) => entry.slug)).toEqual(['a', 'b']);
    expect(groups[1]?.entries.map((entry) => entry.slug)).toEqual(['c']);
    expect(groups[0]?.label.length).toBeGreaterThan(2);
  });

  it('رقم الإصدار يُقرأ من العنوان إن وُجد، ولا يُخترع إن غاب', () => {
    expect(changelogVersionOf('v1.4 التقارير المجدولة')).toBe('1.4');
    expect(changelogVersionOf('1.4.2 إصلاح الفواتير')).toBe('1.4.2');
    expect(changelogVersionOf('تحسينات عامّة')).toBeNull();
  });
});

describe('P-M9 — حالة الخدمة', () => {
  it('أصناف العرض من الحالات الأربع، والحالات تغطّي مفردات العقد', () => {
    expect(statusToneClass('ready')).toBe('badge ready');
    expect(statusToneClass('pending')).toBe('badge pending');
    expect(statusToneClass('failed')).toBe('badge failed');
    // «غير مُهيّأة» ليست فشلاً: بلا صنفٍ أحمر — وإلّا ظهرت بيئةُ تطويرٍ كأنها معطّلة.
    expect(statusToneClass('muted')).toBe('badge');
    expect([...publicStatusLevels]).toEqual(['up', 'degraded', 'down', 'not_configured']);
  });

  it('الحكم الإجمالي = أسوأ مكوّنٍ مقيس، و«غير مُهيّأ» لا تُسقطه', () => {
    expect(publicStatusRollUp(publicComponentKeys.map(() => 'up'))).toBe('up');
    expect(publicStatusRollUp(['up', 'not_configured', 'not_configured', 'not_configured', 'degraded'])).toBe('degraded');
  });

  it('زمن الاستجابة والمدّة يُصاغان للقارئ لا للآلة', () => {
    expect(latencyLabel(null, 'ar')).toBeNull();
    expect(latencyLabel(3.14159, 'ar')).toContain('3.1');
    expect(latencyLabel(42.7, 'ar')).toContain('43');
    expect(latencyLabel(12, 'en')).toBe('12 ms');
    expect(uptimeLabel(30, 'ar')).toContain('أقلّ من دقيقة');
    expect(uptimeLabel(3_600 * 5, 'ar')).toContain('5 ساعة');
    expect(uptimeLabel(86_400 * 2 + 3_600, 'ar')).toContain('2 يوم');
  });

  it('صفحة الحالة تُبنى على مسارٍ حقيقي، والنداء بلا ذاكرة', () => {
    const page = readFileSync(join(appDir, 'status', 'page.tsx'), 'utf8');
    expect(page).toContain('fetchStatus');
    // `revalidate: 0` في `lib/content.ts` — صفحةُ حالةٍ تُخبر عن لحظةٍ مضت أسوأ من لا شيء.
    const content = readFileSync(join(here, '..', 'lib', 'content.ts'), 'utf8');
    expect(content).toContain("'/public/status', null, 0");
    expect(existsSync(join(appDir, 'status', 'page.tsx'))).toBe(true);
  });
});
