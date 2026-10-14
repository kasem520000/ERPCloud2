import { describe, expect, it } from 'vitest';

import {
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
  WEBHOOK_TEST_EVENT,
  apiKeyCreateSchema,
  apiKeyRevokeSchema,
  apiKeyRotateSchema,
  apiKeyScopes,
  developerAuditActions,
  developerCatalogueSchema,
  webhookEndpointCreateSchema,
  webhookEndpointUpdateSchema,
  webhookEvents,
  webhookUrlSchema,
} from './developer.js';

/**
 * P-C11 — اختبارات العقود.
 *
 * القاعدة هنا: **ما لا يُقاس في العقد يُخترع في الواجهة**. فالنطاقات والأحداث تُقاس
 * كقوائم مغلقة (لا سلسلةً حرّة تُقبل وتُرفض لاحقاً في الخدمة)، والعنوان يُقاس من الجهتين
 * (`https` يُقبل، و`http` العامّ يُرفض، و`localhost` يُستثنى صراحةً)، والسرّ يُقاس بأنه
 * سلسلةٌ طويلة لا تُكتب في العقد أصلاً (المحفوظ بصمة — يُقاس ذلك في سبيك الـAPI الحيّ).
 */
describe('platform developer contracts (P-C11)', () => {
  describe('catalogue lists', () => {
    it('declares eight scopes, none of them a console code', () => {
      expect(apiKeyScopes).toHaveLength(8);
      expect(apiKeyScopes.every((scope) => !scope.startsWith('console.'))).toBe(true);
      expect(apiKeyScopes).toContain('invoices:read');
      expect(apiKeyScopes).toContain('invoices:write');
      expect(apiKeyScopes).toContain('inventory:write');
      expect(apiKeyScopes).toContain('reporting:read');
    });

    it('declares the nine subscribable events, and the test event is not one of them', () => {
      expect(webhookEvents).toHaveLength(9);
      expect(webhookEvents).toContain('invoice.posted');
      expect(webhookEvents).toContain('invoice.paid');
      expect(webhookEvents).toContain('invoice.voided');
      expect(webhookEvents).toContain('stock.below_reorder');
      expect(webhookEvents).toContain('einvoice.submission_failed');
      expect(webhookEvents).toContain('shift.closed');
      expect(webhookEvents).toContain('subscription.activated');
      expect(webhookEvents).toContain('subscription.plan_changed');
      expect(webhookEvents).toContain('subscription.suspended');
      // حدثُ الاختبار يُرسل من الزرّ ولا يُشترَك به: خانةٌ تُشترى ولا تأتي أسوأ من غيابها.
      expect(WEBHOOK_TEST_EVENT).toBe('webhook.test');
      expect(webhookEvents).not.toContain(WEBHOOK_TEST_EVENT);
    });

    it('pins the signature format the receiver verifies', () => {
      expect(WEBHOOK_SIGNATURE_HEADER).toBe('x-erp-signature');
      expect(WEBHOOK_SIGNATURE_TOLERANCE_SECONDS).toBe(300);
    });

    it('names every audit action with the platform prefix, once each', () => {
      const actions = Object.values(developerAuditActions);
      expect(actions).toHaveLength(8);
      expect(new Set(actions).size).toBe(8);
      expect(actions.every((action) => action.startsWith('platform.'))).toBe(true);
      expect(actions).toContain('platform.api-key.revoke');
      expect(actions).toContain('platform.webhook.retry');
    });
  });

  describe('webhookUrlSchema', () => {
    it('accepts https anywhere', () => {
      expect(webhookUrlSchema.safeParse('https://example.com/hooks/erp').success).toBe(true);
      expect(webhookUrlSchema.safeParse('https://example.com:8443/hooks?x=1').success).toBe(true);
    });

    it('accepts http on localhost only', () => {
      expect(webhookUrlSchema.safeParse('http://localhost:4000/hooks').success).toBe(true);
      expect(webhookUrlSchema.safeParse('http://127.0.0.1:4000/hooks').success).toBe(true);
      // والسبب مكتوب في العقد: الويب هوك يحمل بيانات عميل، والسرّ يمنع التزوير لا التنصّت.
      expect(webhookUrlSchema.safeParse('http://example.com/hooks').success).toBe(false);
      expect(webhookUrlSchema.safeParse('http://10.0.0.5/hooks').success).toBe(false);
      expect(webhookUrlSchema.safeParse('ftp://example.com/hooks').success).toBe(false);
      expect(webhookUrlSchema.safeParse('example.com/hooks').success).toBe(false);
    });
  });

  describe('apiKeyCreateSchema', () => {
    it('requires a real name and at least one scope, and knows no other field', () => {
      expect(apiKeyCreateSchema.safeParse({ name: 'تكامل المستودع', scopes: ['invoices:read'] }).success).toBe(true);
      expect(apiKeyCreateSchema.safeParse({ name: 'تك', scopes: ['invoices:read'] }).success).toBe(false);
      expect(apiKeyCreateSchema.safeParse({ name: 'تكامل المستودع', scopes: [] }).success).toBe(false);
      expect(apiKeyCreateSchema.safeParse({ name: 'تكامل المستودع', scopes: ['console.tenants.view'] }).success).toBe(
        false,
      );
      // `.strict()` مقصودة: مفتاحٌ يُنشأ بنطاقٍ لم يُطلَب أخطر من فشلٍ يقول السبب.
      expect(
        apiKeyCreateSchema.safeParse({ name: 'تكامل المستودع', scopes: ['invoices:read'], scopesExtra: true }).success,
      ).toBe(false);
    });

    it('bounds the expiry: a day at least, ten years at most, null for none', () => {
      const base = { name: 'تكامل المستودع', scopes: ['invoices:read'] as const };
      expect(apiKeyCreateSchema.safeParse({ ...base, expiresInDays: 1 }).success).toBe(true);
      expect(apiKeyCreateSchema.safeParse({ ...base, expiresInDays: 3650 }).success).toBe(true);
      expect(apiKeyCreateSchema.safeParse({ ...base, expiresInDays: null }).success).toBe(true);
      expect(apiKeyCreateSchema.safeParse({ ...base, expiresInDays: 0 }).success).toBe(false);
      expect(apiKeyCreateSchema.safeParse({ ...base, expiresInDays: 3651 }).success).toBe(false);
    });

    it('demands a stated reason to revoke, and a shorter one to rotate', () => {
      expect(apiKeyRevokeSchema.safeParse({ reason: 'تسرّب المفتاح إلى مستودع عام' }).success).toBe(true);
      expect(apiKeyRevokeSchema.safeParse({ reason: 'ضاع' }).success).toBe(false);
      // التدوير بلا سبب مقبول (الأسباب الشائعة: دورانٌ دوري)، ومعه يُكتب في التدقيق.
      expect(apiKeyRotateSchema.safeParse({}).success).toBe(true);
      expect(apiKeyRotateSchema.safeParse({ reason: 'دوران دوري كل تسعين يوماً' }).success).toBe(true);
      expect(apiKeyRotateSchema.safeParse({ reason: 'ضاع' }).success).toBe(false);
    });
  });

  describe('webhook endpoint schemas', () => {
    const url = 'https://example.com/hooks';

    it('requires at least one known event on create', () => {
      expect(webhookEndpointCreateSchema.safeParse({ url, events: ['invoice.posted'] }).success).toBe(true);
      expect(webhookEndpointCreateSchema.safeParse({ url, events: [] }).success).toBe(false);
      expect(webhookEndpointCreateSchema.safeParse({ url, events: ['invoice.refunded'] }).success).toBe(false);
      expect(webhookEndpointCreateSchema.safeParse({ url, events: ['webhook.test'] }).success).toBe(false);
    });

    it('lets the update carry events, status or a description — and nothing else', () => {
      expect(webhookEndpointUpdateSchema.safeParse({ status: 'paused' }).success).toBe(true);
      expect(webhookEndpointUpdateSchema.safeParse({ events: ['shift.closed'] }).success).toBe(true);
      expect(webhookEndpointUpdateSchema.safeParse({ description: null }).success).toBe(true);
      expect(webhookEndpointUpdateSchema.safeParse({ status: 'disabled' }).success).toBe(false);
      expect(webhookEndpointUpdateSchema.safeParse({ events: [] }).success).toBe(false);
      // ومعرّف المنشأة لا يُقبل في الجسم: العنوان يُنسب إلى صاحب المسار لا إلى ما يُرسل.
      expect(webhookEndpointUpdateSchema.safeParse({ status: 'paused', tenantId: 'x' }).success).toBe(false);
    });
  });

  describe('developerCatalogueSchema', () => {
    it('accepts the shape the API returns and rejects a missing signature block', () => {
      const catalogue = {
        scopes: [...apiKeyScopes],
        events: [...webhookEvents],
        testEvent: WEBHOOK_TEST_EVENT,
        signature: { header: WEBHOOK_SIGNATURE_HEADER, algorithm: 'HMAC-SHA256', toleranceSeconds: 300 },
        retryBackoffSeconds: [60, 300, 1800],
      };
      expect(developerCatalogueSchema.safeParse(catalogue).success).toBe(true);
      expect(developerCatalogueSchema.safeParse({ ...catalogue, signature: undefined }).success).toBe(false);
      expect(developerCatalogueSchema.safeParse({ ...catalogue, scopes: ['invoices:read', 'nope'] }).success).toBe(
        false,
      );
    });
  });
});
