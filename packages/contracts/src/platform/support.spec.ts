import { describe, expect, it } from 'vitest';

import { IMPERSONATION_MAX_MINUTES } from './support.js';
import {
  IMPERSONATION_MIN_MINUTES,
  IMPERSONATION_TOKEN_CLAIM,
  TICKET_FILTERS,
  impersonationBlockedPaths,
  impersonationSessionSchema,
  impersonationStartResultSchema,
  impersonationStartSchema,
  impersonationStatuses,
  supportAuditActions,
  ticketAuthorKinds,
  ticketCreateSchema,
  ticketDetailSchema,
  ticketMessageSchema,
  ticketOpenStatuses,
  ticketPriorities,
  ticketReplySchema,
  ticketSlaHours,
  ticketStatuses,
  ticketUpdateSchema,
} from './support.js';

/**
 * عقد مكتب الدعم والدخول المؤقّت (P-C8). ما يُختبَر هنا **ما لا يحتاج قاعدة**: الحدود
 * المفروضة على المشغّل (مدّة · سبب · رمز)، ومعنى `null` في التعديل، والفهارس التي
 * يتّفق عليها الحارس والشاشة والسكربت. أما السلوك (مهلةٌ تُحسب · ردٌّ داخليّ لا يُرسل ·
 * رمزٌ يسقط فور الإنهاء) ففي `apps/api/test/platform-support.spec.ts` وحيّاً في
 * `scripts/verify-platform-support.mjs`.
 */

const tenantId = '0198f3c2-3d5b-7c9e-9a11-6f2e0f1c4a10';
const operatorId = '0198f3c2-3d5b-7c9e-9a11-6f2e0f1c4a11';

const newTicket = {
  tenantId,
  subject: 'فاتورةٌ لا تُصدَر',
  body: 'العميل يقول إن زرّ الإصدار يعيد خطأً عند الضغط عليه.',
  reason: 'بلاغٌ هاتفي من العميل',
};

const newSession = {
  tenantId,
  reason: 'نرى الشاشة التي يشتكي منها العميل',
};

