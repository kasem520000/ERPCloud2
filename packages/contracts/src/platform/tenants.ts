import { z } from 'zod';

import { uuidSchema } from '../ids.js';

import { platformSettingViewSchema } from './console.js';
import { usageMetricKeys, usageMetricStateSchema } from './usage.js';

/**
 * P-C2 — «العملاء في العمق» (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
 *
 * One tenant card that answers every question an operator has about a customer: who are
 * they, what do they consume, did they pay, and what happened to them. The endpoints are
 * listed in the plan; this file is the shared shape of what they answer, so the console
 * never re-declares a field the API already knows.
 *
 * **Source gate.** The console has no `Desktop_ERP` counterpart (the desktop serves one
 * company: no tenants, no subscriptions, no operators), so — exactly as in P-C1 — the
 * gate is satisfied by naming *this repository's own* files: the route table in
 * `platform-admin.controller.ts`, the tables in `packages/database/src/schema/`
 * (`tenants`, `memberships`, `branches`, `sales_invoices`, `tenant_subscriptions`,
 * `audit_log`, `outbox_jobs`) and `docs/architecture-rbac/`.
 *
 * Label rule: the eight tab labels come **from the plan's own §4 text** (نظرة عامة ·
 * الاشتراك · المستخدمون · الاستخدام · الرايات · الصحة · التدقيق · الملاحظات), and every
 * label that already existed in the console or in `Desktop_ERP` is re-used verbatim. The
 * invented ones are listed in the part document (§«ما اخترعناه»).
 */

export const tenantStatusValues = ['active', 'suspended', 'archived'] as const;
export type TenantStatusValue = (typeof tenantStatusValues)[number];

/** Audit action names this part adds on top of `auditActions` (create/update/delete). */
export const tenantAuditActions = {
  STATUS: 'tenant.status',
  OWNER_TRANSFER: 'tenant.owner_transfer',
  FLAG: 'tenant.flag',
  NOTE: 'tenant.note',
  SETTING: 'tenant.setting',
} as const;

// ------------------------------------------------------------------------ overview

/** `GET /platform/tenants/:id` — the card's first tab and the header of every other one. */
export const platformTenantOwnerSchema = z.object({
  membershipId: uuidSchema,
  userId: uuidSchema,
  email: z.string(),
  displayName: z.string(),
  status: z.string(),
  lastLoginAt: z.string().nullable(),
});

export const platformTenantSubscriptionSchema = z.object({
  id: uuidSchema,
  status: z.string(),
  planCode: z.string().nullable(),
  planName: z.string().nullable(),
  amount: z.string().nullable(),
  currency: z.string().nullable(),
  interval: z.string().nullable(),
  startedAt: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  createdAt: z.string(),
});

export const platformTenantMemberSchema = z.object({
  membershipId: uuidSchema,
  userId: uuidSchema,
  email: z.string(),
  fullName: z.string(),
  displayName: z.string(),
  status: z.string(),
  membershipStatus: z.string(),
  kind: z.string(),
  isOwner: z.boolean(),
  lastLoginAt: z.string().nullable(),
  roleCount: z.number().int(),
});

export const platformTenantOverviewSchema = z.object({
  id: uuidSchema,
  code: z.string(),
  name: z.string(),
  status: z.enum(tenantStatusValues),
  baseCurrency: z.string(),
  timezone: z.string(),
  locale: z.string(),
  countryCode: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Counters of the current state — the same numbers the list shows, plus invoices. */
  userCount: z.number().int(),
  branchCount: z.number().int(),
  invoicesLast30Days: z.number().int(),
  invoicesLifetime: z.number().int(),
  /** `max(audit_log.created_at)` for this tenant — «آخر نشاط». */
  lastActivityAt: z.string().nullable(),
  lastLoginAt: z.string().nullable(),
  /** The customer's own owner membership — NULL for a tenant whose owner was removed. */
  owner: platformTenantOwnerSchema.nullable(),
  subscription: platformTenantSubscriptionSchema.nullable(),
});

