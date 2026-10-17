import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { PUBLIC_VERIFY_SAMPLE_PAYLOAD, ZATCA_FIELD_LABELS } from '@erp/contracts';

// امتدادات `.js` مقصودة في هذا الملف: `pnpm verify` يفحص المستودع كلّه ببرنامج TypeScript
// بترتيب NodeNext حيث الاستيراد النسبيّ بلا امتداد خطأ. وVite (vitest) وNext يحلّان `.js`
// إلى `.ts` بلا إعداد — وسبيكات `packages/contracts` تستعمل الصيغة نفسها.
import { industries, industryBySlug, industrySlugs, industryPath } from '../lib/industries.js';
import { trustAxes, trustLimitsAr } from '../lib/trust.js';
import {
  VERIFY_SAMPLE_PAYLOAD,
  checkClass,
  decideLocally,
  fieldRows,
  readableRecordedAt,
  serverInput,
  serverProblemMessage,
  toneClass,
} from '../lib/verify.js';

/**
 * P-M8 — «التحقّق والثقة والقطاعات» (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * وهذا الملف يقيس **قرارات الصفحات الثلاث**، وكلٌّ منها قرارٌ له ثمن لو سقط:
 *
 * 1. **القراءة في المتصفّح**: `lib/verify.ts` خالصٌ — لا `fetch` فيه أصلاً (يُقاس على النصّ).
 *    والنداء الخادمي الوحيد في الصفحة، ومساره نسبيّ (`/api/v1/…`) لا عنوان خادم داخلي.
 * 2. **حُكمان لا حُكم**: الحِمل السليم يُقرأ ويُحكم عليه محلياً بلا شبكة، ورمز الفاتورة لا
 *    يُدَّعى فكُّه في المتصفّح (لا حقول فيه) بل يُوجَّه إلى الخادم برسالةٍ لا خطأ.
 * 3. **لا وعدَ بلا شاشة**: كل سطرٍ في صفحات القطاعات يشير إلى تسميةٍ في
 *    `apps/staff/lib/navigation.ts` — والاختبار **يفتح الملف عند السطر المكتوب** ويتأكّد أن
 *    التسمية فيه فعلاً. فهذا ليس وصفاً في تقرير: من حرّك السطر أو حذف الشاشة يسقط الاختبار.
 * 4. **لا بندَ ثقةٍ بلا مصدر**: كل مصدرٍ في `lib/trust.ts` يُترجم إلى مسار ملفٍّ في المستودع،
 *    والمصدر المذكور بلا ملفٍّ يسقط.
 * 5. **وما لا ندّعيه مكتوب**: قسم «ما لا ندّعيه» غير فارغ، ولا يحمل رقم توفّرٍ ولا زمن استجابة
 *    ولا شهادة — ويُقاس بمنع الألفاظ لا بالثقة.
 */

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const staffNavigation = join(repoRoot, 'apps', 'staff', 'lib', 'navigation.ts');

