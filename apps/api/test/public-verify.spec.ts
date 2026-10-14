import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { PUBLIC_VERIFY_SAMPLE_PAYLOAD, ZATCA_QR_PAYLOAD_MAX, type PublicVerifyResult } from '@erp/contracts';
import { auditLog, newId, withPlatformAdminTx } from '@erp/database';

import { createTenantFixture } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * P-M8 — «التحقّق العام من فاتورة» (`docs/roadmap/MARKETING_SITE_PLAN.md` §5 P-M8).
 *
 * وهذا المسار هو **الباب الوحيد في المنصّة الذي يقرأ بلا جلسة**، فالاختبارات هنا تقيس حدوده
 * لا شكله — وكل واحدٍ منها يحرس قراراً:
 *
 * 1. **الحُكم على الشكل أولاً** — حِملٌ لا يُقرأ لا يصل إلى القاعدة، والحُكم يفكّ الرمز بلا
 *    سجلّ (`record: null`) وبلا خطأ: «رمزٌ سليمٌ لا سجلّ له» نتيجة، وليست عطلاً.
 * 2. **الرمز هو التصريح** — المطابقة تامّة على الحِمل أو على رمز الفاتورة: لا بحث جزئي ولا
 *    تعداد، ومن لا يملك الرمز لا يستطيع السؤال.
 * 3. **ما يعود حالةٌ لا فاتورة** — الفاتورة المزروعة تحمل رقماً وإجمالياً يختلفان عن الرمز،
 *    ويُتحقَّق أن **لا واحداً منهما ظهر في الاستجابة** (ولا اسم المنشأة).
 * 4. **لا كتابة ولا أثر** — عدد صفوف `audit_log` لا يتغيّر بنداءٍ واحد ولا بعشرة، فالوحدة
 *    كلها قراءة.
 * 5. **لا «لم تُوجد»** — الطلب المفهوم يعود 200 دائماً (`record: null` حين لا سجلّ)؛ وما
 *    يعود 422 هو مدخلٌ لا يصلح للفحص أصلاً (لا حِمل ولا رمز، أو الاثنان معاً، أو مفتاحٌ غريب).
 * 6. **الحالة تُترجم لا تُخمَّن** — كل حالةٍ في القاعدة تعود بتسميتها وشرحها من جدول العقد،
 *    وما لا يعرفه الجدول يعود `unknown` ولا يُخترع له معنى.
 *
 * والفاتورة تُزرع **قيداً مباشراً** (`sales_invoices`) كما يفعل سبيك التحليلات: مسار البيع
 * الكامل (ترحيل ثم إرسالٌ ضريبي) مقيسٌ في سبيك المبيعات والفاتورة الإلكترونية، وما يُقاس هنا
 * أن `zatca_status` و`zatca_qr` و`zatca_uuid` تُقرأ صحيحاً وتُرجع حالةً وحدها.
 */