describe('support desk contract (P-C8)', () => {
  it('freezes the enumerations and the filters the plan lists', () => {
    expect(ticketStatuses).toEqual(['open', 'pending', 'resolved', 'closed']);
    expect(ticketPriorities).toEqual(['low', 'normal', 'high', 'urgent']);
    expect(ticketAuthorKinds).toEqual(['operator', 'customer', 'system']);
    expect(TICKET_FILTERS).toEqual(['status', 'priority', 'tenantId', 'assignedTo']);
    expect(impersonationStatuses).toEqual(['active', 'ended', 'expired']);
  });

  it('puts the SLA in the priority: higher priority means a shorter deadline', () => {
    expect(ticketSlaHours).toEqual({ urgent: 1, high: 4, normal: 24, low: 72 });
    expect(ticketSlaHours.urgent).toBeLessThan(ticketSlaHours.high);
    expect(ticketSlaHours.high).toBeLessThan(ticketSlaHours.normal);
    expect(ticketSlaHours.normal).toBeLessThan(ticketSlaHours.low);
    // «مفتوحة» تعني أن المهلة ما زالت تُحسب؛ المقفلة ليست كذلك.
    expect(ticketOpenStatuses).toEqual(['open', 'pending']);
  });

  it('takes a ticket with a written first message and a reason', () => {
    const parsed = ticketCreateSchema.parse(newTicket);
    expect(parsed.priority).toBe('normal');
    expect(parsed.category).toBeUndefined();
    expect(parsed.assignedTo).toBeUndefined();
    // بلا سببٍ لا يُعرف لاحقاً **لماذا** فُتحت التذكرة.
    expect(ticketCreateSchema.safeParse({ ...newTicket, reason: '' }).success).toBe(false);
    expect(ticketCreateSchema.safeParse({ ...newTicket, subject: 'لا' }).success).toBe(false);
    expect(ticketCreateSchema.safeParse({ ...newTicket, body: 'قصير' }).success).toBe(false);
    expect(ticketCreateSchema.safeParse({ ...newTicket, priority: 'critical' }).success).toBe(false);
    expect(ticketCreateSchema.safeParse({ ...newTicket, tenantId: 'demo' }).success).toBe(false);
    // حقلٌ غير معلَن يُرفض: لا كتابة صامتة إلى عمودٍ لم يوافق عليه العقد.
    expect(ticketCreateSchema.safeParse({ ...newTicket, closedAt: new Date().toISOString() }).success).toBe(
      false,
    );
  });

  it('treats null in a ticket update as «clear» and requires the reason', () => {
    const cleared = ticketUpdateSchema.parse({ assignedTo: null, category: null, reason: 'سحب الإسناد' });
    expect(cleared.assignedTo).toBeNull();
    expect(cleared.category).toBeNull();

    expect(ticketUpdateSchema.parse({ status: 'closed', reason: 'حُلّت هاتفياً' }).status).toBe('closed');
    expect(ticketUpdateSchema.parse({ assignedTo: operatorId, reason: 'توزيع داخلي' }).assignedTo).toBe(
      operatorId,
    );
    expect(ticketUpdateSchema.safeParse({ status: 'closed' }).success).toBe(false);
    expect(ticketUpdateSchema.safeParse({ status: 'closed', reason: 'حُلّت هاتفياً', priority: 'urgent' }).success).toBe(
      true,
    );
    expect(ticketUpdateSchema.safeParse({ nothing: true, reason: 'تعديلٌ بلا حقل' }).success).toBe(false);
  });

  it('defaults a reply to public and an internal note to «stays here»', () => {
    expect(ticketReplySchema.parse({ body: 'شكراً لتواصلك' }).isInternal).toBe(false);
    expect(ticketReplySchema.parse({ body: 'ننتظر ردّ العميل', isInternal: true }).isInternal).toBe(true);
    expect(ticketReplySchema.safeParse({ body: 'شكراً لتواصلك', isInternal: true, customerVisible: true }).success).toBe(
      false,
    );
    expect(ticketReplySchema.safeParse({ body: '' }).success).toBe(false);
  });

  it('keeps the temporary access bounded: 5–60 minutes and a reason of 10 characters', () => {
    expect(impersonationStartSchema.parse(newSession).minutes).toBe(30);
    expect(impersonationStartSchema.safeParse({ ...newSession, minutes: IMPERSONATION_MIN_MINUTES }).success).toBe(
      true,
    );
    expect(impersonationStartSchema.safeParse({ ...newSession, minutes: IMPERSONATION_MAX_MINUTES }).success).toBe(
      true,
    );
    // السقف مطلق: لا مدّةً أطول مهما طلب المشغّل، ولا جلسةً بلا سببٍ مقروء للعميل.
    expect(impersonationStartSchema.safeParse({ ...newSession, minutes: IMPERSONATION_MAX_MINUTES + 1 }).success).toBe(
      false,
    );
    expect(impersonationStartSchema.safeParse({ ...newSession, minutes: IMPERSONATION_MIN_MINUTES - 1 }).success).toBe(
      false,
    );
    expect(impersonationStartSchema.safeParse({ ...newSession, reason: 'لمشكلة' }).success).toBe(false);
    expect(impersonationStartSchema.safeParse({ ...newSession, tenantId: null }).success).toBe(false);
    expect(impersonationStartSchema.safeParse({ ...newSession, readOnly: false }).success).toBe(false);
  });

  it('answers a start with the session **and** the token', () => {
    const result = impersonationStartResultSchema.parse({
      session: {
        id: '0198f3c2-3d5b-7c9e-9a11-6f2e0f1c4a12',
        tenantId,
        tenantCode: 'demo',
        tenantName: 'شركة تجريبية',
        operatorUserId: operatorId,
        operatorLabel: 'مشغّل الدعم (support@platform.test)',
        reason: newSession.reason,
        startedAt: '2026-09-17T09:00:00.000Z',
        expiresAt: '2026-09-17T09:30:00.000Z',
        endedAt: null,
        status: 'active',
        asUserLabel: 'مالك المنشأة',
      },
      accessToken: 'header.payload.signature',
      expiresIn: 1800,
    });
    expect(result.session.status).toBe('active');
    expect(result.expiresIn).toBe(1800);
    // جلسةٌ منتهية تحمل وقت إنهائها — الحالتان لا تجتمعان على صفٍّ واحد في الشاشة.
    expect(
      impersonationSessionSchema.safeParse({
        ...result.session,
        status: 'ended',
        endedAt: '2026-09-17T09:20:00.000Z',
      }).success,
    ).toBe(true);
    expect(impersonationStartResultSchema.safeParse({ session: result.session, accessToken: '' }).success).toBe(
      false,
    );
    expect(
      impersonationStartResultSchema.safeParse({ ...result, expiresIn: 0 }).success,
    ).toBe(false);
  });

  it('writes the boundaries themselves into the contract', () => {
    expect(IMPERSONATION_TOKEN_CLAIM).toBe('imp');
    expect(impersonationBlockedPaths).toEqual(['/auth/']);
    expect(Object.values(supportAuditActions)).toEqual([
      'support.ticket.create',
      'support.ticket.update',
      'support.ticket.reply',
      'support.impersonate.start',
      'support.impersonate.end',
    ]);
  });

  it('describes a ticket with its thread', () => {
    const message = ticketMessageSchema.parse({
      id: '0198f3c2-3d5b-7c9e-9a11-6f2e0f1c4a13',
      ticketId: '0198f3c2-3d5b-7c9e-9a11-6f2e0f1c4a14',
      authorUserId: null,
      authorLabel: null,
      authorKind: 'system',
      body: 'أُغلقت التذكرة تلقائياً.',
      isInternal: false,
      createdAt: '2026-09-17T09:10:00.000Z',
    });
    expect(message.authorKind).toBe('system');
    expect(message.isInternal).toBe(false);

    const detail = ticketDetailSchema.parse({
      id: '0198f3c2-3d5b-7c9e-9a11-6f2e0f1c4a14',
      tenantId,
      tenantCode: 'demo',
      tenantName: 'شركة تجريبية',
      subject: newTicket.subject,
      status: 'pending',
      priority: 'high',
      category: 'billing',
      assignedTo: operatorId,
      assignedToLabel: 'مشغّل الدعم',
      openedByLabel: 'مالك المنشأة',
      createdAt: '2026-09-17T09:00:00.000Z',
      updatedAt: '2026-09-17T09:10:00.000Z',
      firstResponseAt: '2026-09-17T09:05:00.000Z',
      resolvedAt: null,
      closedAt: null,
      slaDueAt: '2026-09-17T13:00:00.000Z',
      messageCount: 2,
      lastMessageAt: '2026-09-17T09:10:00.000Z',
      messages: [message],
    });
    expect(detail.messages).toHaveLength(1);
    // التفصيل بلا رسائل ليس تفصيلاً — الرسالة الأولى تُكتب لحظة الفتح.
    expect(ticketDetailSchema.safeParse({ ...detail, messages: 'لا شيء' }).success).toBe(false);
    // الإغلاق والوقت يمضيان معاً: `closed` بلا وقتٍ إغلاق صفٌّ متناقض.
    expect(detail.closedAt).toBeNull();
  });
});
