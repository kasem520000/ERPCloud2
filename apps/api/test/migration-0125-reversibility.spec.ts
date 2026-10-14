import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * 🔁 ترحيل `0125` — اصطلاح العكس وإصلاح ما تركه الاصطلاح القديم.
 *
 * المسارات الثلاثة (إلغاء مناقلة/سند مخزني، إبطال فاتورة بيع، إبطال فاتورة شراء) كانت تُرحِّل
 * المرآة **وتُبطل الأصل** معاً، وكل الأرصدة تجمع `status = 'posted'` ⇒ يسقط الأصل وتبقى مرآته،
 * فينحرف ميزان المراجعة ورصيد الحساب بمقدار المستند الملغى. الكود صار يعكس مرآةً وحدها، وهذا
 * الترحيل يُصلح الصفوف التي كُتبت قبل الإصلاح.
 *
 * يُختبر على قاعدة اختبار معزولة:
 *   1. الترحيل مُطبَّق من الحاضنة، وإعادة تطبيقه لا تغيّر شيئاً (idempotent)؛
 *   2. قيد أُبطل **وله مرآة** ⇒ يعود `posted` (فيصفر الأثر في الميزان)؛
 *   3. قيد أُبطل **بلا مرآة** ⇒ لا يُمسّ (إبطال مقصود، لا أثر للعكس)؛
 *   4. ملف التراجع يعيد الاصطلاح القديم (مع تحذيره الصريح) ثم يعود الإصلاح؛
 *   5. `0123` و`0124` و`0125` مطابقة لبصمتها المسجَّلة — لم يُعدَّل ترحيل تاريخي.
 */
const MIGRATIONS = fileURLToPath(new URL('../../../packages/database/migrations', import.meta.url));
const UP_NAME = '0125_journal_reversal_convention.sql';
const DOWN_NAME = 'down/0125_journal_reversal_convention.down.sql';
const PREVIOUS_NAMES = [
  '0123_van_sales_rep_workspace_and_receipt_workflow.sql',
  '0124_van_sales_stock_and_custody_settlement.sql',
];

