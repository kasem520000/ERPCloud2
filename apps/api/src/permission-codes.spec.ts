import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { permissionRegistry, platformPermissionRegistry, seedablePermissionCodes } from '@erp/contracts';
import { describe, expect, it } from 'vitest';

/**
 * Guard rail for `@RequiresPermission` and `@RequiresPlatformRole`.
 *
 * The guard denies any code the registry does not know, so a typo (or a code that was
 * never registered) turns into a permanent 403 that no role can grant. This test fails
 * at build time instead, where the mistake is cheap.
 *
 * P-C1 added the second half: **every platform route must name a console code**. The
 * scan below is the "صفر مسار `/platform/*` بلا رمز `console.*`" acceptance gate of
 * `docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4 — a route that drops the decorator fails the
 * suite, not a review.
 *
 * ولهذه القاعدة استثناءٌ واحد مكتوبٌ بالاسم لا بالنيّة (P-C10): **نهايتا المحتوى الموقّعتان**
 * (`GET /platform/backups/:id/content` و`GET /platform/data-requests/exports/:artifactId`)
 * تعملان بلا رمز حامل، لأن التصريح فيهما هو **التوقيع** لا الجلسة — وهذا هو نفسه قرار
 * `/files/:id/content` في مسار الملفات: تطبيقٌ يفتح رابطاً في تبويبٍ جديد لا يستطيع أن يحمل
 * رمزاً. ولذلك يُطالب هذا الاختبار بأن يكون لكل مسارٍ عامّ بهذا الشكل سطرٌ في القائمة أدناه
 * **وأن يُتحقّق توقيعه فعلاً** (`verifyDownloadToken`) — فإضافة `@Public()` عارية تُسقط البوابة.
 */

const srcDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(srcDir, '..', '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
  });
}

const controllers = sourceFiles(srcDir).filter((file) => file.endsWith('.controller.ts'));

/**
 * المسارات العامة المشروعة تحت `/platform`: تُفتح بـ**قدرةٍ موقّعة** لا بجلسة.
 *
 * القائمة صريحة عمداً (لا استثناءٌ أعمى لكل `@Public()`)، والمفتاح هو النصّ نفسه الذي
 * يُبنى منه الفشل: `Get <path> (<file>)` — فمساراتٌ جديدة لا تُقبل صامتة.
 */
const SIGNED_CAPABILITY_ROUTES: ReadonlyArray<{ key: string; signatureCheck: string }> = [
  {
    key: 'Get backups/:id/content (modules/backups/platform-backups.controller.ts)',
    signatureCheck: 'verifyDownloadToken',
  },
  {
    key: 'Get data-requests/exports/:artifactId (modules/backups/platform-backups.controller.ts)',
    signatureCheck: 'verifyDownloadToken',
  },
];

/**
 * Comments out of the way first: the guard's own docstring contains the literal
 * `@RequiresPlatformRole('console.…')` while explaining the decorator, and a scan that
 * counts prose as a route would be a false alarm generator.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** `@Controller('platform')` — the console plane, whichever module folder holds it. */
function isPlatformController(source: string): boolean {
  return /@Controller\(\s*'platform'/.test(source);
}

/**
 * Route decorators of a controller, as `METHOD path` pairs. The HTTP method is read from
 * the decorator itself so a `@Post` cannot be mistaken for a `@Get`.
 */
function routesOf(source: string): Array<{ method: string; path: string; index: number }> {
  const routes: Array<{ method: string; path: string; index: number }> = [];
  const pattern = /@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    routes.push({
      method: match[1] ?? '',
      path: match[2] ?? '',
      index: match.index ?? 0,
    });
  }
  return routes;
}

