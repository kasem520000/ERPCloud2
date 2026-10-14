import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const appDir = join(testDir, '..', 'app');

const CONSOLE_ROUTES = [
  '/',
  '/tenants',
  '/tenants/new',
  '/subscriptions',
  '/plans',
  '/activation-requests',
  '/users',
  '/roles',
  '/audit',
  '/health',
  '/jobs',
  // P-C1 — the settings screen the console writes through `PUT /platform/settings`.
  '/settings',
  // P-C2 — بطاقة العميل: one dynamic route, reached from the customers list.
  '/tenants/[id]',
  // P-C3 — بطاقة المستخدم: reached from the directory, never from the sidebar.
  '/users/[id]',
  // P-C4 — الفواتير والمتابعة والإيراد، ومعاينة الطباعة خلف صفّ الفاتورة.
  '/invoices',
  '/invoices/[id]/print',
  '/dunning',
  '/revenue',
  // P-C5 — شبكة الاستخدام: من بلغ حدّه، ورسوم استدعاءات الـAPI، وتصدير البيان.
  '/usage',
  // P-C12 — التحليلات: الإيراد والتسرّب وقمع التفعيل والأفواج وحدود الاستخدام في شاشةٍ واحدة.
  '/analytics',
  // P-M10 — تحليلات الموقع: القمع التسويقي والمصادر ونتائج أ/ب (رمز التحليلات نفسه).
  '/analytics/site',
  // P-C6 — خدمة البريد: القوالب والسجلّ والإعدادات والحجر في شاشةٍ واحدة بأربعة تبويبات.
  '/email',
  // P-C7 — الإعلانات: كتابةٌ بنصّين، واستهداف، وجدولة، وقراءات.
  '/announcements',
  // P-C8 — مكتب الدعم: الصندوق الوارد، وتذكرةٌ واحدة، وسجلّ الدخول المؤقّت.
  '/tickets',
  '/tickets/[id]',
  '/impersonation',
  // P-C9 — العمليات: المهام صار لها فعلان، والصحة تقرأ مجسّاتٍ مفصَّلة، والملفات شاشةٌ جديدة.
  '/files',
  // P-C10 — البيانات والاسترجاع: النسخ والاحتفاظ في شاشة، وطلبات البيانات في أخرى.
  '/backups',
  '/data-requests',
  // P-C11 — بوابة المطوّر: المفاتيح، والويب هوك، ومستكشف الـAPI.
  '/api-keys',
  '/webhooks',
  '/api-explorer',
  // P-M5 — المحتوى: الصفحات وكتلها، والقوائم الخمس، واللافتات في شاشةٍ واحدة بأربعة تبويبات.
  '/content',
  // P-M6 — العملاء المتوقّعون: الطابور بمتابعته وتحويله، والنشرة البريدية في تبويبٍ ثانٍ.
  '/leads',
  // P-M7 — الحملات البريدية: الكتابة والجدولة والإرسال، وتقريرُ الفتح والنقر، والشرائح.
  '/campaigns',
];

function pageFileFor(href: string): string {
  const relative = href === '/' ? 'page.tsx' : `${href.replace(/^\//, '')}/page.tsx`;
  return join(appDir, relative);
}