describe('public invoice verification (P-M8)', () => {
  let ctx: TestApp;
  let tenantId: string;
  let tenantCode: string;

  const VERIFY = '/api/v1/public/verify';
  const post = (body: unknown) => api(ctx.server, 'post', VERIFY, { body });
  const verify = async (body: unknown): Promise<PublicVerifyResult> => {
    const response = await post(body);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (response.body as { data: PublicVerifyResult }).data;
  };

  /** فاتورةٌ مرحَّلة بفرعها — الفرع الافتراضي يُنشأ إن غاب (وهو ما تفعله سبيك التحليلات). */
  const seedInvoice = async (options: {
    qr?: string | null;
    uuid?: string | null;
    zatcaStatus?: string | null;
    number?: string;
    total?: string;
  }): Promise<string> => {
    // الرقم فريدٌ لكل منشأة (`sales_invoices_tenant_number_key`)، فكل زرعٍ يأخذ رقماً جديداً
    // إلا حيث يكون الرقم نفسه هو المقيس (اختبار التسريب).
    const number = options.number ?? `INV-${Math.random().toString(36).slice(2, 10)}`;
    return withPlatformAdminTx(ctx.handle.db, async (tx) => {
      const branch = (
        await tx.execute(sql`SELECT id FROM branches WHERE tenant_id = ${tenantId}::uuid LIMIT 1`)
      ).rows[0] as { id: string } | undefined;
      const branchId =
        branch?.id ??
        ((
          await tx.execute(sql`
            INSERT INTO branches (id, tenant_id, code, name_ar, is_default)
            VALUES (${newId()}, ${tenantId}::uuid, 'b-verify', 'فرع التحقّق', true)
            RETURNING id
          `)
        ).rows[0] as { id: string }).id;

      const invoiceId = newId();
      await tx.execute(sql`
        INSERT INTO sales_invoices (id, tenant_id, branch_id, kind, status, number, currency,
                                    subtotal, tax_total, total, posted_at, zatca_status, zatca_qr, zatca_uuid, updated_at)
        VALUES (${invoiceId}, ${tenantId}::uuid, ${branchId}::uuid, 'sale', 'posted',
                ${number}, 'SAR', ${options.total ?? '999.99'}, 130.43, ${options.total ?? '999.99'},
                now(), ${options.zatcaStatus ?? null}, ${options.qr ?? null},
                ${options.uuid ?? null}::uuid, now())
      `);
      return invoiceId;
    });
  };

  const auditRows = () =>
    withPlatformAdminTx(ctx.handle.db, (tx) => tx.select({ id: auditLog.id }).from(auditLog)).then(
      (rows) => rows.length,
    );

  beforeAll(async () => {
    ctx = await createTestApp('public-verify');
    const tenant = await createTenantFixture(ctx.db.ownerUrl, { code: 'verify-tenant', name: 'شركة التحقّق المحدودة' });
    tenantId = tenant.id;
    tenantCode = tenant.code;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('حِملٌ سليم بلا سجلّ: يُقرأ ويُحكم عليه ويُقال «لا سجلّ» بلا خطأ', async () => {
    const result = await verify({ payload: PUBLIC_VERIFY_SAMPLE_PAYLOAD });

    expect(result.valid).toBe(true);
    expect(result.record).toBeNull();
    // الحقول هي حقول الرمز نفسه — لا شيء من القاعدة.
    expect(result.fields?.sellerName.length).toBeGreaterThan(0);
    expect(result.fields?.vatNumber).toMatch(/^\d{15}$/);
    // الفحوص الخمسة تُعاد مع الحُكم، ولا حُكم بلا سبب.
    expect(result.checks.map((check) => check.code)).toEqual(
      expect.arrayContaining(['vat_number', 'timestamp', 'totals', 'signature']),
    );
    expect(result.verdictAr).toContain('لا سجل');
    expect(result.authorityNoteAr).toContain('فاتورة');
    expect(result.tags?.length).toBeGreaterThan(0);
  });

  it('مطابقة الحِمل تُعيد حالة الفاتورة وحدها — لا رقماً ولا إجمالياً ولا اسم منشأة', async () => {
    await seedInvoice({ qr: PUBLIC_VERIFY_SAMPLE_PAYLOAD, zatcaStatus: 'cleared', number: 'INV-SECRET-1' });

    const response = await post({ payload: PUBLIC_VERIFY_SAMPLE_PAYLOAD });
    const result = (response.body as { data: PublicVerifyResult }).data;

    expect(result.record?.matchedBy).toBe('payload');
    expect(result.record?.status).toBe('cleared');
    expect(result.record?.statusLabelAr).toBe('مخلَّصة لدى زاتكا');
    expect(result.record?.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // تاريخ الحالة لا تاريخ الفاتورة

    // الحدّ الأهمّ: ما في القاعدة لا يتسرّب. الرقم والإجمالي والمنشأة مزروعة كلها بقيمٍ
    // مختلفة عن الرمز، فظهور أيٍّ منها نصّاً في الجسم = تسريب.
    const body = JSON.stringify(response.body);
    expect(body).not.toContain('INV-SECRET-1');
    expect(body).not.toContain('999.99');
    expect(body).not.toContain(tenantCode);
    expect(body).not.toContain('التحقّق المحدودة');
  });

  it('حشو `=` في الطرف لا يُسقط المطابقة (بعض قارئات QR تُسقطه)', async () => {
    const padded = PUBLIC_VERIFY_SAMPLE_PAYLOAD.endsWith('=') ? PUBLIC_VERIFY_SAMPLE_PAYLOAD : `${PUBLIC_VERIFY_SAMPLE_PAYLOAD}=`;
    const unpadded = PUBLIC_VERIFY_SAMPLE_PAYLOAD.replace(/=+$/, '');

    const withPadding = await verify({ payload: padded });
    const stripped = await verify({ payload: unpadded });

    expect(withPadding.record?.status).toBe('cleared');
    expect(stripped.record?.status).toBe('cleared');
  });

  it('رمز الفاتورة (UUID) يبحث بحقلٍ آخر: بلا حقول رمز، وبحالته وشرحها', async () => {
    const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    await seedInvoice({ uuid, zatcaStatus: 'voided:customer-request', number: 'INV-VOID-1' });

    const result = await verify({ uuid });

    expect(result.fields).toBeNull();
    expect(result.tags).toBeNull();
    expect(result.record?.matchedBy).toBe('uuid');
    expect(result.record?.status).toBe('voided');
    expect(result.record?.statusLabelAr).toBe('ملغاة في المنصّة');
    expect(result.verdictEn.length).toBeGreaterThan(0);
  });

  it('حالات القاعدة تُترجم من جدول العقد — وما لا يعرفه الجدول لا يُخترع له معنى', async () => {
    const uuidPrepared = '11111111-2222-3333-4444-555555555555';
    const uuidUnknown = '66666666-7777-8888-9999-000000000000';
    await seedInvoice({ uuid: uuidPrepared, zatcaStatus: 'prepared' });
    await seedInvoice({ uuid: uuidUnknown, zatcaStatus: 'state-we-invented-tomorrow' });
    await seedInvoice({ uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', zatcaStatus: null });

    const prepared = await verify({ uuid: uuidPrepared });
    const unknown = await verify({ uuid: uuidUnknown });
    const empty = await verify({ uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });

    expect(prepared.record?.status).toBe('prepared');
    expect(prepared.record?.explanationAr).toContain('simulation');
    expect(unknown.record?.status).toBe('unknown');
    expect(unknown.record?.statusLabelAr).toBe('حالة غير معروفة');
    expect(empty.record?.status).toBe('unknown');
  });

  it('حِملٌ لا يُقرأ: حُكمٌ بالعطب بلا استعلام ولا سجلّ', async () => {
    const junk = await verify({ payload: '!!!-ليس-رمزاً-على-الإطلاق-!!!' });
    expect(junk.valid).toBe(false);
    expect(junk.fields).toBeNull();
    expect(junk.record).toBeNull();
    expect(junk.checks).toHaveLength(0);
    expect(junk.verdictAr).toContain('لم يُتحقّق من أي سجلّ');

    // رمزٌ مقطوع: حِملٌ سليم تُقتطع منه بضعة أحرف.
    const truncated = await verify({ payload: PUBLIC_VERIFY_SAMPLE_PAYLOAD.slice(0, PUBLIC_VERIFY_SAMPLE_PAYLOAD.length - 8) });
    expect(truncated.valid).toBe(false);
    expect(truncated.record).toBeNull();
  });

  it('مدخلٌ لا يصلح للفحص ⇒ 400: لا حِمل ولا رمز · الاثنان معاً · مفتاحٌ غريب · حِملٌ أطول من الحدّ', async () => {
    const none = await post({});
    const both = await post({ payload: PUBLIC_VERIFY_SAMPLE_PAYLOAD, uuid: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' });
    const extraKey = await post({ payload: PUBLIC_VERIFY_SAMPLE_PAYLOAD, invoiceNumber: 'INV-1' });
    const tooLong = await post({ payload: 'A'.repeat(ZATCA_QR_PAYLOAD_MAX + 1) });
    const badUuid = await post({ uuid: 'ليس-رمزاً' });

    for (const response of [none, both, extraKey, tooLong, badUuid]) {
      // 400 لا 422: هذه مخالفةُ *مدخل* يحكمها `ZodValidationPipe`، والـ422 في هذا المستودع
      // محفوظة لقاعدةٍ تجاريّة مرفوضة (قرارٌ لا صيغة).
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    }
  });

  it('بلا رمز صلاحية وبلا كتابة أثر: قراءةٌ لا تُدقَّق ولا تُسجَّل', async () => {
    const before = await auditRows();

    // بلا `Authorization` أصلاً — وهذا مقصود: المسار عامّ.
    const first = await post({ payload: PUBLIC_VERIFY_SAMPLE_PAYLOAD });
    for (let index = 0; index < 3; index += 1) {
      await post({ payload: PUBLIC_VERIFY_SAMPLE_PAYLOAD });
    }
    const second = await post({ payload: PUBLIC_VERIFY_SAMPLE_PAYLOAD });

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await auditRows()).toBe(before);
  });
});
