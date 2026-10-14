import { describe, expect, it } from 'vitest';

import {
  campaignBodyProblems,
  campaignCancelSchema,
  campaignClickUrl,
  campaignCreateSchema,
  campaignHyperlinks,
  campaignIsCancelable,
  campaignIsEditable,
  campaignMessageFooter,
  campaignMessageToken,
  campaignOpenUrl,
  campaignPatchSchema,
  campaignPeopleSegments,
  campaignScheduleSchema,
  campaignSegmentIsPeople,
  campaignSegmentRequiresConsent,
  campaignSegments,
  campaignStatuses,
  campaignTestSchema,
  campaignTransitionAllowed,
  campaignTransitions,
  campaignUnsubscribeUrl,
  campaignVariablesIn,
  renderCampaignMessage,
  renderCampaignText,
} from './campaigns.js';

/**
 * P-M7 — عقد الحملات البريدية. ما يُقاس هنا ما لا يحتاج قاعدة: الشرائح، والانتقالات،
 * وتصيير النصّ، وبناء الروابط، ومنعُ نصٍّ بلا طريقٍ للخروج. أما السلوك (إرسالٌ لشريحةٍ
 * حقيقية، وفتحٌ يُسجَّل، وإلغاءٌ يحجب) ففي `apps/api/test/platform-campaigns.spec.ts`.
 */
describe('campaign segments (P-M7)', () => {
  it('يفصل شرائحَ الأشخاص عن شرائح الحسابات', () => {
    expect(campaignSegments).toHaveLength(6);
    expect([...campaignPeopleSegments]).toEqual(['leads', 'subscribers']);
    // من اشترك أو وافق على التسويق: تسويقٌ مباشر. وصاحبُ الحساب: رسالةُ خدمةٍ عن حسابه.
    expect(campaignSegmentIsPeople('leads')).toBe(true);
    expect(campaignSegmentIsPeople('subscribers')).toBe(true);
    expect(campaignSegmentIsPeople('trialing')).toBe(false);
    expect(campaignSegmentIsPeople('active')).toBe(false);
    // والموافقة تُشترط على شرائح الأشخاص وحدها — وإلا لما وصلت رسالةُ تحصيلٍ لأحد.
    expect(campaignSegmentRequiresConsent('subscribers')).toBe(true);
    expect(campaignSegmentRequiresConsent('past_due')).toBe(false);
  });
});

describe('campaign lifecycle (P-M7)', () => {
  it('لا رجوع من حالةٍ خرجت', () => {
    // الحالتان النهائيتان لا تخرجان إلى شيء — والمرسل إليه قرأ ما قرأ.
    expect(campaignTransitions.sent).toEqual([]);
    expect(campaignTransitions.canceled).toEqual([]);
    expect(campaignTransitionAllowed('draft', 'scheduled')).toBe(true);
    expect(campaignTransitionAllowed('scheduled', 'sending')).toBe(true);
    expect(campaignTransitionAllowed('sending', 'sent')).toBe(true);
    expect(campaignTransitionAllowed('sent', 'draft')).toBe(false);
    expect(campaignTransitionAllowed('canceled', 'draft')).toBe(false);
  });

  it('التعديل قبل الإرسال، والإلغاء قبل النهاية', () => {
    expect(campaignStatuses).toEqual(['draft', 'scheduled', 'sending', 'sent', 'canceled']);
    expect(campaignIsEditable('draft')).toBe(true);
    expect(campaignIsEditable('scheduled')).toBe(true);
    // حملةٌ بدأ إرسالها لا يُعاد كتابة نصّها: من وصلته الرسالة قرأ نصّاً غير الذي سيُقرأ غداً.
    expect(campaignIsEditable('sending')).toBe(false);
    expect(campaignIsCancelable('scheduled')).toBe(true);
    expect(campaignIsCancelable('sent')).toBe(false);
  });
});