/** The decorators attached to a route, from its own `@Get(...)` to the next one. */
function decoratorBlockAfter(source: string, index: number): string {
  const rest = source.slice(index);
  const next = rest.slice(1).search(/@(Get|Post|Put|Patch|Delete)\(\s*(?:'[^']*')?\s*\)/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('permission codes used by controllers', () => {
  it('are all declared in the shared registry', () => {
    const declared = new Set(permissionRegistry.map((permission) => permission.code));
    const used = new Map<string, string>();

    for (const file of sourceFiles(srcDir)) {
      if (!statSync(file).isFile()) continue;
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const match of source.matchAll(/RequiresPermission\('([^']+)'\)/g)) {
        const code = match[1];
        if (code) used.set(code, file.slice(srcDir.length + 1));
      }
    }

    expect(used.size).toBeGreaterThan(50);
    const unknown = [...used.entries()]
      .filter(([code]) => !declared.has(code))
      .map(([code, file]) => `${code} (${file})`);
    expect(unknown).toEqual([]);
  });

  it('uses only declared console codes on platform routes (P-C1)', () => {
    const declared = new Set(platformPermissionRegistry.map((permission) => permission.code));
    const used = new Map<string, string>();
    let occurrences = 0;

    for (const file of sourceFiles(srcDir)) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const match of source.matchAll(/RequiresPlatformRole\('([^']+)'\)/g)) {
        const code = match[1];
        if (!code) continue;
        occurrences += 1;
        used.set(code, file.slice(srcDir.length + 1));
      }
    }

    // 17 legacy routes + 5 console routes; distinct codes are fewer.
    expect(occurrences).toBeGreaterThanOrEqual(20);
    const unknown = [...used.entries()]
      .filter(([code]) => !declared.has(code))
      .map(([code, file]) => `${code} (${file})`);
    expect(unknown).toEqual([]);
  });

  it('leaves no /platform route without a console permission (P-C1 acceptance)', () => {
    const platformControllers = controllers.filter((file) =>
      isPlatformController(stripComments(readFileSync(file, 'utf8'))),
    );
    expect(platformControllers.length).toBeGreaterThanOrEqual(2);

    const unprotected: string[] = [];
    let routes = 0;
    let signedRoutes = 0;

    for (const file of platformControllers) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const route of routesOf(source)) {
        routes += 1;
        const key = `${route.method} ${route.path} (${file.slice(srcDir.length + 1)})`;
        const block = decoratorBlockAfter(source, route.index);
        if (/@RequiresPlatformRole\('console\.[^']+'\)/.test(block)) continue;

        // مسارٌ عامّ يُقبل **إن كان مُعلَناً هنا** ويُتحقّق من توقيعه بنفسه.
        const declared = SIGNED_CAPABILITY_ROUTES.find((entry) => entry.key === key);
        if (declared && /@Public\(\)/.test(block) && source.includes(declared.signatureCheck)) {
          signedRoutes += 1;
          continue;
        }
        unprotected.push(key);
      }
    }

    // 17 legacy routes + 5 console routes; the guard is about coverage, not the count.
    expect(routes).toBeGreaterThanOrEqual(20);
    expect(signedRoutes).toBe(SIGNED_CAPABILITY_ROUTES.length);
    expect(unprotected).toEqual([]);
  });
});

describe('console permission codes (P-C1)', () => {
  /**
   * The new code needs three things together (`README.md` §4 gate 5): a declaration in
   * `packages/contracts/src/permissions.ts`, an idempotent insert in the migration, and a
   * row in the `permissions` table. The first two are checked here; the row is checked by
   * `platform-console-rbac.spec.ts` against a migrated database.
   */
  it('declares every console code as seedable and registered exactly once', () => {
    const codes = platformPermissionRegistry.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code.startsWith('console.')).toBe(true);
      expect(seedablePermissionCodes).toContain(code);
    }
    expect(codes).toContain('console.settings.manage');
  });

  it('inserts every console code idempotently in a migration', () => {
    const migrationsDir = join(repositoryRoot, 'packages', 'database', 'migrations');
    const sql = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => readFileSync(join(migrationsDir, name), 'utf8'))
      .join('\n');

    for (const entry of platformPermissionRegistry) {
      expect(sql, `${entry.code} must be inserted by a migration`).toContain(`('${entry.code}'`);
    }
    expect(sql).toMatch(/ON CONFLICT \(code\) DO UPDATE SET module = EXCLUDED\.module/);
  });
});
