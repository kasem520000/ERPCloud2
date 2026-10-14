import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withOwnerClient } from '@erp/testing';

import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * AUD-14 — إسناد سجل تدقيق الويبهوك إلى المستأجر.
 *
 * `AuditInterceptor` يكتب سجلّه بعد الطلب، وكان يأخذ المستأجر من `context.tenant` وحده.
 * المسارات العامّة (webhook) لا سياق مصادقة لها، فكان السجلّ يُكتب بـ`tenant_id = null`
 * رغم أن الخدمة عرفت المستأجر من السرّ/التوقيع. الآن الخدمة تُعلنه عبر
 * `setAuditTenantId` فيُنسب السجلّ، **بعد** التحقّق فقط.
 *
 * تُثبت المواصفة: تسليمٌ صحيح يخلّف سجلاً واحداً مربوطاً بالمستأجر مع actor = null
 * (لا مستخدم خلف الطلب — موثَّق)، والحمولة المُخزَّنة لا تحمل السرّ، وتسليم مرفوض
 * (رمز خاطئ) **لا** يخلّف سجلاً، والتسليم المكرّر يبقى منسوباً لا مجهولاً.
 */

describe('AUD-14 — إسناد تدقيق الويبهوك', () => {
  let ctx: TestApp;
  let actor: Actor;
  const token = 'wh-token-audit14-0123456789abcdef';

  const auditRows = () =>
    withOwnerClient(ctx.db.ownerUrl, async (client) => {
      const result = await client.query(
        `SELECT id, tenant_id, actor_user_id, action, entity, after, meta
           FROM audit_log
          WHERE (meta->>'path') LIKE 'crm/webhooks%'
          ORDER BY created_at DESC`,
      );
      return result.rows as Array<{
        id: string;
        tenant_id: string | null;
        actor_user_id: string | null;
        action: string;
        entity: string;
        after: unknown;
        meta: Record<string, unknown>;
      }>;
    });

  const deliver = (body: Record<string, unknown>, secret = token) =>
    api(ctx.server, 'post', `/api/v1/crm/webhooks/whatsapp?token=${encodeURIComponent(secret)}`, { body });

  beforeAll(async () => {
    ctx = await createTestApp('audit-webhook-audit');
    actor = await createActor(ctx, {
      tenantCode: 'audit-webhook-audit',
      email: 'owner@audit-webhook-audit.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'crm.deals.manage'],
    });

    await withOwnerClient(ctx.db.ownerUrl, async (client) => {
      await client.query(
        `INSERT INTO crm_settings (tenant_id, webhook_token) VALUES ($1, $2)
         ON CONFLICT (tenant_id) DO UPDATE SET webhook_token = EXCLUDED.webhook_token`,
        [actor.tenantId, token],
      );
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('تسليم صحيح: سجلٌ واحد مربوطٌ بالمستأجر، actor = null موثَّق، ولا سرّ في الحمولة', async () => {
    const response = await deliver({ from: '+966500000000', text: 'مرحباً' });
    expect([200, 201]).toContain(response.status);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenant_id, 'the audit row must belong to the tenant the secret resolved').toBe(actor.tenantId);
    expect(rows[0]!.actor_user_id, 'no user is behind a provider webhook').toBeNull();
    expect(rows[0]!.entity).toBe('crm');

    // الحمولة المخزَّنة هي استجابة المعالج، لا جسم الطلب الخام: لا سرّ ولا هاتف خام.
    const stored = JSON.stringify(rows[0]!.after);
    expect(stored).not.toContain(token);
    expect(JSON.stringify(rows[0]!.meta)).not.toContain(token);
  });

  it('رمز خاطئ: 401 ولا سجل تدقيق — الرفض لا يُنسب إلى أحد', async () => {
    const before = (await auditRows()).length;
    const response = await deliver({ from: '+966500000001', text: 'x' }, 'wrong-token');
    expect(response.status).toBe(401);
    expect((await auditRows()).length).toBe(before);
  });

  it('تسليم مكرَّر: يبقى منسوباً (سجلّان اثنان، لا null)', async () => {
    const before = (await auditRows()).length;
    await deliver({ from: '+966500000002', text: 'أول' });
    await deliver({ from: '+966500000002', text: 'ثانٍ' });

    const rows = await auditRows();
    expect(rows.length).toBe(before + 2);
    expect(rows.slice(0, 2).every((row) => row.tenant_id === actor.tenantId)).toBe(true);
  });

  it('مستأجر آخر لا يرى ولا ينسب: رمزه الخاص يكتب سجله هو', async () => {
    const other = await createActor(ctx, {
      tenantCode: 'audit-webhook-audit-b',
      email: 'owner@audit-webhook-audit-b.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'crm.deals.manage'],
    });
    const otherToken = 'wh-token-audit14-b-0123456789abcdef';
    await withOwnerClient(ctx.db.ownerUrl, async (client) => {
      await client.query(
        `INSERT INTO crm_settings (tenant_id, webhook_token) VALUES ($1, $2)
         ON CONFLICT (tenant_id) DO UPDATE SET webhook_token = EXCLUDED.webhook_token`,
        [other.tenantId, otherToken],
      );
    });

    expect([200, 201]).toContain((await deliver({ from: '+966500000003', text: 'ب' }, otherToken)).status);
    const rows = await auditRows();
    expect(rows[0]!.tenant_id).toBe(other.tenantId);
    expect(rows.some((row) => row.tenant_id === actor.tenantId)).toBe(true);
  });
});