export const platformTenantDetailResponseSchema = z.object({
  tenant: platformTenantOverviewSchema,
  members: z.array(platformTenantMemberSchema),
  subscriptions: z.array(platformTenantSubscriptionSchema),
  /** How many operator notes exist, so the tab can show a count without fetching them. */
  noteCount: z.number().int(),
});
export type PlatformTenantDetailResponse = z.infer<typeof platformTenantDetailResponseSchema>;
export type PlatformTenantOverview = z.infer<typeof platformTenantOverviewSchema>;
export type PlatformTenantMember = z.infer<typeof platformTenantMemberSchema>;
export type PlatformTenantSubscription = z.infer<typeof platformTenantSubscriptionSchema>;

// --------------------------------------------------------------------------- usage

/**
 * One metered counter: what the customer uses, and the limit that applies.
 *
 * `limit === null` means "no limit configured" (an operator may clear a limit; the plan
 * treats limits as defaults, not as hard walls until P-C5 enforces them).
 *
 * **P-C5 widened this row to the eight-metric registry** (`usageMetricKeys`) and added the
 * state fields the enforcement surfaces need. The three keys P-C2 shipped stay in it — the
 * card simply stops being the only place that knows about limits. The state fields are
 * optional so a P-C2-era client keeps parsing; the engine fills them.
 */
export const platformTenantUsageMetricSchema = z.object({
  key: z.enum(usageMetricKeys),
  labelAr: z.string(),
  used: z.number().int(),
  limit: z.number().int().nullable(),
  /**
   * Where the limit came from — the same three words the settings tab uses
   * (`PlatformSettingView.source`): the customer's own override, the platform-wide row, or
   * the catalogue default. `limit === null` stays possible: "no limit configured".
   */
  limitSource: z.enum(['tenant', 'platform', 'default']),
  /** `used / limit` as a percentage, rounded — NULL when there is no limit. */
  percentUsed: z.number().int().nullable(),
  periodStart: z.string().nullable(),
  // ---- P-C5: what the screen needs to *act* and not only to display ----------------
  /** «مستخدم» · «م.ب» — the unit printed after the number (from the registry). */
  unitAr: z.string().optional(),
  /** `total` تراكمي · `day` · `month` — why the number resets when it resets. */
  period: z.enum(['day', 'month', 'total']).optional(),
  /** `ok` · `soft` (80٪) · `hard` (100٪) · `unlimited` — from `usageStateFor`. */
  state: usageMetricStateSchema.optional(),
  /**
   * Whether the limit is *enforced* or merely reported. A limit whose source is `default`
   * describes the envelope a new tenant inherits; enforcement starts when an operator
   * writes a limit (`tenant` or `platform`) — see the P-C5 decision in `usage.ts`.
   */
  enforced: z.boolean().optional(),
  /** Arabic sentence for `soft`/`hard` — written once in the contract, shown everywhere. */
  noticeAr: z.string().nullable().optional(),
  /** Where the refusal happens (registry text), so the tab never promises more than it does. */
  enforcedAtAr: z.string().optional(),
});

export const platformTenantUsageResponseSchema = z.object({
  tenantId: uuidSchema,
  metrics: z.array(platformTenantUsageMetricSchema),
  /**
   * سلسلة فواتير الثلاثين يوماً — يبقى هذا الاستعلام هنا لأن سلسلة الاستدعاءات
   * (`UsageSnapshot.apiCallsPerDay`) مقياسٌ آخر: البطاقة تعرض الاثنين ولا تخلطهما.
   */
  invoicesPerDay: z.array(
    z.object({
      day: z.string(),
      count: z.number().int(),
    }),
  ),
  generatedAt: z.string(),
});
export type PlatformTenantUsageResponse = z.infer<typeof platformTenantUsageResponseSchema>;

// -------------------------------------------------------------------------- health

/**
 * The «الصحة» tab. Everything here is read from a real table — no probe is invented:
 * the subscription state, the outbox depth (P-C9 will add retry), the last activity, and
 * whether this customer is close to a limit.
 */