const readSql = (relative: string): Promise<string> => fs.readFile(`${MIGRATIONS}/${relative}`, 'utf8');
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('migration 0125 — journal reversal convention', () => {
  let ctx: TestApp;
  let pool: Pool;
  let actor: Actor;
  let branchId = '';
  let periodId = '';
  let cashId = '';
  let revenueId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;
  const iso = new Date().toISOString().slice(0, 10);

  const statusOf = async (entryId: string): Promise<string> => {
    const result = await pool.query('SELECT status FROM journal_entries WHERE id = $1', [entryId]);
    return (result.rows[0] as { status: string }).status;
  };

  /** رصيد الحساب كما يراه التقرير (posted فقط) — وهو ما كان ينحرف. */
  const balanceOf = async (accountId: string): Promise<number> => {
    const rows = (
      await api(ctx.server, 'get', '/api/v1/accounts?with_balances=1', { token: actor.token })
    ).body as { data: Array<Record<string, unknown>> };
    const row = rows.data.find((entry) => entry.id === accountId);
    return Number(((row?.balance ?? {}) as { balance?: string }).balance ?? 0);
  };

  const postEntry = async (description: string) => {
    const posted = await api(ctx.server, 'post', '/api/v1/journal-entries', {
      token: actor.token,
      body: {
        date: iso,
        branchId,
        description,
        lines: [
          { accountId: cashId, debit: '120' },
          { accountId: revenueId, credit: '120' },
        ],
      },
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    return data(posted.body).id as string;
  };

  beforeAll(async () => {
    ctx = await createTestApp('migration_0125');
    pool = new Pool({ connectionString: ctx.db.ownerUrl, max: 1 });
    actor = await createActor(ctx, {
      tenantCode: 'mig-0125',
      email: 'owner@mig-0125.test',
      permissions: [
        ...ALL_PLATFORM_PERMISSIONS,
        'accounting.account.view',
        'accounting.account.manage',
        'accounting.journal.post',
        'accounting.journal.reverse',
        'accounting.period.view',
        'accounting.period.close',
        'accounting.reports.view',
      ],
    });
    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(actor.tenantId);
    branchId = defaults.branchId;

    // السنة المالية تنشئ فتراتها — وبدون فترة مفتوحة لا يُرحَّل قيد ولا يُعكس.
    const year = new Date().getUTCFullYear();
    const fiscal = await api(ctx.server, 'post', '/api/v1/fiscal-years', {
      token: actor.token,
      body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
    });
    expect(fiscal.status, JSON.stringify(fiscal.body)).toBe(201);

    const accounts = await api(ctx.server, 'get', '/api/v1/accounts', { token: actor.token });
    const rows = (accounts.body.data ?? accounts.body) as Array<Record<string, unknown>>;
    cashId = (rows.find((row) => row.code === '1100')?.id ?? rows[0]?.id) as string;
    revenueId = (rows.find((row) => String(row.code).startsWith('4'))?.id ?? rows[1]?.id) as string;

    const periods = await api(ctx.server, 'get', '/api/v1/fiscal-periods', { token: actor.token });
    const periodRows = (periods.body.data ?? periods.body) as Array<{ id: string; status: string }>;
    periodId = (periodRows.find((row) => row.status === 'open') ?? periodRows[0])?.id ?? '';
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await ctx?.close();
  });

  it('is applied and changes nothing when re-applied', async () => {
    const before = await pool.query(
      `SELECT status, COUNT(*)::int AS cnt FROM journal_entries GROUP BY status ORDER BY status`,
    );
    await pool.query(await readSql(UP_NAME));
    const after = await pool.query(
      `SELECT status, COUNT(*)::int AS cnt FROM journal_entries GROUP BY status ORDER BY status`,
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('repairs an entry that was both mirrored and voided, and leaves a deliberate void alone', async () => {
    // (أ) قيد عُكس عبر الواجهة ثم أُبطل أصله — أي بالضبط ما كانت المسارات الثلاثة تكتبه.
    const mirrored = await postEntry('قيد أُبطل أصله بعد العكس');
    const reversed = await api(ctx.server, 'post', `/api/v1/journal-entries/${mirrored}/reverse`, {
      token: actor.token,
      body: { branchId, fiscalPeriodId: periodId, date: iso, reason: 'عكس تجريبي' },
    });
    expect(reversed.status, JSON.stringify(reversed.body)).toBeLessThan(300);
    const revenueAfterReversal = await balanceOf(revenueId);

    // محاكاة العيب القديم: الحارس يسمح بـ posted → void مرة واحدة.
    await pool.query(`UPDATE journal_entries SET status = 'void' WHERE id = $1`, [mirrored]);
    expect(await statusOf(mirrored)).toBe('void');
    // والأثر: المرآة وحدها في الميزان ⇒ انحراف بمقدار القيد.
    const skewed = await balanceOf(revenueId);
    expect(Math.abs(skewed - revenueAfterReversal)).toBeGreaterThan(119);

    // (ب) قيد أُبطل قصداً بلا مرآة — لا يجوز أن يُمسّ.
    const deliberate = await postEntry('قيد أُبطل قصداً بلا عكس');
    await pool.query(`UPDATE journal_entries SET status = 'void' WHERE id = $1`, [deliberate]);

    await pool.query(await readSql(UP_NAME));

    expect(await statusOf(mirrored)).toBe('posted');
    expect(await statusOf(deliberate)).toBe('void');
    // الأصل ومرآته معاً صفر: الإيراد عاد إلى ما كان عليه قبل القيد وعكسه.
    expect(await balanceOf(revenueId)).toBeCloseTo(revenueAfterReversal, 4);

    // والمرآة نفسها لم تُمسّ.
    const mirrors = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM journal_entries WHERE reversal_of = $1 AND status = 'posted'`,
      [mirrored],
    );
    expect((mirrors.rows[0] as { cnt: number }).cnt).toBe(1);
  });

  it('rolls back through the down file and comes back through the up file', async () => {
    const mirrored = await postEntry('قيد إصلاح التراجع');
    await api(ctx.server, 'post', `/api/v1/journal-entries/${mirrored}/reverse`, {
      token: actor.token,
      body: { branchId, fiscalPeriodId: periodId, date: iso, reason: 'عكس للتراجع' },
    });
    expect(await statusOf(mirrored)).toBe('posted');

    // التراجع يعيد الاصطلاح القديم (ويحذّر منه في ملفه): الأصل يعود void.
    await pool.query(await readSql(DOWN_NAME));
    expect(await statusOf(mirrored)).toBe('void');

    // والعودة للأمام تُصلحه من جديد — الترحيل قابل للتطبيق مراراً.
    await pool.query(await readSql(UP_NAME));
    expect(await statusOf(mirrored)).toBe('posted');
  });

  it('leaves the historical migrations exactly as they were recorded', async () => {
    const result = await pool.query(
      `SELECT name, checksum FROM erp_migrations WHERE name LIKE '012%' ORDER BY name`,
    );
    const recorded = new Map(
      (result.rows as Array<{ name: string; checksum: string }>).map((row) => [row.name, row.checksum]),
    );
    for (const name of [...PREVIOUS_NAMES, UP_NAME]) {
      const onDisk = await readSql(name);
      expect(recorded.get(name), `${name} must be recorded as applied`).toBeTruthy();
      expect(sha256(onDisk), `${name} must not be edited after it was applied`).toBe(recorded.get(name));
    }
  });
});