describe('marketing /verify — الفحص في المتصفّح أولاً (P-M8)', () => {
  it('المنطق خالص: لا نداء شبكة في الوحدة، والنداء الوحيد في الصفحة ومساره نسبيّ', () => {
    const logic = readFileSync(join(repoRoot, 'apps', 'marketing', 'lib', 'verify.ts'), 'utf8');
    const page = readFileSync(join(repoRoot, 'apps', 'marketing', 'app', 'verify', 'page.tsx'), 'utf8');

    expect(logic).not.toContain('fetch(');
    expect(logic).not.toContain('http://');
    // نداءٌ واحد لا أكثر، وإلى مسارٍ نسبي على أصل الموقع — والوسيط (`next.config.mjs`) يمرّره.
    expect(page.match(/fetch\(/g)?.length).toBe(1);
    expect(page).toContain("fetch('/api/v1/public/verify'");
    expect(page).not.toContain('127.0.0.1');
    expect(page).not.toContain('localhost');
  });

  it('والحِمل السليم يُقرأ محلياً ويُحكم عليه بالفحوص الخمسة بلا سجلّ', () => {
    const outcome = decideLocally('payload', PUBLIC_VERIFY_SAMPLE_PAYLOAD);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.valid).toBe(true);
    expect(outcome.fields.vatNumber).toMatch(/^\d{15}$/);
    expect(outcome.checks.map((check) => check.code)).toEqual(
      expect.arrayContaining(['vat_number', 'timestamp', 'totals', 'signature']),
    );
    // والفحص يقيس الحقول وحدها: لا وعد بحالة سجلٍّ — وهذا ما تفعله أداةُ الفحص بلا خادم.
    expect(outcome.headlineAr).not.toContain('سجلّ');
  });

  it('وحِملٌ لا يُقرأ يعود برسالة خطأ لا بنتيجةٍ ناقصة، والنصّ الفارغ لا يُعالج صامتاً', () => {
    const junk = decideLocally('payload', '!!! ليس رمزاً !!!');
    expect(junk.ok).toBe(false);
    if (!junk.ok) {
      expect(junk.tone).toBe('error');
      expect(junk.messageAr.length).toBeGreaterThan(10);
    }

    const empty = decideLocally('payload', '   ');
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.tone).toBe('error');

    // رمزٌ مقطوع: يُقرأ مرفوضاً لا مقبولاً.
    const truncated = decideLocally('payload', PUBLIC_VERIFY_SAMPLE_PAYLOAD.slice(0, PUBLIC_VERIFY_SAMPLE_PAYLOAD.length - 8));
    expect(truncated.ok).toBe(false);
  });

  it('ورمز الفاتورة يُوجَّه إلى الخادم بنبرة شرحٍ لا خطأ (لا حقول فيه ليُقرأ محلياً)', () => {
    const outcome = decideLocally('uuid', '3f2504e0-4f89-11d3-9a0c-0305e82c3301');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.tone).toBe('info');
      expect(outcome.messageAr).toContain('التحقّق في الخادم');
    }
  });

  it('حِمل الإرسال واحدٌ من الحقلين، ورسالة العطل تفرّق بين 429 و400 وتعذّر الوصول', () => {
    expect(serverInput('payload', ' AQ4= ')).toEqual({ payload: 'AQ4=' });
    expect(serverInput('uuid', ' 3f2504e0-4f89-11d3-9a0c-0305e82c3301 ')).toEqual({
      uuid: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    });

    expect(serverProblemMessage(429)).toContain('دقيقة');
    expect(serverProblemMessage(400)).toContain('واحداً منهما');
    expect(serverProblemMessage(0)).toContain('الفحص المحلي');
  });

  it('الصفوف والشارات تأتي من العقد: خمسة حقول بتسمياته وألوانه', () => {
    const outcome = decideLocally('payload', VERIFY_SAMPLE_PAYLOAD);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const rows = fieldRows(outcome.fields);
    expect(rows.map((row) => row.label)).toEqual(Object.values(ZATCA_FIELD_LABELS).map((label) => label.labelAr));
    expect(rows.map((row) => row.value)).toEqual([
      outcome.fields.sellerName,
      outcome.fields.vatNumber,
      outcome.fields.timestamp,
      outcome.fields.total,
      outcome.fields.vatTotal,
    ]);

    // الأصناف الموجودة في ورقة الأنماط فعلاً (`badge ready|pending|failed`) — لا صنفٌ مُخترع.
    expect(toneClass('ok')).toBe('badge ready');
    expect(toneClass('danger')).toBe('badge failed');
    expect(toneClass('note')).toBe('badge pending');
    expect(checkClass({ code: 'totals', ok: false, severity: 'error', labelAr: '', labelEn: '', detailAr: '', detailEn: '' })).toBe(
      'badge failed',
    );
    expect(
      checkClass({ code: 'signature', ok: false, severity: 'note', labelAr: '', labelEn: '', detailAr: '', detailEn: '' }),
    ).toBe('badge pending');

    expect(readableRecordedAt(null)).toBe('—');
    expect(readableRecordedAt('2026-09-19T08:31:00.000Z')).toBe('2026-09-19 08:31');
  });
});