describe('campaign text (P-M7)', () => {
  it('يجمع المتغيّرات بلا تكرار وبترتيب ظهورها', () => {
    expect(campaignVariablesIn('أهلاً {{name}} من {{ company }} — {{name}}')).toEqual(['name', 'company']);
    expect(campaignVariablesIn('بلا متغيّرات')).toEqual([]);
  });

  it('يستبدل المتغيّر بقيمته، وبالمحايد عند الفراغ', () => {
    const rendered = renderCampaignText('مرحباً {{name}} من {{company}}، عرضٌ لـ{{email}}.', {
      name: 'سارة',
      company: '',
      email: 'sara@example.test',
    });
    // الفراغ لا يُترك فجوةً تُقرأ خطأً: «من ،» تصير «من منشأتك،».
    expect(rendered).toBe('مرحباً سارة من منشأتك، عرضٌ لـsara@example.test.');
  });

  it('يستخرج الروابط بصورتَيها مرةً واحدة لكل رابط', () => {
    const body = 'جرّب [الأسعار](https://erp.test/pricing) أو https://erp.test/demo ثم https://erp.test/demo';
    expect(campaignHyperlinks(body)).toEqual(['https://erp.test/pricing', 'https://erp.test/demo']);
    expect(campaignHyperlinks('بلا روابط هنا')).toEqual([]);
  });

  it('يرفض متغيّراً غير معروف ويمرّر المعروف', () => {
    expect(campaignBodyProblems('مرحباً {{name}} — {{unsubscribe_url}}')).toEqual([]);
    expect(campaignBodyProblems('{{discount}} لك')).toEqual(['المتغيّر «{{discount}}» غير معروف']);
  });

  it('الذيل يذكر اسم الحملة ومعرّفها — ورابط الخروج يكتبه القالب', () => {
    const footer = campaignMessageFooter({ id: 'abcdef12-3456', name: 'عرض أكتوبر' });
    expect(footer).toContain('عرض أكتوبر');
    expect(footer).toContain('abcdef12');
    // الرابط نفسه يخرج من `{{unsubscribe_url}}` في ظرف القالب (P-C6) مرةً واحدة.
    expect(footer).not.toContain('unsubscribe');
  });
});