export const platformTenantHealthResponseSchema = z.object({
  tenantId: uuidSchema,
  status: z.enum(['ok', 'attention', 'critical']),
  subscriptionState: z.enum(['active', 'ending_soon', 'past_due', 'cancelled', 'none']),
  currentPeriodEnd: z.string().nullable(),
  outbox: z.object({
    pending: z.number().int(),
    published: z.number().int(),
    dead: z.number().int(),
    lastFailureAt: z.string().nullable(),
  }),
  lastActivityAt: z.string().nullable(),
  lastLoginAt: z.string().nullable(),
  /** Arabic one-liners an operator can act on. Empty is a valid, healthy answer. */
  findings: z.array(z.object({ severity: z.enum(['info', 'warn', 'danger']), text: z.string() })),
});
export type PlatformTenantHealthResponse = z.infer<typeof platformTenantHealthResponseSchema>;

// ------------------------------------------------------------------------- writes

/** `PATCH /platform/tenants/:id` — the four fields the plan names, all optional. */
export const platformTenantPatchSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    code: z
      .string()
      .trim()
      .min(2)
      .max(40)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'الحروف اللاتينية الصغيرة والأرقام والشرطة فقط')
      .optional(),
    timezone: z.string().trim().min(3).max(64).optional(),
    currency: z.string().trim().length(3).optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: 'لا يوجد أي تغيير في الطلب' });
export type PlatformTenantPatch = z.infer<typeof platformTenantPatchSchema>;

/**
 * `POST /platform/tenants/:id/status`. The reason is **required** and at least three
 * characters: suspending a customer cuts their access, and «السبب» is what makes the
 * action reviewable a month later. It is stored on the audit row's `meta`.
 */
export const platformTenantStatusSchema = z.object({
  status: z.enum(tenantStatusValues),
  reason: z.string().trim().min(3).max(500),
});
export type PlatformTenantStatusInput = z.infer<typeof platformTenantStatusSchema>;

/** `POST /platform/tenants/:id/owner/transfer` — the new owner must already be a member. */
export const platformTenantOwnerTransferSchema = z.object({
  membershipId: uuidSchema,
  reason: z.string().trim().min(3).max(500),
});
export type PlatformTenantOwnerTransferInput = z.infer<typeof platformTenantOwnerTransferSchema>;

/** `GET/POST /platform/tenants/:id/notes`. */
export const tenantNoteSchema = z.object({
  id: uuidSchema,
  body: z.string(),
  authorUserId: z.string().nullable(),
  authorLabel: z.string(),
  createdAt: z.string(),
});
export type TenantNoteView = z.infer<typeof tenantNoteSchema>;

export const tenantNoteCreateSchema = z.object({
  body: z.string().trim().min(3).max(4000),
});
export type TenantNoteCreate = z.infer<typeof tenantNoteCreateSchema>;

export const tenantNotesResponseSchema = z.object({
  items: z.array(tenantNoteSchema),
  total: z.number().int(),
});
export type TenantNotesResponse = z.infer<typeof tenantNotesResponseSchema>;

// ------------------------------------------------------------------ tenant settings

/** `GET /platform/tenants/:id/settings` — the tenant-scoped half of the catalogue. */
export const tenantSettingsResponseSchema = z.object({
  tenantId: uuidSchema,
  settings: z.array(platformSettingViewSchema),
});
export type TenantSettingsResponse = z.infer<typeof tenantSettingsResponseSchema>;

/** `PUT /platform/tenants/:id/settings/:key` — one key, so one clear audit row. */
export const tenantSettingUpdateSchema = z.object({
  value: z.unknown(),
});
export type TenantSettingUpdate = z.infer<typeof tenantSettingUpdateSchema>;

// ---------------------------------------------------------------------------- flags

/**
 * Feature flags are `feature.*` keys of the tenant settings registry
 * (`packages/config/src/tenant-settings.ts`) — the plan says to keep using it rather than
 * invent a second flag store. The Arabic label is carried here because the registry's
 * descriptions are English; where the desktop already named the pack, that name is used.
 */
export const tenantFlagViewSchema = z.object({
  key: z.string(),
  labelAr: z.string(),
  labelEn: z.string(),
  descriptionAr: z.string(),
  enabled: z.boolean(),
  /** True when nothing is stored and the registry default applies. */
  isDefault: z.boolean(),
  updatedAt: z.string().nullable(),
});
export type TenantFlagView = z.infer<typeof tenantFlagViewSchema>;