describe('platform console routes', () => {
  it('has a page file behind every console route', () => {
    for (const href of CONSOLE_ROUTES) {
      expect(existsSync(pageFileFor(href)), href).toBe(true);
    }
  });

  /**
   * The old `/platform/*` **page** prefix must not come back after the surface separation.
   *
   * P-C1 made this check precise: the shell legitimately quotes API paths (`/platform/audit`)
   * and they all start with the same word. What must never exist again is a *link* to a page
   * under that prefix, so the scan now looks at `href` values only.
   */
  it('links no page under the legacy /platform prefix', () => {
    const shell = readFileSync(join(testDir, '..', 'components', 'platform-guard.tsx'), 'utf8');
    const hrefs = [...shell.matchAll(/href=(?:"([^"]+)"|\{`([^`]+)`\}|\{'([^']+)'\})/g)]
      .map((match) => match[1] ?? match[2] ?? match[3] ?? '')
      .filter((href) => !href.startsWith('${'));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href.startsWith('/platform'), href).toBe(false);
    }
  });

  /** Console login is operator-only: no signup path may exist on this surface. */
  it('offers no self-service signup', () => {
    const login = readFileSync(join(testDir, '..', 'components', 'login-screen.tsx'), 'utf8');
    const code = login.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('SignupPanel');
    expect(code).not.toContain('/signup');
    expect(code).not.toContain('/onboarding');
    expect(login).not.toContain('إنشاء حساب');
    expect(login).not.toContain('اشترك');
  });

  /**
   * P-C2 — the card is reachable and complete.
   *
   * A dynamic route is only a *real* screen if something links to it, so this checks both
   * halves: the list page links to `/tenants/:id`, and the card carries the plan's eight
   * tabs and calls the endpoints that back them.
   */
  it('links every customer row to its card', () => {
    const list = readFileSync(join(appDir, 'tenants', 'page.tsx'), 'utf8');
    expect(list).toContain('href={`/tenants/${tenant.id}`}');
  });

  it('renders the card with the plan’s tab names, in order', () => {
    const card = readFileSync(join(appDir, 'tenants', '[id]', 'page.tsx'), 'utf8');
    for (const label of [
      'نظرة عامة',
      'الاشتراك',
      'المستخدمون',
      'الاستخدام',
      'الرايات',
      'الصحة',
      'التدقيق',
      'الملاحظات',
    ]) {
      expect(card, label).toContain(label);
    }
    // The order is part of the contract with the plan, not an accident of typing.
    const positions = [
      'نظرة عامة',
      'الاشتراك',
      'المستخدمون',
      'الاستخدام',
      'الرايات',
      'الصحة',
      'التدقيق',
      'الملاحظات',
    ].map((label) => card.indexOf(`label: '${label}'`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('calls the P-C2 endpoints and no tenant-plane shortcut', () => {
    const card = readFileSync(join(appDir, 'tenants', '[id]', 'page.tsx'), 'utf8');
    for (const call of [
      '`/platform/tenants/${tenantId}`',
      '`/platform/tenants/${tenantId}/usage`',
      '`/platform/tenants/${tenantId}/health`',
      '`/platform/tenants/${tenantId}/notes`',
      '`/platform/tenants/${tenantId}/settings',
      '`/platform/tenants/${tenantId}/flags`',
      '`/platform/tenants/${tenantId}/branding`',
      '`/platform/tenants/${tenantId}/status`',
      '`/platform/tenants/${tenantId}/owner/transfer`',
    ]) {
      expect(card, call).toContain(call);
    }
    // The card is the platform plane only: it must never call a `/api/v1/tenants/…` route,
    // which is the customer's own surface and carries the tenant session's permissions.
    expect(card).not.toContain('/api/v1/tenant');
  });

  /**
   * P-C3 — the identity screens are real: the directory links to the card, the card calls the
   * five endpoints that back it, and the roles page writes the matrix through the one route
   * the plan names. Same rule as P-C2: a screen that calls nothing is a picture.
   */
  it('links every directory row to its user card', () => {
    const list = readFileSync(join(appDir, 'users', 'page.tsx'), 'utf8');
    expect(list).toContain('href={`/users/${row.id}`}');
    expect(list).toContain('/platform/operators/invite');
  });

  it('calls the P-C3 endpoints from the user card', () => {
    const card = readFileSync(join(appDir, 'users', '[id]', 'page.tsx'), 'utf8');
    for (const call of [
      '`/platform/users/${id}`',
      '`/platform/users/${id}/roles`',
      '`/platform/users/${id}/roles/${code}`',
      '`/platform/users/${id}/mfa/reset`',
      '`/platform/sessions/${entry.id}?reason=',
    ]) {
      expect(card, call).toContain(call);
    }
    // Like the customer card, the platform plane only.
    expect(card).not.toContain('/api/v1/tenant');
  });

  it('renders the roles matrix and writes it with a reason', () => {
    const roles = readFileSync(join(appDir, 'roles', 'page.tsx'), 'utf8');
    expect(roles).toContain('/platform/roles/${role.code}/permissions');
    expect(roles).toContain('/platform/permissions');
    for (const label of ['الحائزون', 'إرجاع إلى الفهرس', 'تجاوز مسجَّل']) {
      expect(roles, label).toContain(label);
    }
  });

  /**
   * P-C4 — the money screens are real too: every lifecycle action, every document step and
   * the print preview call the endpoint the plan names. A button that calls nothing is a
   * picture, and a money screen of pictures is worse than no screen.
   */
  it('drives the licence lifecycle from the subscriptions screen', () => {
    const page = readFileSync(join(appDir, 'subscriptions', 'page.tsx'), 'utf8');
    for (const call of [
      "apiPost('/platform/subscriptions'",
      '`/platform/subscriptions/${subscription.id}/change-plan`',
      '`/platform/subscriptions/${subscription.id}/${kind}`',
      '`/platform/subscriptions/${subscription.id}/cancel`',
    ]) {
      expect(page, call).toContain(call);
    }
    // The five lifecycle words the plan asks for, in the screen's own labels.
    for (const label of ['تجربة', 'تفعيل', 'ترقية/تخفيض', 'إيقاف مؤقّت', 'استئناف', 'إلغاء']) {
      expect(page, label).toContain(label);
    }
  });

  it('shows plan entitlements as وحدة · حدّ · راية and writes them with a reason', () => {
    const page = readFileSync(join(appDir, 'plans', 'page.tsx'), 'utf8');
    expect(page).toContain('`/platform/plans/${plan.id}/entitlements`');
    expect(page).toContain('`/platform/plans/${plan.id}`');
    expect(page).toContain('/platform/plans/entitlement-keys');
    for (const label of ['وحدة', 'حدّ', 'راية', 'الحقوق']) {
      expect(page, label).toContain(label);
    }
  });

  it('issues, collects, voids and prints an invoice from the invoices screen', () => {
    const page = readFileSync(join(appDir, 'invoices', 'page.tsx'), 'utf8');
    for (const call of [
      "apiPost<Invoice>('/platform/invoices'",
      '`/platform/invoices/${invoice.id}/issue`',
      '`/platform/invoices/${invoice.id}/pay`',
      '`/platform/invoices/${invoice.id}/void`',
      '`/platform/invoices/${id}`',
      'href={`/invoices/${row.id}/print`}',
    ]) {
      expect(page, call).toContain(call);
    }
    // The printed page carries the plate the API returns, rendered by the same A4 printer.
    const print = readFileSync(join(appDir, 'invoices', '[id]', 'print', 'page.tsx'), 'utf8');
    expect(print).toContain('`/platform/invoices/${id}/print`');
    expect(print).toContain('srcDoc');
  });

  it('runs the collection ladder and reads the revenue board', () => {
    const dunning = readFileSync(join(appDir, 'dunning', 'page.tsx'), 'utf8');
    expect(dunning).toContain('`/platform/dunning/${row.subscriptionId}/run`');
    expect(dunning).toContain("apiData<Board>('/platform/dunning'");
    for (const label of ['الجدول', 'المحاولات', 'الرسائل']) {
      expect(dunning, label).toContain(label);
    }

    const revenue = readFileSync(join(appDir, 'revenue', 'page.tsx'), 'utf8');
    expect(revenue).toContain("apiData<Revenue>('/platform/revenue'");
    for (const label of ['MRR', 'ARR', 'المتأخّر']) {
      expect(revenue, label).toContain(label);
    }
  });

  /** P-C1: the sidebar is a real tree, and the four groups are the plan's. */
  it('renders the shell from the navigation tree', () => {
    const shell = readFileSync(join(testDir, '..', 'components', 'platform-guard.tsx'), 'utf8');
    expect(shell).toContain('visibleConsoleGroups');
    expect(shell).toContain('canConsole');
    expect(shell).toContain('Ctrl+K');
  });
});