describe('renderCampaignMessage (P-M7)', () => {
  const campaign = {
    id: '11111111-2222-3333-4444-555555555555',
    name: 'عرض أكتوبر',
    subject: 'أهلاً {{name}} — عرضٌ لـ{{company}}',
    body: 'مرحباً {{name}},\n\nجرّب [الأسعار](https://erp.test/pricing) أو اطلب عرضاً من https://erp.test/demo\n\n{{unsubscribe_url}}',
  };
  const links = ['https://erp.test/pricing', 'https://erp.test/demo'];
  const tracking = {
    openUrl: 'https://erp.test/api/v1/public/track/open/tok-1',
    unsubscribeUrl: 'https://erp.test/unsubscribe?token=tok-1',
    clickUrl: (index: number) => `https://erp.test/api/v1/public/track/click/tok-1/${index}`,
  };

  it('النسختان تُبنيان من مقطعٍ واحد: كل رابطٍ في النصّ له نظيره في HTML', () => {
    const rendered = renderCampaignMessage({
      campaign,
      recipient: { email: 'sara@example.test', name: 'سارة العلي', company: 'مؤسسة النور' },
      links,
      tracking,
    });

    expect(rendered.subject).toBe('أهلاً سارة — عرضٌ لـمؤسسة النور');
    // النصّ: العنوان ثم الرابط المُتتبَّع صريحاً — ولا رابطَ أعمى.
    expect(rendered.text).toContain('الأسعار (https://erp.test/api/v1/public/track/click/tok-1/0)');
    expect(rendered.text).toContain('https://erp.test/api/v1/public/track/click/tok-1/1');
    expect(rendered.text).toContain('https://erp.test/unsubscribe?token=tok-1');
    // HTML: نفس الوجهتين، رابطتين.
    expect(rendered.html).toContain('<a href="https://erp.test/api/v1/public/track/click/tok-1/0">الأسعار</a>');
    expect(rendered.html).toContain('href="https://erp.test/api/v1/public/track/click/tok-1/1"');
    // وبكسل الفتح في HTML وحده — نصٌّ مجرّد لا يُحمّل صورة.
    expect(rendered.html).toContain('src="https://erp.test/api/v1/public/track/open/tok-1"');
    expect(rendered.text).not.toContain('<img');
  });

  it('رابط إلغاء الاشتراك لا يُزحف: طريق الخروج يبقى طريقاً للخروج', () => {
    // خطأٌ حقيقي كشفه هذا الملف أوّل مرّة: كان استبدال `{{unsubscribe_url}}` يسبق لفّ
    // الروابط، فيرى اللافُّ رابطاً عارياً ويلفّه برابط نقرةٍ مُتتبَّع — فيصل زرّ الإلغاء
    // إلى أوّل رابطٍ في الحملة. فالحرس هنا صريح: سطر الإلغاء يحمل رابط الإلغاء نفسه.
    const rendered = renderCampaignMessage({
      campaign,
      recipient: { email: 'sara@example.test', name: 'سارة' },
      links,
      tracking,
    });
    // `{{unsubscribe_url}}` في **متن المشغّل**: يُستبدل بعد لفّ الروابط، فيبقى طريقاً للخروج.
    expect(rendered.text).toContain('https://erp.test/unsubscribe?token=tok-1');
    expect(rendered.text).not.toContain('track/click/tok-1/2');
    expect(rendered.text.split('https://erp.test/unsubscribe?token=tok-1').length - 1).toBe(1);
  });

  it('ترويسات النقرة الواحدة تخرج مع كل رسالة (RFC 8058)', () => {
    const rendered = renderCampaignMessage({
      campaign,
      recipient: { email: 'sara@example.test' },
      links,
      tracking,
    });
    expect(rendered.headers['List-Unsubscribe']).toBe('<https://erp.test/unsubscribe?token=tok-1>');
    expect(rendered.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    // والذيل يذكر الحملة — فرسالةٌ مجهولة المصدر يُبلَّغ عنها كبريدٍ مزعج.
    expect(rendered.text).toContain('عرض أكتوبر');
  });

  it('يهرّب HTML ولا يسمح بنصٍّ يُدخل وسمه', () => {
    const rendered = renderCampaignMessage({
      campaign: { ...campaign, body: 'مرحباً {{name}}، <script>alert(1)</script> و https://erp.test/demo' },
      recipient: { email: 'x@example.test', name: '<b>خالد</b>' },
      links: ['https://erp.test/demo'],
      tracking,
    });
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;');
    expect(rendered.html).toContain('&lt;b&gt;خالد');
  });
});

describe('campaign links (P-M7)', () => {
  it('تُبنى من نطاق الموقع ولا تُلحق شرطةً مزدوجة', () => {
    expect(campaignOpenUrl('https://erp.test/', 'tok-123')).toBe('https://erp.test/api/v1/public/track/open/tok-123');
    expect(campaignClickUrl('https://erp.test', 'tok-123', 2)).toBe(
      'https://erp.test/api/v1/public/track/click/tok-123/2',
    );
    expect(campaignUnsubscribeUrl('https://erp.test/', 'tok-123')).toBe(
      'https://erp.test/unsubscribe?token=tok-123',
    );
  });

  it('الرمز مقبولٌ شكلاً أو مرفوض صراحةً', () => {
    expect(campaignMessageToken('ABCdef0123456789_-')).toBe(true);
    expect(campaignMessageToken('short')).toBe(false);
    expect(campaignMessageToken('has space 1234567890')).toBe(false);
  });
});

describe('campaign payload schemas (P-M7)', () => {
  const draft = {
    name: 'عرض أكتوبر',
    subject: 'جرّب الفاتورة الإلكترونية',
    body: 'مرحباً {{name}}،\nجرّب النظام من https://erp.test/demo',
    segment: 'leads' as const,
  };

  it('يقبل مسوّدةً سليمة ويُسقط الفراغ', () => {
    const parsed = campaignCreateSchema.safeParse({ ...draft, name: '  عرض أكتوبر  ' });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.name).toBe('عرض أكتوبر');
    expect(parsed.data?.locale).toBe('ar');
  });

  it('يرفض نصاً قصيراً أو حقلاً زائداً', () => {
    expect(campaignCreateSchema.safeParse({ ...draft, body: 'قصير' }).success).toBe(false);
    expect(campaignCreateSchema.safeParse({ ...draft, html: '<b>x</b>' }).success).toBe(false);
    // ولا شريحةً خارج الست المعروفة.
    expect(campaignCreateSchema.safeParse({ ...draft, segment: 'everyone' }).success).toBe(false);
  });

  it('التعديل بلا تغييرٍ مرفوض، والإلغاء بلا سببٍ مرفوض', () => {
    expect(campaignPatchSchema.safeParse({}).success).toBe(false);
    expect(campaignPatchSchema.safeParse({ subject: 'عنوانٌ جديد' }).success).toBe(true);
    expect(campaignCancelSchema.safeParse({ reason: '' }).success).toBe(false);
    expect(campaignCancelSchema.safeParse({ reason: 'تغيّر العرض' }).success).toBe(true);
  });

  it('الجدولة: وقتٌ صريح أو «الآن»، ورسالةُ الاختبار عنوانٌ واحد', () => {
    expect(campaignScheduleSchema.safeParse({}).data?.scheduledAt).toBeNull();
    expect(campaignScheduleSchema.safeParse({ scheduledAt: '2026-10-01T09:00:00+03:00' }).success).toBe(true);
    expect(campaignScheduleSchema.safeParse({ scheduledAt: 'غداً' }).success).toBe(false);
    // البريد يُطبَّع صغيراً قبل الحفظ — عنوانٌ واحد لا صورتان لعنوانٍ واحد.
    expect(campaignTestSchema.safeParse({ to: ' QA@Example.TEST ' }).data?.to).toBe('qa@example.test');
  });
});
