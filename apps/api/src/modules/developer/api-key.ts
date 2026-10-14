import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { API_KEY_PREFIX, type ApiKeyScope } from '@erp/contracts';

/**
 * توليد مفتاح الـAPI وقراءته — وحدةٌ صغيرة لأنها أكثر ما يُخطئ فيه الناس.
 *
 * ثلاثة قرارات:
 *
 *   1. **النصّ الصريح لا يُخزَّن.** المحفوظ `prefix` و`hash` (SHA-256 hex). ولا تشفير هنا:
 *      المفتاح لا يُقرأ أبداً بعد إنشائه، فلا معنى لمفتاحٍ عكوسٍ يُمكن فتحه.
 *   2. **العشوائية من `randomBytes`** لا من `Math.random` ولا من وقت: 24 بايت ⇒ 192 بت،
 *      وصيغة `base64url` بلا محارف تُشوّه في نسخٍ يدوي.
 *   3. **البادئة تُقرأ في السجلّات**: `erp_live_` تقول «هذا طلبٌ بمفتاح لا بجلسة»، و8 محارف
 *      بعده تكفي للتعرّف على المفتاح في الشاشة بلا كشفه — وهي **بديلٌ عن البحث الكامل** عند
 *      كل طلب (الفهرس الفريد على `key_prefix`).
 */

export type GeneratedApiKey = {
  /** النصّ الكامل — يُعرض مرّةً واحدةً في الاستجابة، ولا يُكتب في أي صفّ. */
  secret: string;
  prefix: string;
  hash: string;
};

export function hashApiKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function generateApiKey(): GeneratedApiKey {
  const body = randomBytes(24).toString('base64url');
  const secret = `${API_KEY_PREFIX}${body}`;
  return {
    secret,
    prefix: secret.slice(0, API_KEY_PREFIX.length + 8),
    hash: hashApiKey(secret),
  };
}

/** هل يبدو هذا الرمز مفتاحاً؟ — يُسأل قبل أي تحقّق، فيُوجَّه الطلب إلى المسار الصحيح. */
export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}

/** البادئة من نصٍّ كامل: تُستعمل للبحث المفهرس قبل مقارنة البصمة. */
export function prefixOf(secret: string): string {
  return secret.slice(0, API_KEY_PREFIX.length + 8);
}

/** مقارنةٌ بزمنٍ ثابت: تسريب «كم محرفاً صحّ» لا يُقاس بالزمن. */
export function hashesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ─────────────────────────────────────────────────────────────────────────────
// النطاقات ← رموز الصلاحيات
// ─────────────────────────────────────────────────────────────────────────────

/**
 * خريطة النطاق إلى رموز صلاحيات **قائمة فعلاً** في المستودع.
 *
 * ولهذه الخريطة سببٌ صريح: مسارات العميل تحرسها `@RequiresPermission('sales.view')`
 * وأخواتها، لا `invoices:read`. فلو مرّ النطاق كما هو لكان المفتاح زينةً تُعرض في الشاشة
 * ولا تفتح شيئاً؛ ولو مُنح المفتاح `*` لكان باباً خلفياً — وهو عكس هدف هذا الجزء. فالخريطة
 * هي الحدّ: ما يشتريه العميل بنطاقٍ يُترجَم إلى رموزٍ يعرفها الحارس، وما ليس فيها لا يُفتح.
 */
const SCOPE_PERMISSIONS: Record<ApiKeyScope, readonly string[]> = {
  'invoices:read': ['sales.view'],
  'invoices:write': [
    'sales.invoice.create',
    'sales.invoice.post',
    'sales.invoice.void',
    'sales.invoice.pay',
    'sales.return.create',
    'sales.adjustment.create',
  ],
  'inventory:read': ['inventory.view'],
  'inventory:write': ['inventory.adjust', 'inventory.transfer'],
  'parties:read': ['parties.view'],
  'parties:write': ['parties.manage'],
  'reporting:read': ['reporting.view'],
  // لا رمز «إدارة ويب هوك» على سطح العميل اليوم (إدارتها في اللوحة) — فالنطاق يمنح
  // إعدادات المنشأة وحدها، وهي أقرب شيء «يملكه» التكامل من جهة العميل.
  'webhooks:manage': ['tenant.settings.manage'],
};

/** الرموز التي يمنحها مفتاحٌ بنطاقاته — تُغذّي سياق المستأجر في مسار المفتاح. */
export function permissionsForScopes(scopes: readonly ApiKeyScope[]): string[] {
  const codes = new Set<string>();
  for (const scope of scopes) {
    for (const code of SCOPE_PERMISSIONS[scope] ?? []) codes.add(code);
  }
  return [...codes].sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// توقيع الويب هوك
// ─────────────────────────────────────────────────────────────────────────────

export type SignatureParts = { timestamp: number; signature: string };

/**
 * توقيع الحمولة: `HMAC-SHA256(secret, "<t>.<body>")` بصيغة hex.
 *
 * والطابع الزمني **داخل** المُوقَّع: لو كان خارجه لصحّ التوقيع إلى الأبد، ومن التقط حمولةً
 * مرّةً أعاد إرسالها كل يوم — وهو أول ما يُستغلّ في الويب هوك.
 */
export function signWebhookPayload(secret: string, body: string, at: number): string {
  return createHmac('sha256', secret).update(`${at}.${body}`).digest('hex');
}

/** الترويسة كما تُرسل وكما يُتوقّع أن يقرأها المستلم: `t=<ثواني>,v1=<hex>`. */
export function formatSignatureHeader(at: number, signature: string): string {
  return `t=${at},v1=${signature}`;
}

export function parseSignatureHeader(header: string): SignatureParts | null {
  const parts = new Map(
    header
      .split(',')
      .map((chunk) => chunk.trim().split('='))
      .filter((pair) => pair.length === 2)
      .map(([key, value]) => [key as string, value as string]),
  );
  const timestamp = Number(parts.get('t'));
  const signature = parts.get('v1');
  if (!Number.isFinite(timestamp) || !signature) return null;
  return { timestamp, signature };
}

/**
 * التحقّق كما يفعله المستلم: التوقيع صحيح **و** الطابع الزمني داخل النافذة.
 * وهو مُصدَّر لأن سكربت التحقّق الحيّ يستعمله بدل أن يُعيد كتابة الصيغة (فلا يُقاس
 * المنفّذ بقاعدةٍ مختلفة عن التي يشرحها).
 */
export function verifyWebhookSignature(options: {
  secret: string;
  header: string;
  body: string;
  now?: number;
  toleranceSeconds: number;
}): boolean {
  const parsed = parseSignatureHeader(options.header);
  if (!parsed) return false;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.timestamp) > options.toleranceSeconds) return false;
  const expected = signWebhookPayload(options.secret, options.body, parsed.timestamp);
  return hashesMatch(expected, parsed.signature);
}
