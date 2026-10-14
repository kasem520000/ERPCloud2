import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  IMPERSONATION_MAX_MINUTES,
  permissionRegistry,
  type ImpersonationSession,
  type SupportTicket,
  type TicketDetail,
} from '@erp/contracts';
import { withPlatformAdminTx } from '@erp/database';

import { createActor, createTenantFixture, type Actor, type ActorOptions } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * P-C8 — «مكتب الدعم والدخول المؤقّت» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
 *
 * ما يقيسه هذا الملف هو الحدّ بين «نظرٍ بعين العميل» و«العمل باسمه»:
 *
 * 1. **التذاكر**: الفتح بمهلةٍ من الأولوية، الردّ العام مقابل الملاحظة الداخلية (الأولى
 *    توقف عدّاد الاستجابة والثانية لا)، ولا ردّ ولا إعادة فتحٍ لتذكرةٍ مغلقة.
 * 2. **الترشيح**: الحالة والأولوية والإسناد، ومرشِّحٌ خارج الفهرس 400.
 * 3. **الدخول المؤقّت**: رمزٌ يحمل `imp` وعمره لا يزيد على الجلسة، ودخوله بعين مالك المنشأة
 *    لا بهويّته، و`GET /me` يعلن الجلسة وسببها.
 * 4. **حدوده**: لا حذف، ولا مسّ بـ`/auth/` (تغيير كلمة مرور)، ولا صلاحيات منصة للرمز —
 *    والإنهاء يُسقطه من الطلب التالي لا عند انتهاء صلاحيته.
 * 5. **الصلاحية**: بلا `console.support.manage` لا تذاكر ولا دخول.
 * 6. **التدقيق**: كل فعلٍ يترك صفّه باسم من فعله وسببه.
 */

type OperatorOptions = ActorOptions & { platformRoles?: readonly string[] };

/** كل رموز الفهرس: مالك المنشأة يفعل كل شيء في منشأته — وهذا ما يقيسه «الدخول المؤقّت». */
const everyPermission = permissionRegistry.map((entry) => entry.code);
const createOperator = createActor as (ctx: TestApp, options: OperatorOptions) => Promise<Actor>;

