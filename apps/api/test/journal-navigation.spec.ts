import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrgProvisioningService } from '../src/modules/organization/provisioning/org-provisioning.service.js';

import {
  ALL_ORGANIZATION_PERMISSIONS,
  ALL_PLATFORM_PERMISSIONS,
  createActor,
  type Actor,
} from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * R10 — ⏮ ◀ ▶ ⏭: التنقّل بين القيود من نافذة القيد.
 *
 * `Form_WPF/FrmNewEntry.xaml` L427–431 فيه أربعة أزرار تنقّل (`ToolTip`:
 * «الأول» · «السابق» · «التالي» · «الأخير») و`FrmNewEntry.xaml.cs` L843–861 يُنفّذها
 * بأربعة استعلامات على `Entry` بترتيب المعرّف — أي **ترتيب الإنشاء**:
 *
 *   · الأول  `order by id asc`   · الأخير `order by id desc`
 *   · السابق `id < EntryID`      · التالي `id > EntryID`
 *
 * والسحابة تُغلق بها البند المؤجَّل في §10 من `PHASE_07_ACCOUNTING.md` («التنقّل بين
 * القيود … السحابة لا تسمح بتعديل قيدٍ مرحّل؛ عكسه هو الطريق»): القراءة والتنقّل
 * تُوصلان، والتحرير يبقى مؤجَّلاً بسببٍ مكتوب.
 *
 * والأحكام التي يثبّتها هذا السبيك:
 *
 *   1. «التالي» و«السابق» جارٌ مباشرٌ حقيقي — لا القيد نفسه ولا قفزةٌ فوق جار.
 *   2. الموضع عدٌّ من **الأقدم** (كما يعدّ الديسكتوب)، ويزيد واحداً في كل خطوة.
 *   3. النطاق نطاقُ السجل نفسه: فترةٌ أو حالةٌ تُمرَّر فيَضيق العدّ ولا يخرج السهم.
 *   4. الطرفان عند حدّ النطاق `null` (فيُعطَّل الزرّ ولا يُخفى).
 *   5. قيدُ مستأجرٍ آخر وقيدٌ مجهول ⇒ 404 · ومعرّفٌ بلا صيغة ⇒ 400.
 */
