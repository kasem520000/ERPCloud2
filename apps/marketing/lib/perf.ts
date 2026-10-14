/**
 * P-M10 — **ميزانية أداء الموقع** (`docs/roadmap/MARKETING_SITE_PLAN.md` §5): «ميزانية أداء في CI».
 *
 * والفكرة كلها في هذا الملف: **رقمٌ يُقاس في كل بناء**، لا انطباعٌ يُكتب في تقرير. والقياس
 * من مخرج البناء نفسه (`.next/app-build-manifest.json`) لا من الشبكة: ما يُقاس هو ما يُشحن
 * إلى المتصفّح، وهو الشيء الذي يتحكّم فيه الفريق فعلاً.
 *
 * **ولماذا `First Load JS` لا زمن التحميل؟** الزمن يعتمد على جهاز القارئ وشبكته، ولا يُعاد
 * إنتاجه في CI. أمّا حجم الجافاسكربت فثابتٌ لكل بناء، وزيادته المفاجئة (مكتبةٌ ثقيلة دخلت
 * عن غير قصد) تُرى في السطر نفسه. والزمن يُقاس في `scripts/verify-marketing-site.mjs` حيث
 * توجد مساحةٌ حيّة.
 *
 * **والمنهج**: مجموع أوزان ملفات كل مسار كما يسردها Next (المشترك + الخاص)، مقابل سقفٍ في
 * `perf-budget.json`. والتجاوز **يُسقط البناء** (سبيكٌ في `pnpm -r run test`) — ميزانيةٌ لا
 * تُسقط شيئاً ليست ميزانية.
 */

export type BudgetLine = { route: string; bytes: number; budgetBytes: number; over: boolean };

export type BudgetReport = {
  lines: BudgetLine[];
  /** أكبر تجاوزٍ في التقرير — أو `null` إن كان كل شيء داخل الميزانية. */
  worst: BudgetLine | null;
  passed: boolean;
};

/** كيلوبايت = ١٠٢٤ بايت — والوحدات تُعرض كيلوبايت لأن الأرقام الخام تُقرأ بلا معنى. */
export const KIB = 1024;

/**
 * مساراتٌ **لا يراها الزائر** فلا تُقاس بميزانيته.
 *
 * `/design` هي صفحة مراجعة نظام التصميم (Design v3 §2.3): تعرض كل مكوّن مرة
 * واحدة — recharts وframer-motion وكل مغلّف — لأن غرضها هو المراجعة البصرية في
 * الوضعين. وهي `notFound()` في البناء الإنتاجي، فحجمها لا يصل إلى زائر أبدًا.
 * قياسها بسقف ٦٨٠ ك.ب كان سيُسقط البناء لأن الصفحة تحمل المكتبات كلها عن قصد.
 *
 * وهذا **ليس** رفع سقف: السقف كما هو، والقائمة هنا تقول بأيّ مسارٍ لا ينطبق.
 */
export const UNMEASURED_ROUTES: readonly string[] = ['/design'];

export function formatKib(bytes: number): string {
  return `${(bytes / KIB).toFixed(1)} kB`;
}

/**
 * مفتاح المخطّط ← مسار المستخدم.
 *
 * و`app-build-manifest.json` يسرد مفاتيحَه الداخلية (`/pricing/page` و`/page` و`/robots.txt/route`)،
 * وفيها يكمن فخٌّ مقيس: ملف ميزانيةٍ كتبناه بـ`/pricing` **لم يطابق شيئاً** في التشغيل الأول،
 * فقاس كلّ مسارٍ بسقف «الافتراضي» وظنّ أنّ الميزانية تعمل. فلا تُكتب المفاتيح الداخلية في
 * الملف، ويُحوَّل المفتاح هنا: `/page` هو الجذر، واللواحق `page|route` تُقلَّم.
 */
export function routeFromManifestKey(key: string): string {
  const trimmed = key.replace(/\/(page|route)$/, '');
  return trimmed === '' || trimmed === '/' ? '/' : trimmed;
}

/**
 * المقارنة: لكل مسارٍ ميزانيته (`routeBudgets`)، وما لا سقف له لا يُقاس (لا يُخترع سقفٌ
 * لمسارٍ لم يُراجَع)، وملفات المسار تُجمع كما وردت بلا تصفية — فالمشترك جزءٌ من الواقع.
 */
export function evaluateBudget(input: {
  /** حجم كل ملفٍ كما سرده Next، مفاتيحها مسارات الملفات. */
  fileSizes: Record<string, number>;
  /** ملفات كل مسار (`app-build-manifest.json` → `pages`). */
  routeFiles: Record<string, string[]>;
  routeBudgets: Record<string, number>;
  /** سقف المسارات التي لا سطر لها — أو `null` لتركها بلا قياس. */
  defaultBudgetBytes?: number | null;
}): BudgetReport {
  const lines: BudgetLine[] = [];
  for (const [route, files] of Object.entries(input.routeFiles)) {
    if (UNMEASURED_ROUTES.includes(route)) continue;
    const budget =
      input.routeBudgets[route] ?? (input.defaultBudgetBytes === undefined ? null : input.defaultBudgetBytes);
    if (budget === null || budget === undefined) continue;
    const bytes = files.reduce((sum, file) => sum + (input.fileSizes[file] ?? 0), 0);
    lines.push({ route, bytes, budgetBytes: budget, over: bytes > budget });
  }
  lines.sort((left, right) => right.bytes - right.budgetBytes - (left.bytes - left.budgetBytes));
  const over = lines.filter((line) => line.over);
  return { lines, worst: over[0] ?? null, passed: over.length === 0 };
}