describe('platform support desk (P-C8)', () => {
  let ctx: TestApp;
  let owner: Actor;
  let support: Actor;
  let auditor: Actor;
  let billing: Actor;
  let customerA: Actor;
  let customerB: Actor;
  let ownerlessTenantId: string;

  const base = '/api/v1';

  const platform = (
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    body?: unknown,
    actor: Actor = owner,
  ) => api(ctx.server, method, `${base}${path}`, { token: actor.token, body });

  const openTicket = (overrides: Record<string, unknown> = {}) =>
    platform('post', '/platform/tickets', {
      tenantId: customerA.tenantId,
      subject: 'الفاتورة لا تُطبع',
      body: 'عند الطباعة تظهر الصفحة بيضاء ولا سطر خطأ.',
      priority: 'high',
      reason: 'تحقّق P-C8',
      ...overrides,
    });

  /** رمز الدخول المؤقّت يُقرأ مضمونُه من الرمز نفسه: `imp` وعمره. */
  const decode = (token: string): Record<string, unknown> => {
    const payload = token.split('.')[1] ?? '';
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  };

  const auditRows = () =>
    withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT action, entity, entity_id, meta FROM audit_log ORDER BY created_at ASC`),
    );

  const messagesOf = (ticketId: string) =>
    withPlatformAdminTx(ctx.handle.db, (tx) =>
      tx.execute(sql`SELECT author_kind, is_internal, body FROM ticket_messages
                      WHERE ticket_id = ${ticketId} ORDER BY created_at ASC`),
    );

  beforeAll(async () => {
    ctx = await createTestApp('platform-support');

    await createTenantFixture(ctx.db.ownerUrl, {
      code: 'platform',
      name: 'منشأة المشغّلين',
      status: 'active',
    });

    owner = await createOperator(ctx, {
      tenantCode: 'sup-ops',
      email: 'owner@sup-ops.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_owner'],
    });
    support = await createOperator(ctx, {
      tenantCode: 'sup-ops',
      email: 'support@sup-ops.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_support'],
    });
    auditor = await createOperator(ctx, {
      tenantCode: 'sup-ops',
      email: 'auditor@sup-ops.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_auditor'],
    });
    // دورٌ منصّي آخر لا يملك `console.support.manage` — الفرق بين «منصّي» و«مخوّل».
    billing = await createOperator(ctx, {
      tenantCode: 'sup-ops',
      email: 'billing@sup-ops.test',
      permissions: [],
      roleNames: ['Console'],
      platformRoles: ['platform_billing'],
    });

    customerA = await createActor(ctx, {
      tenantCode: 'sup-a',
      tenantName: 'الشركة الأولى',
      email: 'owner@sup-a.test',
      permissions: everyPermission,
      roleNames: ['Admin'],
      isOwner: true,
    });
    customerB = await createActor(ctx, {
      tenantCode: 'sup-b',
      tenantName: 'الشركة الثانية',
      email: 'owner@sup-b.test',
      permissions: everyPermission,
      roleNames: ['Admin'],
      isOwner: true,
    });

    // منشأةٌ نشطة بلا مالكٍ نشط: لا عضوية يدخل بها المشغّل.
    const ownerless = await createTenantFixture(ctx.db.ownerUrl, {
      code: 'sup-empty',
      name: 'بلا مالك',
      status: 'active',
    });
    ownerlessTenantId = ownerless.id;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('يفتح تذكرةً بمهلتها من الأولوية، ويسجّل رسالتها الأولى باسم العميل', async () => {
    const created = await openTicket();
    expect(created.status).toBe(201);
    const ticket = created.body.data as TicketDetail;
    expect(ticket.status).toBe('open');
    expect(ticket.priority).toBe('high');
    expect(ticket.messageCount).toBe(1);
    expect(ticket.firstResponseAt).toBeNull();
    expect(ticket.tenantId).toBe(customerA.tenantId);

    // الأولى «عالية» ⇒ 4 ساعات من لحظة الفتح (بالساعات في العقد لا في الواجهة).
    const hours =
      (new Date(ticket.slaDueAt as string).getTime() - new Date(ticket.createdAt).getTime()) / 3_600_000;
    expect(hours).toBeGreaterThan(3.9);
    expect(hours).toBeLessThan(4.1);

    const messages = await messagesOf(ticket.id);
    expect(messages.rows.length).toBe(1);
    expect(messages.rows[0].author_kind).toBe('customer');
  });

  it('يرفض تذكرةً بلا سببٍ كافٍ أو بموضوعٍ قصير', async () => {
    expect((await openTicket({ reason: 'لا' })).status).toBe(400);
    expect((await openTicket({ subject: 'أب' })).status).toBe(400);
    expect((await openTicket({ tenantId: '00000000-0000-0000-0000-000000000000' })).status).toBe(422);
  });

  it('الملاحظة الداخلية لا توقف عدّاد الاستجابة، والردّ العام يوقفه وينقل التذكرة إلى pending', async () => {
    const ticket = (await openTicket({ priority: 'normal' })).body.data as TicketDetail;

    const note = await platform('post', `/platform/tickets/${ticket.id}/reply`, {
      body: 'نتحقّق من الطابعة مع فريق البنية.',
      isInternal: true,
      reason: 'ملاحظة تشغيلية',
    });
    expect(note.status).toBe(201);
    const afterNote = note.body.data as TicketDetail;
    expect(afterNote.status).toBe('open');
    expect(afterNote.firstResponseAt).toBeNull();
    expect(afterNote.messages.filter((message) => message.isInternal).length).toBe(1);

    const reply = await platform('post', `/platform/tickets/${ticket.id}/reply`, {
      body: 'وصلنا طلبك — أعد تشغيل خدمة الطباعة ثم أعد المحاولة.',
      reason: 'ردٌّ على العميل',
    });
    const afterReply = reply.body.data as TicketDetail;
    expect(afterReply.status).toBe('pending');
    expect(afterReply.firstResponseAt).not.toBeNull();
  });

  it('التذكرة المغلقة تُغلق مرةً واحدة: لا ردّ عليها ولا إعادة فتح', async () => {
    const ticket = (await openTicket({ priority: 'low' })).body.data as TicketDetail;

    const closed = await platform('patch', `/platform/tickets/${ticket.id}`, {
      status: 'closed',
      reason: 'انتهت المشكلة',
    });
    expect(closed.status).toBe(200);
    const afterClose = closed.body.data as TicketDetail;
    expect(afterClose.closedAt).not.toBeNull();

    const replied = await platform('post', `/platform/tickets/${ticket.id}/reply`, {
      body: 'ملاحظة متأخّرة',
      reason: 'بعد الإغلاق',
    });
    expect(replied.status).toBe(422);

    const reopened = await platform('patch', `/platform/tickets/${ticket.id}`, {
      status: 'open',
      reason: 'محاولة إعادة فتح',
    });
    expect(reopened.status).toBe(422);
  });

  it('يرشّح التذاكر بالحالة والأولوية والإسناد، ويرفض مرشِّحاً خارج الفهرس', async () => {
    const urgent = await openTicket({ priority: 'urgent', subject: 'توقّف البيع في الفرع' });
    const urgentTicket = urgent.body.data as TicketDetail;

    const byStatus = await platform('get', '/platform/tickets?filter[status]=open&limit=50');
    expect(byStatus.status).toBe(200);
    const openRows = byStatus.body.data as SupportTicket[];
    expect(openRows.length).toBeGreaterThan(0);
    expect(openRows.every((row) => row.status === 'open')).toBe(true);

    const unassigned = await platform('get', '/platform/tickets?filter[assignedTo]=none&limit=50');
    const unassignedRows = unassigned.body.data as SupportTicket[];
    expect(unassignedRows.some((row) => row.id === urgentTicket.id)).toBe(true);

    const byPriority = await platform('get', '/platform/tickets?filter[priority]=urgent&limit=50');
    expect((byPriority.body.data as SupportTicket[]).every((row) => row.priority === 'urgent')).toBe(true);

    const bogus = await platform('get', '/platform/tickets?filter[severity]=high');
    expect(bogus.status).toBe(400);
  });

  it('يسند التذكرة ويسمّي المكلَّف، ويسحب الإسناد بـ`null`', async () => {
    const ticket = (await openTicket({ priority: 'low', subject: 'استفسار عن التقرير' })).body
      .data as TicketDetail;

    const assigned = await platform('patch', `/platform/tickets/${ticket.id}`, {
      assignedTo: owner.userId,
      category: 'تقارير',
      reason: 'إسنادٌ لمشغّل',
    });
    const afterAssign = assigned.body.data as TicketDetail;
    expect(afterAssign.assignedTo).toBe(owner.userId);
    expect(afterAssign.assignedToLabel).toBeTruthy();
    expect(afterAssign.category).toBe('تقارير');

    const cleared = await platform('patch', `/platform/tickets/${ticket.id}`, {
      assignedTo: null,
      reason: 'سحب الإسناد',
    });
    expect((cleared.body.data as TicketDetail).assignedTo).toBeNull();
  });

  it('يدخل مؤقّتاً بعين مالك المنشأة: رمزٌ يحمل imp وعمره لا يزيد على الجلسة', async () => {
    const started = await platform('post', '/platform/impersonate', {
      tenantId: customerA.tenantId,
      reason: 'طلب العميل مراجعة إعداد الطباعة معه',
      minutes: 5,
    });
    expect(started.status).toBe(201);
    const result = started.body.data as {
      session: ImpersonationSession;
      accessToken: string;
      expiresIn: number;
    };
    expect(result.expiresIn).toBe(300);
    expect(result.session.status).toBe('active');
    expect(result.session.operatorUserId).toBe(owner.userId);

    const claims = decode(result.accessToken);
    expect(typeof claims.imp).toBe('string');
    expect(claims.sub).toBe(customerA.userId); // بعين العميل، لا بهوية المشغّل
    expect(claims.tid).toBe(customerA.tenantId);
    expect(Number(claims.exp) - Number(claims.iat)).toBeLessThanOrEqual(300);
    expect(claims.pam).toBeUndefined();
    expect(claims.proles).toBeUndefined();

    // الشاشة تعرف أنها داخل جلسة دعم من `GET /me` وحده.
    const me = await api(ctx.server, 'get', `${base}/me`, { token: result.accessToken });
    expect(me.status).toBe(200);
    const impersonation = (me.body.data as { impersonation: { sessionId: string; reason: string } | null })
      .impersonation;
    expect(impersonation?.sessionId).toBe(result.session.id);
    expect(impersonation?.reason).toContain('إعداد الطباعة');

    const own = await api(ctx.server, 'get', `${base}/me`, { token: customerA.token });
    expect((own.body.data as { impersonation: unknown }).impersonation).toBeNull();
  });

  it('الدخول المؤقّت يقرأ ويعمل في العمل اليومي، ولا يحذف ولا يمسّ المصادقة', async () => {
    const started = await platform('post', '/platform/impersonate', {
      tenantId: customerA.tenantId,
      reason: 'مراجعة الأصناف مع العميل على الهاتف',
      minutes: 10,
    });
    const token = (started.body.data as { accessToken: string }).accessToken;

    // العمل اليومي مسموح: قائمةٌ حقيقية في سياق العميل.
    const parties = await api(ctx.server, 'get', `${base}/parties?limit=5`, { token });
    expect(parties.status).toBe(200);

    // الحذف ممنوع كلّه — والقرار في الحارس قبل أن يصل الطلب إلى أي متحكّم.
    const removed = await api(ctx.server, 'delete', `${base}/parties/00000000-0000-0000-0000-000000000000`, {
      token,
    });
    expect(removed.status).toBe(403);
    expect((removed.body.errors as Array<{ reason?: string }> | undefined)?.[0]?.reason).toBe(
      'IMPERSONATION_NO_DELETE',
    );

    // المصادقة ممنوعة: لا كلمة مرور جديدة باسم العميل.
    const password = await api(ctx.server, 'post', `${base}/auth/change-password`, {
      token,
      body: { currentPassword: 'x', newPassword: 'y' },
    });
    expect(password.status).toBe(403);
    expect((password.body.errors as Array<{ reason?: string }> | undefined)?.[0]?.reason).toBe(
      'IMPERSONATION_AUTH_BLOCKED',
    );
  });

  it('إنهاء الجلسة يُسقط الرمز من الطلب التالي لا عند انتهاء صلاحيته', async () => {
    const started = await platform('post', '/platform/impersonate', {
      tenantId: customerB.tenantId,
      reason: 'متابعة تذكرة الفاتورة مع العميل الثاني',
      minutes: 15,
    });
    const result = started.body.data as { session: ImpersonationSession; accessToken: string };

    expect((await api(ctx.server, 'get', `${base}/me`, { token: result.accessToken })).status).toBe(200);

    const ended = await platform('delete', `/platform/impersonate/${result.session.id}`);
    expect(ended.status).toBe(200);
    expect((ended.body.data as ImpersonationSession).status).toBe('ended');
    expect((ended.body.data as ImpersonationSession).endedAt).not.toBeNull();

    const after = await api(ctx.server, 'get', `${base}/me`, { token: result.accessToken });
    expect(after.status).toBe(401);
    expect((after.body.errors as Array<{ reason?: string }> | undefined)?.[0]?.reason).toBe(
      'IMPERSONATION_ENDED',
    );
  });

  it('يرفض دخولاً بمدّةٍ فوق الساعة أو بسببٍ قصير، ويرفض منشأةً بلا مالكٍ نشط', async () => {
    const tooLong = await platform('post', '/platform/impersonate', {
      tenantId: customerA.tenantId,
      reason: 'مدّة أطول من السقف المسموح',
      minutes: IMPERSONATION_MAX_MINUTES + 30,
    });
    expect(tooLong.status).toBe(400);

    const shortReason = await platform('post', '/platform/impersonate', {
      tenantId: customerA.tenantId,
      reason: 'قصير',
      minutes: 10,
    });
    expect(shortReason.status).toBe(400);

    const ownerless = await platform('post', '/platform/impersonate', {
      tenantId: ownerlessTenantId,
      reason: 'منشأة بلا عضوية مالك نشطة',
      minutes: 10,
    });
    expect(ownerless.status).toBe(422);
  });

  it('يسرد جلسات الدعم بمن دخل ولماذا وحالتها', async () => {
    const listed = await platform('get', '/platform/impersonate/sessions');
    expect(listed.status).toBe(200);
    const sessions = listed.body.data as ImpersonationSession[];
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.some((session) => session.status === 'ended')).toBe(true);
    expect(sessions.some((session) => session.status === 'active')).toBe(true);
    expect(sessions[0].reason.length).toBeGreaterThan(9);
    expect(sessions[0].operatorLabel).toBeTruthy();
  });

  it('تذاكر العميل تُقرأ من سطح المنصة بلا تسرّبٍ بين المنشآت', async () => {
    const mine = await platform('get', `/platform/tenants/${customerA.tenantId}/tickets`);
    expect(mine.status).toBe(200);
    const rows = mine.body.data as SupportTicket[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.tenantId === customerA.tenantId)).toBe(true);

    const other = await platform('get', `/platform/tenants/${customerB.tenantId}/tickets`);
    expect((other.body.data as SupportTicket[]).some((row) => row.tenantId === customerA.tenantId)).toBe(
      false,
    );
  });

  it('المكتب لدور الدعم، وحدوده على مدقّقٍ أو فوترة، ولا صلاحيات منصة لرمز الدخول', async () => {
    // `platform_support` هو الدور الذي يعنيه هذا الرمز: يدير التذاكر.
    expect((await platform('get', '/platform/tickets', undefined, support)).status).toBe(200);

    // «منصّي» ليس «مخوّلاً»: المدقّق للقراءة، والفوترة لا تدخل باسم عميل.
    const auditTickets = await platform('get', '/platform/tickets', undefined, auditor);
    expect(auditTickets.status, JSON.stringify(auditTickets.body)).toBe(403);
    const auditSessions = await platform('get', '/platform/impersonate/sessions', undefined, auditor);
    expect(auditSessions.status, JSON.stringify(auditSessions.body)).toBe(403);

    const refused = await platform(
      'post',
      '/platform/impersonate',
      { tenantId: customerA.tenantId, reason: 'محاولة بدون رمز الدعم', minutes: 10 },
      billing,
    );
    expect(refused.status).toBe(403);

    // الرمز المُصدر بعين العميل لا يملك سطح المنصة: `imp` ليس `pam`.
    const started = await platform('post', '/platform/impersonate', {
      tenantId: customerA.tenantId,
      reason: 'قياس حدّ الصلاحيات للرمز المؤقّت',
      minutes: 5,
    });
    const token = (started.body.data as { accessToken: string }).accessToken;
    const asClient = await api(ctx.server, 'get', `${base}/platform/tickets`, { token });
    expect(asClient.status, JSON.stringify(asClient.body)).toBe(403);
  });

  it('كل فعلٍ في مكتب الدعم يترك صفّ تدقيقٍ باسم فاعله وسببه', async () => {
    const rows = await auditRows();
    const actions = rows.rows.map((row) => String(row.action));
    expect(actions).toContain('support.ticket.create');
    expect(actions).toContain('support.ticket.reply');
    expect(actions).toContain('support.impersonate.start');
    expect(actions).toContain('support.impersonate.end');

    const started = rows.rows.find((row) => row.action === 'support.impersonate.start');
    expect(String((started?.meta as Record<string, unknown>)?.reason ?? '')).toContain('إعداد الطباعة');
    expect(String(started?.entity)).toBe('support_session');
  });
});
