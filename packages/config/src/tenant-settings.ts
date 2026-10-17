import { z } from 'zod';

/**
 * Typed tenant-settings registry.
 *
 * MULTI_TENANCY §5: `tenant_settings(tenant_id, key, value jsonb)` with *typed keys in
 * `packages/config/tenant-settings.ts`*. Every key declares its zod schema, default and
 * owning module, which is what `PUT /settings/{key}` validates against (PHASE_03 §5.5).
 *
 * Keys are dot-namespaced by module. The five flat keys created in Phase 01 are kept
 * (AI_DEVELOPMENT_PROTOCOL §2 forbids silent deletion) and mapped into the registry.
 */

export type TenantSettingDefinition = {
  readonly key: string;
  readonly module: string;
  readonly description: string;
  readonly schema: z.ZodTypeAny;
  readonly defaultValue: string | boolean | number | null;
};

function define(
  key: string,
  module: string,
  description: string,
  schema: z.ZodTypeAny,
  defaultValue: string | boolean | number | null,
): TenantSettingDefinition {
  return { key, module, description, schema, defaultValue };
}

export const tenantSettingsRegistry: readonly TenantSettingDefinition[] = [
  // --- Phase 01 keys (retained) -------------------------------------------------
  define(
    'allow_negative_stock',
    'inventory',
    'Allow posting documents that drive stock below zero.',
    z.boolean(),
    false,
  ),
  define(
    'default_currency_code',
    'organization',
    'ISO-4217 code used when a document omits one.',
    z.string().length(3),
    'SAR',
  ),
  define(
    'fiscal_year_start_month',
    'accounting',
    'Month (1-12) the fiscal year starts in.',
    z.number().int().min(1).max(12),
    1,
  ),
  define(
    'timezone',
    'organization',
    'Legacy flat timezone key; `locale.timezone` is authoritative.',
    z.string(),
    'UTC',
  ),
  define(
    'branding.primary_color',
    'branding',
    'Primary brand colour as #rrggbb.',
    z.string().regex(/^#[0-9a-fA-F]{6}$/),
    '#0f172a',
  ),

  // --- Invoicing / money --------------------------------------------------------
  define(
    'invoice.number_prefix',
    'sales',
    'Prefix for the sales invoice document sequence.',
    z.string().min(1).max(12),
    'INV-',
  ),
  define(
    'invoice.padding',
    'sales',
    'Zero-padding width of the sales invoice sequence.',
    z.number().int().min(1).max(20),
    6,
  ),
  define(
    'money.rounding_digits',
    'accounting',
    'Currency minor units used for rounding (legacy `DigitsNo`).',
    z.number().int().min(0).max(6),
    2,
  ),
  define(
    'pricing.price_includes_vat',
    'sales',
    'Default for `price_includes_vat` on new documents.',
    z.boolean(),
    false,
  ),
  define(
    'sales.saveAsDraft',
    'sales',
    'When true, new sales invoices default to draft mode instead of immediate posting.',
    z.boolean(),
    false,
  ),
  define(
    'vat.default_rate_percent',
    'accounting',
    'Default VAT percentage applied when a line has no tax group.',
    z.number().min(0).max(100),
    15,
  ),

  // --- Locale ------------------------------------------------------------------
  define(
    'locale.timezone',
    'organization',
    'IANA timezone used to resolve business dates (tenants.timezone).',
    z.string(),
    'Asia/Riyadh',
  ),
  define('locale.code', 'organization', 'BCP-47 locale code for rendering.', z.string(), 'ar'),

  // --- Point of sale (R4 — نافذة `frmCasherSetting` تحمل هذه الخانات الست) -------
  // ✅ وهذه هي المفاتيح التي يقرأها الكاشير: `GET /pos/settings` يعيدها بلا اشتراط
  // `tenant.settings.manage` (الكاشير لا يملك إعدادات المستأجر)، والكتابة تبقى على
  // `PUT /settings/pos.*` من شاشة «⚙️ إعدادات الكاشير».
  define('pos.barcodeAuto', 'pos', '📷 الباركود أوتوماتيك: the barcode field takes focus.', z.boolean(), true),
  define('pos.touchScreen', 'pos', '👆 الشاشة تدعم التاتش سكرين: larger till tiles.', z.boolean(), false),
  define('pos.showGroups', 'pos', '📦 عرض المجموعات والأصناف: show the category chips.', z.boolean(), true),
  define('pos.defaultDeliveryFee', 'pos', '🚗 قيمة التوصيل الافتراضية.', z.number().min(0), 0),
  define('pos.defaultInsurance', 'pos', '🛡️ قيمة التأمين الافتراضية.', z.number().min(0), 0),
  define('pos.defaultUnitId', 'pos', '📏 الوحدة الافتراضية (unit id).', z.string(), ''),
  // يقرأه `pos.service.ts` (`requireShift`، السطر 562 في نسخة R3) والسجلّ لم يعرّفه:
  // مفتاحٌ يعمل من قاعدة البيانات وحدها، و`PUT /settings/pos.requireShift` يردّ 400،
  // و`GET /settings` لا يُظهره. تسجيله هنا يجعله قابلاً للضبط من الواجهة كأخوته.
  define('pos.requireShift', 'pos', 'Open a cashier shift before taking cash.', z.boolean(), false),

  // --- Vertical pack feature flags (MULTI_TENANCY §5) ---------------------------
  // ⚠️ لماذا `feature.*` هنا و`pack.*` في الخدمات؟ R4 كشف الفرق: خدمات الأفواج
  // (`pos` · `hrm` · `projects` · `marina` · `optics` · `tailoring` · `installments` ·
  // `fitment`) تقرأ `pack.<name>` وهذا السجل لا يعرّفه ⇒ `PUT /settings/pack.pos` يردّ
  // 400 (مفتاحٌ ليس في السجل)، ولا طريقة لتشغيل الفوج أو إطفائه من الواجهة. صُحّح في
  // `pos` وحده (يقرأ السجلّ ويبقى `pack.pos` مقبولاً للتوافق)، وبقيّة الأفواج مؤجَّلةٌ
  // صراحةً في §R4 لأنّ كلًّا منها نافذةُ مرحلتها.
  define('feature.pos', 'pos', 'Restaurant/retail POS pack.', z.boolean(), false),
  define('feature.projects', 'projects', 'Projects & contracting pack.', z.boolean(), false),
  define('feature.hrm', 'hrm', 'Human resources & payroll pack.', z.boolean(), false),
  define('feature.niche', 'niche', 'Niche verticals pack (optical, marine, vehicles).', z.boolean(), false),
  // M7 — الحزم العمودية للمنتج المتخصص (خارطة الطريق: جملة/تصنيع/مصنع أغذية/بيع
  // متجول). الباقة تفتحها كسطر في حقوقها، والمشغّل يقلبها من لوحة المنصة — وهي
  // المفاتيح التي يقرؤها مكوّن الخدمة لاحقاً كما يقرأ `feature.pos` بوابة الكاشير.
  define('feature.wholesale', 'wholesale', 'Wholesale & distribution pack.', z.boolean(), false),
  define('feature.manufacturing', 'manufacturing', 'Manufacturing & production pack.', z.boolean(), false),
  define('feature.food_factory', 'food_factory', 'Food-factory pack (production, expiry, distribution).', z.boolean(), false),
  define('feature.van_sales', 'van_sales', 'Van-sales & field distribution pack.', z.boolean(), false),
] as const;

const registryByKey = new Map(tenantSettingsRegistry.map((entry) => [entry.key, entry]));

export function findTenantSetting(key: string): TenantSettingDefinition | undefined {
  return registryByKey.get(key);
}

export function isTenantSettingKey(key: string): boolean {
  return registryByKey.has(key);
}

/** Parses and validates a raw setting value against the registry. Throws on unknown key. */
export function parseTenantSettingValue(key: string, value: unknown): string | boolean | number | null {
  const definition = registryByKey.get(key);
  if (!definition) {
    throw new Error(`Unknown tenant setting key: ${key}`);
  }
  if (value === null || value === undefined) return definition.defaultValue;
  return definition.schema.parse(value) as string | boolean | number | null;
}

export type TenantSettingKey = (typeof tenantSettingsRegistry)[number]['key'];

export type TenantSettingsMap = Record<string, string | boolean | number | null>;

/** @deprecated use `tenantSettingsRegistry` — kept for Phase-01 API compatibility. */
export const tenantSettingKeys: readonly string[] = tenantSettingsRegistry.map((entry) => entry.key);

/** @deprecated use `tenantSettingsRegistry` — kept for Phase-01 API compatibility. */
export const tenantSettingsDefaults: Record<string, string | boolean | number | null> = Object.fromEntries(
  tenantSettingsRegistry.map((entry) => [entry.key, entry.defaultValue]),
);

/** Effective settings for a tenant: registry defaults overridden by stored rows. */
export function resolveTenantSettings(
  stored:
    ReadonlyMap<string, string | boolean | number | null> | Record<string, string | boolean | number | null>,
): TenantSettingsMap {
  const resolved: TenantSettingsMap = {};
  for (const definition of tenantSettingsRegistry) {
    const override =
      stored instanceof Map
        ? stored.get(definition.key)
        : (stored as Record<string, unknown>)[definition.key];
    resolved[definition.key] = override === undefined ? definition.defaultValue : override;
  }
  return resolved;
}