/** يحلّ مصدراً مكتوباً في `lib/trust.ts` إلى مسار ملفٍّ (ورمزٍ إن ذُكر `#symbol`) في المستودع. */
function sourceFilesExist(source: string): boolean {
  const tokens = source.split('·').map((token) => token.trim());
  let lastDir = repoRoot;
  for (const token of tokens) {
    const cleaned = token.replace(/\s*§[\d\-.]*\s*$/, '').replace(/:[\d\-.]+$/, '').split(/\s+/)[0] ?? '';
    const [path = '', anchor] = cleaned.split('#');
    if (path.length === 0) continue;
    const candidates = path.includes('/')
      ? [join(repoRoot, path)]
      : [join(lastDir, path), join(repoRoot, 'docs', path)];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (!found) return false;
    if (anchor) {
      const content = readFileSync(found, 'utf8');
      if (!content.includes(anchor)) return false;
    }
    lastDir = dirname(found);
  }
  return true;
}

describe('marketing /trust — كل بندٍ ومعه مصدره (P-M8)', () => {
  it('أربعة محاور، وكل محور فيه بندان على الأقل — لا محور شعار', () => {
    expect(trustAxes.map((axis) => axis.key)).toEqual(['encryption', 'isolation', 'backups', 'zatca']);
    for (const axis of trustAxes) {
      expect(axis.points.length, axis.key).toBeGreaterThanOrEqual(2);
      expect(axis.leadAr.length, axis.key).toBeGreaterThan(20);
    }
  });

  it('كل مصدرٍ يشير إلى ملفٍّ موجود في المستودع — والملفّ الغائب يُسقط البند', () => {
    const broken: string[] = [];
    for (const axis of trustAxes) {
      for (const point of axis.points) {
        if (!sourceFilesExist(point.source)) broken.push(`${axis.key}/${point.titleAr}: ${point.source}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('ولا بندَ بلا نصّ، ولا نصَّ بلا مصدر', () => {
    for (const axis of trustAxes) {
      for (const point of axis.points) {
        expect(point.titleAr.length, axis.key).toBeGreaterThan(3);
        expect(point.bodyAr.length, point.titleAr).toBeGreaterThan(40);
        expect(point.source.length, point.titleAr).toBeGreaterThan(5);
      }
    }
  });

  it('«ما لا ندّعيه» مكتوبٌ، ولا شهادةَ ولا نسبةَ توفّرٍ فيه ولا في البنود', () => {
    expect(trustLimitsAr.length).toBeGreaterThanOrEqual(4);
    const all = [...trustLimitsAr, ...trustAxes.flatMap((axis) => axis.points.map((point) => point.bodyAr))].join(' ');
    // الألفاظ التي تُكتب في صفحات الثقة عادةً بلا سند: تُمنع هنا نصّاً.
    expect(all).not.toMatch(/\bSLA\b(?!\s*\)?\s*في هذه المرحلة)/);
    expect(all).not.toContain('99.9');
    expect(all).not.toContain('ISO 27001 مُعتمَد');
    // والشهادة تُذكر مرّةً واحدة فقط — في قائمة «ما لا نعلنه» لا في وعد.
    expect(trustAxes.flatMap((axis) => axis.points.map((point) => point.bodyAr)).join(' ')).not.toContain('ISO');
  });
});

describe('marketing /industries — القطاعات من شجرة الموظّفين (P-M8)', () => {
  it('تسعة قطاعات بأسماء الخطة، والمسار يُبنى من الـslug نفسه', () => {
    expect(industrySlugs).toEqual([
      'tailoring',
      'optics',
      'marina',
      'contracting',
      'salla',
      'wholesale',
      'manufacturing',
      'food-factory',
      'van-sales',
    ]);
    expect(industryPath('marina')).toBe('/industries/marina');
    expect(industryBySlug('contracting')?.labelAr).toBe('المقاولات');
    expect(industryBySlug('van-sales')?.labelAr).toBe('البيع المتجول');
    expect(industryBySlug('nope')).toBeUndefined();
  });

  it('كل سطرٍ في كل قطاع يقابل تسميةً ومفتاحاً ثابتاً في شجرة شاشات العمل (AUD-18 / F-12)', () => {
    const lines = readFileSync(staffNavigation, 'utf8').split('\n');
    // M7 — شاشات المصنع والمناديب يسكبها `app-shell.tsx` عند تفعيل إضافة السوق،
    // فمصدرُها هناك. المصدرُ يسمّي الملف، والتحقق يفتح الملف المسمّى.
    const shellLines = readFileSync(join(repoRoot, 'apps', 'staff', 'components', 'app-shell.tsx'), 'utf8').split('\n');
    const mismatched: string[] = [];

    for (const industry of industries) {
      const screens: Array<{ label: string; source: string; href?: string }> = [
        ...industry.screens,
        { label: industry.module.label, source: industry.module.source },
      ];
      for (const screen of screens) {
        // ملحق شجرة الشاشات بامتداد tsx — خلاف ملف navigation.ts
        const match = /^apps\/staff\/(lib\/navigation\.ts|components\/app-shell\.tsx)#([a-z0-9-]+)$/.exec(screen.source);
        if (!match) {
          mismatched.push(`${industry.slug}/${screen.label}: مصدرٌ بلا معرّف ثابت (${screen.source})`);
          continue;
        }
        const [, file, key] = match;
        const sourceLines = file === 'lib/navigation.ts' ? lines : shellLines;
        // المعرّف قد يتكرّر (خريطة إضافات السوق تحمل المفتاح نفسه قبل التعريف) —
        // يكفي أن تظهر التسمية والمسار عند **بعض** مواضعه، لا عند أولها.
        const windows: string[] = [];
        sourceLines.forEach((line, index) => {
          if (line.includes(`'${key}'`) || line.includes(`"${key}"`)) {
            windows.push(sourceLines.slice(Math.max(0, index - 2), index + 8).join('\n'));
          }
        });
        if (windows.length === 0) {
          mismatched.push(`${industry.slug}/${screen.label}: المعرّف #${key} غير موجود في ${file}`);
          continue;
        }
        if (!windows.some((window) => window.includes(screen.label))) {
          mismatched.push(`${industry.slug}/${screen.label}: التسمية غائبة عند #${key}`);
        }
        const href = screen.href;
        if (href && !windows.some((window) => window.includes(href))) {
          mismatched.push(`${industry.slug}/${screen.label}: المسار ${href} غائب عند #${key}`);
        }
      }
    }

    expect(mismatched).toEqual([]);
  });

  it('وكل سطرٍ يحمل مسار شاشةٍ في تطبيق العمل — لا وعداً بلا شاشة', () => {
    for (const industry of industries) {
      expect(industry.screens.length, industry.slug).toBeGreaterThanOrEqual(2);
      for (const screen of industry.screens) {
        expect(screen.href.startsWith('/'), `${industry.slug}/${screen.label}`).toBe(true);
        expect(screen.whatAr.length, screen.label).toBeGreaterThan(20);
      }
      expect(industry.loopAr.length, industry.slug).toBeGreaterThanOrEqual(3);
      expect(industry.pictureAr.length, industry.slug).toBeGreaterThanOrEqual(3);
      expect(industry.summaryAr.length, industry.slug).toBeGreaterThan(40);
    }
  });

  it('ولا رقمَ ولا شهادةَ ولا وعدَ نتيجةٍ في صفحات القطاعات', () => {
    const all = industries
      .flatMap((industry) => [
        industry.summaryAr,
        ...industry.pictureAr,
        ...industry.screens.map((screen) => screen.whatAr),
        ...industry.loopAr,
      ])
      .join(' ');
    expect(all).not.toMatch(/%\s?\d/); // «٪30 أسرع» وأخواتها
    expect(all).not.toContain('مجاناً للأبد');
    expect(all).not.toContain('الأفضل في السوق');
  });
});
