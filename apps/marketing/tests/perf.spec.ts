import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { KIB, evaluateBudget, formatKib, routeFromManifestKey } from '../lib/perf.js';

/**
 * P-M10 — **ميزانية الأداء في CI** (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * القياس من مخرج البناء نفسه: `.next/app-build-manifest.json` يسرد لكل مسارٍ ملفات جافاسكربت
 * (المشترك + الخاص)، ويُجمع حجمها من القرص ويُقارن بسقفٍ في `perf-budget.json`.
 *
 * **ومتى تتخطّى الاختبار؟** إن لم يكن ثمّة بناء (تشغيلٌ محليّ بلا `next build`). وفي CI يفشل
 * الأمر صراحةً لأن `pnpm run verify` يبني قبل أن يختبر — فغياب المخرج هناك يعني أن البناء
 * لم يقع، وهذا عطلٌ لا سببٌ للتخطّي.
 */

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// مخرج البناء قد يكون بديلاً (`NEXT_DIST_DIR`) — نفس سياسة `next.config.mjs`.
const distDir = join(appDir, process.env.NEXT_DIST_DIR ?? '.next');
const manifestPath = join(distDir, 'app-build-manifest.json');
const budgetPath = join(appDir, 'perf-budget.json');

type BudgetFile = { kib: Record<string, number> };

const readBudget = (): BudgetFile => JSON.parse(readFileSync(budgetPath, 'utf8')) as BudgetFile;

/**
 * **بناءٌ إنتاجيٌّ لا خادم تطوير**: `next dev` يكتب المخطّط نفسه بملفاتٍ تطويرية ضخمة (‏10 م.ب
 * للمخطّط الواحد)، وقياسُها يعني ميزانيةً تفشل أبداً أو سقفاً يُرفع بلا معنى. فيدخل الحكم
 * `BUILD_ID` — ملفٌّ لا يكتبه إلا `next build`.
 */
const buildIdPath = join(distDir, 'BUILD_ID');
const productionBuild = existsSync(manifestPath) && existsSync(buildIdPath);
const inCi = process.env.CI === 'true' || process.env.CI === '1';

describe('P-M10 — ميزانية أداء الموقع', () => {
  it('ملف الميزانية يحمل سقفاً لكل مسارٍ عامّ يراه الزائر', () => {
    const { kib } = readBudget();
    for (const route of ['/', '/pricing', '/onboarding', '/demo', '/contact', '/help', '/help/[slug]', '/status']) {
      expect(kib[route], `لا سقف للمسار ${route}`).toBeGreaterThan(0);
    }
    // والسقف الافتراضي يمنع مساراً جديداً من الدخول بلا قياس.
    expect(kib['/default']).toBeGreaterThan(0);
    // وكل سقفٍ معقول: مسارٌ بسقف ميغابايت لن يُقاس أبداً.
    expect(Object.values(kib).every((value) => value > 20 && value < 1024)).toBe(true);
  });

  it('مفتاح المخطّط الداخلي يُحوَّل إلى مسار الزائر', () => {
    expect(routeFromManifestKey('/page')).toBe('/');
    expect(routeFromManifestKey('/pricing/page')).toBe('/pricing');
    expect(routeFromManifestKey('/help/[slug]/page')).toBe('/help/[slug]');
    expect(routeFromManifestKey('/robots.txt/route')).toBe('/robots.txt');
    expect(routeFromManifestKey('/en/cases/[slug]/page')).toBe('/en/cases/[slug]');
  });

  it('المقارنة تحسب التجاوز وتُبلّغ عن الأسوأ', () => {
    const report = evaluateBudget({
      fileSizes: { 'static/a.js': 200 * KIB, 'static/b.js': 100 * KIB, 'static/c.js': 10 * KIB },
      routeFiles: { '/page': ['static/a.js', 'static/c.js'], '/pricing': ['static/b.js', 'static/c.js'] },
      // «/pricing» بسقفٍ ضيّق (١١٠ ك.ب مقيسة مقابل ٦٠): التجاوز يُبلَّغ لا يُسكَت.
      routeBudgets: { '/page': 260 * KIB, '/pricing': 60 * KIB },
    });

    expect(report.passed).toBe(false);
    expect(report.worst?.route).toBe('/pricing');
    expect(report.lines.find((line) => line.route === '/page')?.over).toBe(false);
    expect(formatKib(1536)).toBe('1.5 kB');
  });

  it('وبلا سقفٍ لمسارٍ لا يُخترع سقف — والسقف الافتراضي يغطّيه إن أُريد', () => {
    const bare = evaluateBudget({
      fileSizes: { 'static/a.js': KIB },
      routeFiles: { '/new': ['static/a.js'] },
      routeBudgets: {},
    });
    expect(bare.lines).toEqual([]);
    expect(bare.passed).toBe(true);

    const covered = evaluateBudget({
      fileSizes: { 'static/a.js': 2 * KIB },
      routeFiles: { '/new': ['static/a.js'] },
      routeBudgets: {},
      defaultBudgetBytes: KIB,
    });
    expect(covered.passed).toBe(false);
    expect(covered.worst?.route).toBe('/new');
  });

  it.runIf(inCi || productionBuild)('مخرج البناء: كل مسارٍ داخل سقفه (وفي CI لا تخطّي)', () => {
    // في CI: `pnpm run verify` يبني قبل أن يختبر — فغياب مخرج البناء الإنتاجي عطلٌ لا سبب للتخطّي.
    expect(productionBuild, 'لا بناء إنتاجي — شغّل `pnpm --filter @erp/marketing build`').toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { pages: Record<string, string[]> };
    const fileSizes: Record<string, number> = {};
    for (const files of Object.values(manifest.pages)) {
      for (const file of files) {
        if (fileSizes[file] !== undefined) continue;
        const absolute = join(distDir, file);
        fileSizes[file] = existsSync(absolute) ? statSync(absolute).size : 0;
      }
    }
    const { kib } = readBudget();
    // المفاتيح تُحوَّل إلى مسارات الزائر قبل القياس — وإلا قِيس كلُّ شيءٍ بالسقف الافتراضي.
    const routeFiles = Object.fromEntries(
      Object.entries(manifest.pages).map(([key, files]) => [routeFromManifestKey(key), files]),
    );
    const report = evaluateBudget({
      fileSizes,
      routeFiles,
      routeBudgets: Object.fromEntries(
        Object.entries(kib)
          .filter(([route]) => route !== '/default')
          .map(([route, value]) => [route, value * KIB]),
      ),
      defaultBudgetBytes: (kib['/default'] ?? 300) * KIB,
    });

    const worst = report.worst;
    expect(
      report.passed,
      worst ? `تجاوز الميزانية: ${worst.route} = ${formatKib(worst.bytes)} > ${formatKib(worst.budgetBytes)}` : '',
    ).toBe(true);
    // والتقرير نفسه يجب أن يكون قد قاس شيئاً — ميزانيةٌ بلا صفوفٍ تمرّ بلا أن تقيس.
    expect(report.lines.length).toBeGreaterThan(0);
  });
});