describe('Journal entry navigation (R10)', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;

  let branchId = '';
  let accountA = '';
  let accountB = '';
  /** خمسة قيود مُنشأة بالترتيب — `ids[0]` أقدمها. */
  let ids: string[] = [];
  /** قيدُ المستأجر الآخر. */
  let foreignEntryId = '';

  const permissions = [
    ALL_PLATFORM_PERMISSIONS,
    ALL_ORGANIZATION_PERMISSIONS,
    'accounting.journal.post',
    'accounting.reports.view',
    // قراءة دليل الحسابات (وإلا 403 فوصل جسم الخطأ إلى `filter`)، وفتح السنة المالية.
    'accounting.account.view',
    'accounting.period.close',
    'accounting.period.view',
  ].flat();

  const data = (body: Record<string, unknown>): Record<string, unknown> =>
    (body.data ?? body) as Record<string, unknown>;
  const codeOf = (body: Record<string, unknown>): string | undefined =>
    (body.code as string | undefined) ?? (body.error as { code?: string } | undefined)?.code;

  const post = async (token: string, date: string, description: string): Promise<string> => {
    const response = await api(ctx.server, 'post', '/api/v1/journal-entries', {
      token,
      body: {
        branchId,
        date,
        description,
        lines: [
          { accountId: accountA, debit: '100', credit: '0' },
          { accountId: accountB, debit: '0', credit: '100' },
        ],
      },
    });
    expect(response.status).toBe(201);
    return data(response.body).id as string;
  };

  const neighbours = async (id: string, query = '') => {
    const response = await api(ctx.server, 'get', `/api/v1/journal-entries/${id}/neighbours${query}`, {
      token: actor.token,
    });
    expect(response.status).toBe(200);
    return data(response.body) as {
      first: { id: string } | null;
      previous: { id: string } | null;
      next: { id: string } | null;
      last: { id: string } | null;
      position: number;
      total: number;
    };
  };

  beforeAll(async () => {
    ctx = await createTestApp('journal-navigation');
    actor = await createActor(ctx, {
      tenantCode: 'journal-nav',
      email: 'owner@journal-nav.test',
      permissions,
    });
    stranger = await createActor(ctx, {
      tenantCode: 'journal-nav-2',
      email: 'owner@journal-nav-2.test',
      permissions,
    });

    const defaults = await ctx.app.get(OrgProvisioningService).provisionOrgDefaults(actor.tenantId);
    branchId = defaults.branchId;

    const year = new Date().getUTCFullYear();
    expect(
      (
        await api(ctx.server, 'post', '/api/v1/fiscal-years', {
          token: actor.token,
          body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
        })
      ).status,
    ).toBe(201);

    const accounts = await api(ctx.server, 'get', '/api/v1/accounts', { token: actor.token });
    expect(accounts.status).toBe(200);
    const rows = data(accounts.body) as Array<{
      id: string;
      type: string;
      isPostable: boolean;
      allowManual: boolean;
    }>;
    /**
     * حسابٌ يُقبل فيه القيد اليدوي: الدليل الافتراضي يبدأ بحسابات تجميعٍ
     * (`isPostable=false`) فالقيد عليها 422 — وهذا ما أوقف السبيك أول تشغيل.
     */
    const postable = rows.filter((row) => row.isPostable && row.allowManual);
    accountA = postable[0]?.id;
    accountB = postable[1]?.id;
    expect(postable.length).toBeGreaterThan(1);

    // خمسة قيود على أيام مختلفة — فيكون ترتيب الإنشاء هو ترتيب الأيام.
    ids = [];
    for (let index = 0; index < 5; index += 1) {
      const day = String(10 + index).padStart(2, '0');
      ids.push(await post(actor.token, `${year}-03-${day}`, `قيد الفحص ${index + 1}`));
    }
    /**
     * وللمستأجر الآخر سنتُه أيضاً: بدونها يردّ الترحيل `422 FISCAL_PERIOD_NOT_FOUND`
     * — وهذا بالضبط ما أوقف السبيك أول تشغيل، وكان الرسالة مضلِّلة حتى قُرئ رمزها.
     */
    expect(
      (
        await api(ctx.server, 'post', '/api/v1/fiscal-years', {
          token: stranger.token,
          body: { name: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
        })
      ).status,
    ).toBe(201);
    foreignEntryId = await post(stranger.token, `${year}-03-10`, 'قيد المستأجر الآخر');
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('1. الأقدم: بلا سابق ولا أوّلٍ قبله، والموضع 1 من عدد النطاق', async () => {
    const nav = await neighbours(ids[0] as string);
    expect(nav.previous).toBeNull();
    expect(nav.first?.id).toBe(ids[0]);
    expect(nav.position).toBe(1);
    expect(nav.total).toBe(5);
  });

  it('2. الأحدث: بلا تالٍ، وهو «الأخير» في النطاق', async () => {
    const nav = await neighbours(ids[4] as string);
    expect(nav.next).toBeNull();
    expect(nav.last?.id).toBe(ids[4]);
    expect(nav.position).toBe(5);
  });

  it('3. الجاران: السابق أقدم والتالي أحدث — ولا واحدٌ منهما القيد نفسه', async () => {
    const nav = await neighbours(ids[2] as string);
    expect(nav.previous?.id).toBe(ids[1]);
    expect(nav.next?.id).toBe(ids[3]);
    expect(nav.previous?.id).not.toBe(ids[2]);
    expect(nav.next?.id).not.toBe(ids[2]);
    expect(nav.position).toBe(3);
  });

  it('4. المشي التالي ← التالي يزيد الموضع واحداً في كل خطوة حتى آخر النطاق', async () => {
    let cursor: string = ids[0] as string;
    let position = 1;
    for (let step = 1; step < 5; step += 1) {
      const nav = await neighbours(cursor);
      expect(nav.position).toBe(position);
      expect(nav.next).not.toBeNull();
      cursor = (nav.next as { id: string }).id;
      position += 1;
    }
    const last = await neighbours(cursor);
    expect(last.position).toBe(5);
    expect(last.next).toBeNull();
    expect(cursor).toBe(ids[4]);
  });

  it('5. النطاق يضيّق العدّ: يومٌ واحد ⇒ قيدٌ واحد بلا جيران، وحالةٌ أخرى ⇒ نطاقها', async () => {
    const year = new Date().getUTCFullYear();
    const single = await neighbours(ids[2] as string, `?from=${year}-03-12&to=${year}-03-12`);
    expect(single.total).toBe(1);
    expect(single.position).toBe(1);
    expect(single.previous).toBeNull();
    expect(single.next).toBeNull();

    // قيدان في اليومين 10 و11 فقط.
    const window = await neighbours(ids[0] as string, `?from=${year}-03-10&to=${year}-03-11`);
    expect(window.total).toBe(2);
    expect(window.next?.id).toBe(ids[1]);
    expect(window.last?.id).toBe(ids[1]);

    // حالةٌ لا مطابق لها (‏`void`) ⇒ النطاق فارغٌ من قيدنا: لا جيران ولا موضع له فيه.
    const none = await neighbours(ids[0] as string, '?status=void');
    expect(none.total).toBe(0);
    expect(none.position).toBe(0);
    expect(none.previous).toBeNull();
    expect(none.next).toBeNull();

    /**
     * وقيدٌ **خارج** النطاق ونطاقُه غير فارغ: موضعه صفر («خارج النطاق المعروض») لا رقمٌ
     * يحسبه ترتيبُ المعرّفات كأنّه من النطاق وليس فيه — والسهمان يبقيان يدلّان على النطاق.
     */
    const outside = await neighbours(ids[2] as string, `?from=${year}-03-10&to=${year}-03-11`);
    expect(outside.total).toBe(2);
    expect(outside.position).toBe(0);
    expect(outside.previous?.id).toBe(ids[1]);
    expect(outside.next).toBeNull();
  });

  it('6. العزل: قيد مستأجرٍ آخر 404 عندنا — ولا يظهر في نطاقنا', async () => {
    const foreign = await api(ctx.server, 'get', `/api/v1/journal-entries/${foreignEntryId}/neighbours`, {
      token: actor.token,
    });
    expect(foreign.status).toBe(404);
    expect(codeOf(foreign.body)).toBe('NOT_FOUND');

    // وقيدُنا 404 عند المستأجر الآخر — والرمز نفسه بلا تمييز.
    const mine = await api(ctx.server, 'get', `/api/v1/journal-entries/${ids[0]}/neighbours`, {
      token: stranger.token,
    });
    expect(mine.status).toBe(404);
  });

  it('7. المجهول 404 ومعرّفٌ بلا صيغةٍ 400 (معالج R6 يسري على المسار الجديد)', async () => {
    const ghost = await api(
      ctx.server,
      'get',
      '/api/v1/journal-entries/01a0c600-0000-7000-8000-000000000999/neighbours',
      { token: actor.token },
    );
    expect(ghost.status).toBe(404);

    const malformed = await api(ctx.server, 'get', '/api/v1/journal-entries/not-a-uuid/neighbours', {
      token: actor.token,
    });
    expect(malformed.status).toBe(400);
    expect(codeOf(malformed.body)).toBe('INVALID_ID');
  });

  it('8. السجل يبقى ترتيبه ظاهراً: الأحدث أولاً، والتنقّل يعدّ من الأقدم', async () => {
    const register = await api(ctx.server, 'get', `/api/v1/journal-entries?from=${new Date().getUTCFullYear()}-03-01&to=${new Date().getUTCFullYear()}-03-31&limit=50`, {
      token: actor.token,
    });
    const rows = data(register.body) as Array<{ id: string; date: string }>;
    const inScope = rows.filter((row) => ids.includes(row.id));
    expect(inScope).toHaveLength(5);
    // أول صفٍّ في السجل هو الأحدث (ترتيب التسجيل)، وأول قيدٍ زمنياً هو `ids[0]`.
    expect(inScope[0]?.id).toBe(ids[4]);
    const first = await neighbours(ids[0] as string);
    expect(first.first?.id).toBe(ids[0]);
  });
});