export const tenantFlagsResponseSchema = z.object({
  tenantId: uuidSchema,
  flags: z.array(tenantFlagViewSchema),
});
export type TenantFlagsResponse = z.infer<typeof tenantFlagsResponseSchema>;

export const tenantFlagsUpdateSchema = z.object({
  values: z.record(z.boolean()),
});
export type TenantFlagsUpdate = z.infer<typeof tenantFlagsUpdateSchema>;

/**
 * Labels of the four packs, edited in one place on purpose. «نقطة البيع» and «المشاريع»
 * are taken verbatim from `Desktop_ERP` (`Class/MainClass.cs`, `Form_WPF/frmProjCyclePM.xaml`)
 * and «الرواتب» from `Form_WPF/frmEmployees.xaml`; «الأنشطة المتخصصة» is invented and
 * justified in the part document — the niche pack covers optics/marine/vehicles, which the
 * desktop names one by one, and the console needs one line for all three.
 *
 * و«الاسم الإنجليزي» (`labelEn`) أُضيف في P-M3: صفحة الأسعار العامة تعرض الحقوق بلغتين
 * (`docs/roadmap/MARKETING_SITE_PLAN.md` §5 P-M3)، وهو **ترجمة الاسم المكتوب أعلاه** لا اسمٌ
 * ثانٍ للحزمة — «نقطة البيع» ⇒ `Point of sale`، و«الرواتب والموظفون» ⇒ `Payroll & HR`،
 * و«الأنشطة المتخصصة» ⇒ `Specialised activities` (نفس التسمية المُخترَعة أعلاه، مترجمةً).
 */
export const tenantFlagLabels: Record<string, { labelAr: string; labelEn: string; descriptionAr: string }> = {
  'feature.pos': {
    labelAr: 'نقطة البيع',
    labelEn: 'Point of sale',
    descriptionAr: 'حزمة المطاعم والتجزئة: شاشة بيع، ورديات، وطاولات.',
  },
  'feature.projects': {
    labelAr: 'المشاريع',
    labelEn: 'Projects',
    descriptionAr: 'حزمة المشاريع والمقاولات: عقود، دورات، ومستخلصات.',
  },
  'feature.hrm': {
    labelAr: 'الرواتب والموظفون',
    labelEn: 'Payroll & HR',
    descriptionAr: 'حزمة الموارد البشرية: موظفون، رواتب، ومستحقات.',
  },
  'feature.niche': {
    labelAr: 'الأنشطة المتخصصة',
    labelEn: 'Specialised activities',
    descriptionAr: 'الأنشطة المتخصصة: بصريات، بحرية، مركبات.',
  },
};

// ------------------------------------------------------------------------- branding

/** `GET/PUT /platform/tenants/:id/branding` — three keys of the catalogue above. */
export const tenantBrandingResponseSchema = z.object({
  tenantId: uuidSchema,
  primaryColor: z.string(),
  logoUrl: z.string(),
  senderName: z.string(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});
export type TenantBrandingResponse = z.infer<typeof tenantBrandingResponseSchema>;

/**
 * Shape only — the *value* rules (a `#rrggbb` colour, an `https://` or internal-path url, an
 * empty logo meaning «no logo yet») live once, in `validatePlatformSettingValue` above, and
 * the service applies them to the same keys `PUT /settings/:key` writes. Duplicating them
 * here would answer 400 in one route and 422 in the other for the same mistake.
 */
export const tenantBrandingUpdateSchema = z.object({
  primaryColor: z.string().trim().optional(),
  logoUrl: z.string().trim().optional(),
  senderName: z.string().trim().max(60).optional(),
});
export type TenantBrandingUpdate = z.infer<typeof tenantBrandingUpdateSchema>;

/** The three keys `GET/PUT …/branding` reads and writes. */
export const tenantBrandingKeys = {
  primaryColor: 'branding.primary_color',
  logoUrl: 'branding.logo_url',
  senderName: 'branding.sender_name',
} as const;
