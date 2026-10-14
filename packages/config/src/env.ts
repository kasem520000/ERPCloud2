import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { describeEnvSources, loadEnvFiles } from './load-env.js';

// Populate `process.env` from the workspace `.env` files *before* the schema reads it.
// Without this the whole file validated an empty environment (see load-env.ts).
loadEnvFiles();

/**
 * Environment schema — SECURITY_ARCHITECTURE §9 ("Secrets via env only"),
 * TARGET_ARCHITECTURE §5 ("packages/config zod-validates at boot (fail-fast)").
 *
 * Every variable is optional at *import* time so that type-checking, linting and unit
 * tests never depend on a populated environment. `assertRuntimeEnv()` performs the
 * fail-fast validation that `apps/api` runs during bootstrap.
 */

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => (typeof value === 'boolean' ? value : value === 'true' || value === '1'));

const csv = z.string().transform((value) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0),
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  API_HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
  DATABASE_APP_ROLE: z.string().default('erp_api'),
  DATABASE_MIGRATOR_ROLE: z.string().default('erp_migrator'),
  DATABASE_MIGRATOR_URL: z.string().optional(),
  /** Used only by `pnpm db:roles`; never read at runtime by the API. */
  DATABASE_APP_PASSWORD: z.string().optional(),
  DATABASE_MIGRATOR_PASSWORD: z.string().optional(),

  REDIS_URL: z.string().optional(),

  /** PEM encoded RS256 key pair. Literal `\n` sequences are normalised to newlines. */
  JWT_PRIVATE_KEY: z.string().optional(),
  JWT_PUBLIC_KEY: z.string().optional(),
  JWT_KEY_ID: z.string().default('dev-key-1'),
  /** Frozen: PROJECT_CONTRACT §9 — access 15 min, refresh 30 d. */
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),

  /** Frozen: PROJECT_CONTRACT §9 / SECURITY_ARCHITECTURE §2 — Argon2id m=64MiB t=3 p=4. */
  AUTH_ARGON2_MEMORY_KIB: z.coerce.number().int().positive().default(65_536),
  AUTH_ARGON2_TIME_COST: z.coerce.number().int().positive().default(3),
  AUTH_ARGON2_PARALLELISM: z.coerce.number().int().positive().default(4),
  AUTH_ARGON2_OUTPUT_LENGTH: z.coerce.number().int().positive().default(32),
  /** SECURITY_ARCHITECTURE §2 — exponential lockout on repeated failures. */
  AUTH_LOGIN_MAX_FAILURES: z.coerce.number().int().positive().default(5),
  AUTH_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),

  /** SECURITY_ARCHITECTURE §8 — token buckets. */
  RATE_LIMIT_DEFAULT_PER_MINUTE: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_LOGIN_PER_MINUTE: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_REGISTER_PER_MINUTE: z.coerce.number().int().positive().default(5),
  /**
   * P-M6 — استمارات الموقع العامّة (تواصل · طلب عرض · نشرة). دلوٌ خاصٌّ بها لا دلو الدخول:
   * حدُّ الدخول (١٠/دقيقة) يخصّ محاولات كلمة المرور، وحدُّ الاستمارة يخصّ **عدد الرسائل التي
   * نُرسلها باسم المنصّة** إلى عناوين لا نملكها — وهو ما يجعل الرقم منخفضاً عن قصد.
   */
  RATE_LIMIT_PUBLIC_FORM_PER_MINUTE: z.coerce.number().int().positive().default(10),
  // P-M7 — دلوُ الزحف (`/public/track/*` و`/public/unsubscribe/*`): عملاء البريد تحمّل
  // بكسل الفتح آليّاً، فسقفُ الاستمارات (١٠/دقيقة) يقطع حملةً حقيقية. والسقف هنا أعلى
  // لأن الكتابة محدودة أصلاً بالفهارس الفريدة (فتحٌ واحد لكل رسالة).
  RATE_LIMIT_CAMPAIGN_TRACK_PER_MINUTE: z.coerce.number().int().positive().default(120),
  // P-M8 — دلوُ التحقّق العام (`POST /public/verify`): قراءةٌ لا كتابة، ودلوٌ مستقلّ عن
  // الاستمارات لأن سيلَ استماراتٍ لا يجوز أن يُغلق بابَ التحقّق (والعكس). والسقف متوسّط
  // لأنه يخدم لصقاً يدوياً يتكرّر فيه الخطأ.
  RATE_LIMIT_PUBLIC_VERIFY_PER_MINUTE: z.coerce.number().int().positive().default(30),
  // P-M9 — دلوُ حالة الخدمة العامة (`GET /public/status`): كل نداءٍ يقرأ مجسّات المنصّة
  // نفسها (قاعدة · طابور · بريد · تخزين)، فالسقف يمنع تحويل صفحة الحالة إلى حملة استنزاف،
  // وفوقه ذاكرةُ عشر ثوانٍ في الخدمة فالسقف الفعليّ أوسع للزائر العادي.
  RATE_LIMIT_PUBLIC_STATUS_PER_MINUTE: z.coerce.number().int().positive().default(60),
  // P-M10 — دلوُ أحداث الموقع (`POST /public/events`): الموقع يرسل دفعاتٍ صغيرة، والسقف
  // يمنع تحويل نقطة القياس إلى قناة كتابةٍ مفتوحة — ودلوٌ مستقلّ عن الاستمارات والتحقّق
  // لأن سيلَ أحداثٍ لا يجوز أن يُغلق بابَ التعاقد.
  RATE_LIMIT_PUBLIC_EVENTS_PER_MINUTE: z.coerce.number().int().positive().default(120),

  /** Public self-service signup (POST /api/v1/signup). Turn it off for private deployments. */
  SIGNUP_ENABLED: booleanish.default(true),

  CORS_ALLOWED_ORIGINS: csv.default(''),
  OPENAPI_ENABLED: booleanish.default(true),

  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** SigV4 scope. MinIO ignores it but still signs with it, so it must match on both ends. */
  S3_REGION: z.string().default('us-east-1'),
  /** MinIO and most self-hosted gateways only serve path-style (`/bucket/key`) URLs. */
  S3_FORCE_PATH_STYLE: booleanish.default(true),
  /** Lifetime of a pre-signed PUT/GET URL (SECURITY: keep it short). */
  S3_PRESIGN_EXPIRY_SECONDS: z.coerce.number().int().positive().max(604_800).default(900),

  /** PHASE_04 files — size/mime allow-lists are enforced before a presign is issued. */
  FILES_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(25 * 1024 * 1024),
  FILES_ALLOWED_MIME_TYPES: csv.default(
    'image/png,image/jpeg,image/webp,image/gif,application/pdf,text/csv,text/plain,' +
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,' +
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document,' +
      'application/vnd.ms-excel,application/zip,application/xml,text/xml',
  ),
  /** Lifetime of the app-signed download URL handed to a browser. */
  FILES_DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().max(86_400).default(300),
  /** A `pending` file older than this is an abandoned upload and is collected. */
  FILES_ORPHAN_GC_HOURS: z.coerce.number().int().positive().default(24),

  /** Future enhancement 02 — endpoint/provider may be overridden by platform settings; the API key remains an env secret. */
  OCR_PROVIDER: z.enum(['http', 'mock']).default('http'),
  OCR_ENDPOINT: z.union([z.literal(''), z.string().url()]).optional(),
  OCR_API_KEY: z.string().optional(),
  OCR_TIMEOUT_MS: z.coerce.number().int().positive().max(300_000).default(60_000),

  /** Future enhancement 07 — hosted invoice providers. Empty means the built-in production base. */
  MOYASAR_API_BASE: z.union([z.literal(''), z.string().url()]).optional(),
  TAP_API_BASE: z.union([z.literal(''), z.string().url()]).optional(),
  HYPERPAY_API_BASE: z.union([z.literal(''), z.string().url()]).optional(),
  APP_PUBLIC_URL: z.union([z.literal(''), z.string().url()]).optional(),
  API_PUBLIC_URL: z.union([z.literal(''), z.string().url()]).optional(),

  /**
   * P-C10 — أين تُكتب نسخة المنصّة حين لا اعتمادات تخزين كائنات. النسخة تُكتب دائماً إلى
   * ملفٍّ يُقرأ من مكانه (التحقّق يعيد قراءته ويحسب بصمته)، و`ObjectStoragePort` هو الوجهة
   * الأولى متى كان مُهيّأً؛ وهذا المسار هو البديل المُعلَن لا الصامت.
   */
  BACKUP_ARTIFACT_DIR: z.string().default(join(tmpdir(), 'erp-backups')),
  /**
   * وجهة النسخة: `auto` (التخزين إن كان مُهيّأً، وإلا نظام الملفات) · `s3` · `filesystem`.
   * `auto` هي الصواب في النشر، والاختيار الصريح لمن يعرف أنّ تخزينه غير متاحٍ في بيئته —
   * ولا يُحوَّل فشلُ الرفع إلى نجاحٍ على القرص بصمت في أي حال.
   */
  BACKUP_STORE: z.enum(['auto', 's3', 'filesystem']).default('auto'),

  /** PHASE_04 jobs — BullMQ is only wired up when a Redis URL is present. */
  WORKER: booleanish.default(false),
  JOBS_ENABLED: booleanish.default(true),
  JOB_QUEUE_PREFIX: z.string().default('erp'),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().max(1_000).default(50),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
  OUTBOX_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(2_000),
  WORKER_HEALTH_LOG_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),

  /** PHASE_04 idempotency — DATABASE_DESIGN §4 ("expires 24h"). */
  IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().positive().default(24),

  /** PHASE_04 mail — `console` writes to the log, `smtp` targets MailHog/SES. */
  MAIL_TRANSPORT: z.enum(['console', 'smtp']).default('console'),
  MAIL_FROM: z.string().default('no-reply@erp.local'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  /** Round 11 — optional AUTH LOGIN credentials; omitted for MailHog. */
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  /** Implicit TLS on connect (port 465 style) instead of cleartext + STARTTLS. */
  SMTP_SECURE: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .default('false'),
  /** EHLO identity (some relays reject 'localhost'). */
  SMTP_CLIENT_HOSTNAME: z.string().optional(),
  /** Public URL of the customer portal, used inside outbound e-mails. */
  CUSTOMER_PUBLIC_URL: z.string().default(''),
  /**
   * P-C7 — Public URL of the staff workspace, used inside outbound e-mails
   * (the announcement template's `{{link}}` points at its notification centre).
   * Empty means the link stays a relative path rather than a dead absolute one.
   */
  STAFF_PUBLIC_URL: z.string().default(''),
  /**
   * P-C12 (التقرير الأسبوعي) — Public URL of the platform console, used as the link inside
   * the weekly report. Empty means the e-mail carries the relative path (`/analytics`) rather
   * than a dead absolute URL — the same rule as `STAFF_PUBLIC_URL`.
   */
  CONSOLE_PUBLIC_URL: z.string().default(''),

  /**
   * PHASE_08 — fallback when the platform has not stored an assistant key.
   * `local` answers from tenant aggregates without calling a model.
   */
  AI_PROVIDER: z.enum(['openai', 'anthropic', 'local']).optional(),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().optional(),
  AI_BASE_URL: z.union([z.literal(''), z.string().url()]).optional(),

  /** PHASE_09 — optional Web Push. Empty means notices stay in the in-app outbox. */
  WEB_PUSH_VAPID_PUBLIC: z.string().optional(),
  WEB_PUSH_VAPID_PRIVATE: z.string().optional(),

  /** AES-256-GCM data-encryption key, base64 (SECURITY_ARCHITECTURE §9). */
  DATA_ENC_KEY: z.string().optional(),
  /** HMAC secret for app-signed file download URLs; derived from DATA_ENC_KEY when unset. */
  FILE_URL_SIGNING_SECRET: z.string().optional(),
  /** AUD-09 — pepper for the legacy compatibility gateway's device-key hashes. */
  COMPAT_KEY_PEPPER: z.string().optional(),
});

export type AppEnv = z.infer<typeof envSchema>;

/**
 * Lenient parse. A single bad value (say `PORT=abc`) used to make the *entire* env fall
 * back to defaults, silently discarding a perfectly valid DATABASE_URL and producing a
 * misleading "missing required variable" error. Offending keys are dropped one by one
 * and reported through `envIssues` instead.
 */
function readEnv(source: Record<string, string | undefined>): { value: AppEnv; issues: string[] } {
  const first = envSchema.safeParse(source);
  if (first.success) return { value: first.data, issues: [] };

  const issues = first.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
  const sanitised: Record<string, unknown> = { ...source };
  for (const issue of first.error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string') delete sanitised[key];
  }
  const second = envSchema.safeParse(sanitised);
  return { value: second.success ? second.data : envSchema.parse({}), issues };
}

const parsed = readEnv(process.env);

/**
 * Test-only at-rest encryption key (AUD-16). The name is deliberately unusable in
 * production: it exists so spec runs can exercise sealed columns without planting a
 * repository-known default that a deployment could silently inherit. It is only ever
 * injected when `NODE_ENV === 'test'`.
 */
export const TEST_DATA_ENC_KEY = 'erp-test-only-data-encryption-key';

/**
 * Resolves the key behind every AES-256-GCM envelope (secret-box, provider credentials,
 * Salla/e-invoicing/payments/e-commerce secrets) — AUD-16.
 *
 * Before this, each module defaulted to the repository-known string
 * `local-development-data-key` whenever `NODE_ENV !== 'production'`, so a staging process
 * (or any non-production deployment) could encrypt real secrets under a public key.
 * Resolution order — explicit argument, runtime `process.env`, validated `env` — then a
 * **fail-closed** error outside tests instead of a known fallback.
 */
export function decideDataEncryptionKey(key: string | undefined | null, nodeEnv: string): string {
  const configured = (key ?? '').trim();
  if (configured.length > 0) return configured;
  if (nodeEnv === 'test') return TEST_DATA_ENC_KEY;
  throw new Error(
    'DATA_ENC_KEY is required to encrypt or decrypt stored secrets (AUD-16). ' +
      'Run `pnpm env:setup` at the repository root or set DATA_ENC_KEY in the environment; ' +
      'the built-in fallback exists for tests only.',
  );
}

export function resolveDataEncryptionKey(
  candidate?: { DATA_ENC_KEY?: string },
  nodeEnv: string = process.env.NODE_ENV ?? parsed.value.NODE_ENV,
): string {
  return decideDataEncryptionKey(
    candidate?.DATA_ENC_KEY ?? process.env.DATA_ENC_KEY ?? parsed.value.DATA_ENC_KEY,
    nodeEnv,
  );
}

/** Convenience wrapper for call sites that do not accept a key argument. */
export function dataEncryptionKey(): string {
  return resolveDataEncryptionKey();
}

export const env: AppEnv =
  parsed.value.NODE_ENV === 'test' && !parsed.value.DATA_ENC_KEY
    ? { ...parsed.value, DATA_ENC_KEY: TEST_DATA_ENC_KEY }
    : parsed.value;

/** Human-readable list of variables that failed validation and were ignored. */
export const envIssues: readonly string[] = parsed.issues;

/** Which `.env` files were picked up — safe to log, contains no values. */
export { describeEnvSources, loadedEnvFiles } from './load-env.js';

/** Normalises PEM material that arrived through an environment variable. */
export function normalisePem(value: string | undefined): string | undefined {
  if (!value || value.trim().length === 0) return undefined;
  if (value.includes('-----BEGIN')) return value;
  const withNewlines = value.replace(/\\n/g, '\n').trim();
  return withNewlines.includes('-----BEGIN') ? withNewlines : undefined;
}

/**
 * Fail-fast boot validation (PHASE_02 §8). Call once during application bootstrap.
 * Missing values throw with a single aggregated message and never leak the value.
 */
export function assertRuntimeEnv(candidate: AppEnv = env): AppEnv {
  const missing: string[] = [];
  if (!candidate.DATABASE_URL) missing.push('DATABASE_URL');
  if (!normalisePem(candidate.JWT_PRIVATE_KEY)) missing.push('JWT_PRIVATE_KEY');
  if (!normalisePem(candidate.JWT_PUBLIC_KEY)) missing.push('JWT_PUBLIC_KEY');
  if (candidate.NODE_ENV === 'production' && !candidate.DATA_ENC_KEY) missing.push('DATA_ENC_KEY');
  // AUD-09: بدون الـpepper تُبصم مفاتيح الأجهزة بسرٍّ معروف — الإنتاج لا يُقلع بلا قيمة.
  if (candidate.NODE_ENV === 'production' && !candidate.COMPAT_KEY_PEPPER) missing.push('COMPAT_KEY_PEPPER');

  if (missing.length > 0 || parsed.issues.length > 0) {
    const lines = ['Invalid environment.'];
    if (missing.length > 0) lines.push(`  Missing required variable(s): ${missing.join(', ')}`);
    if (parsed.issues.length > 0) lines.push(`  Rejected value(s): ${parsed.issues.join('; ')}`);
    lines.push(`  Loaded .env files: ${describeEnvSources()}`);
    lines.push('  Fix: run `pnpm env:setup` at the repository root, then re-run the command.');
    throw new Error(lines.join('\n'));
  }
  return candidate;
}

export type ObjectStorageEnv = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  forcePathStyle: boolean;
  presignExpirySeconds: number;
};

/**
 * PHASE_04 §5.3 — "S3 env validation". Object storage is optional at boot (the API runs
 * without it; every other endpoint keeps working) but a file endpoint must fail loudly
 * rather than hand out an unusable URL, so the check happens where the value is used.
 */
export function readObjectStorageEnv(candidate: AppEnv = env): ObjectStorageEnv | undefined {
  const missing = objectStorageGaps(candidate);
  if (missing.length > 0) return undefined;
  return {
    endpoint: (candidate.S3_ENDPOINT as string).replace(/\/+$/, ''),
    bucket: candidate.S3_BUCKET as string,
    accessKeyId: candidate.S3_ACCESS_KEY_ID as string,
    secretAccessKey: candidate.S3_SECRET_ACCESS_KEY as string,
    region: candidate.S3_REGION,
    forcePathStyle: candidate.S3_FORCE_PATH_STYLE,
    presignExpirySeconds: candidate.S3_PRESIGN_EXPIRY_SECONDS,
  };
}

export function objectStorageGaps(candidate: AppEnv = env): string[] {
  const missing: string[] = [];
  if (!candidate.S3_ENDPOINT) missing.push('S3_ENDPOINT');
  if (!candidate.S3_BUCKET) missing.push('S3_BUCKET');
  if (!candidate.S3_ACCESS_KEY_ID) missing.push('S3_ACCESS_KEY_ID');
  if (!candidate.S3_SECRET_ACCESS_KEY) missing.push('S3_SECRET_ACCESS_KEY');
  return missing;
}

export function assertObjectStorageEnv(candidate: AppEnv = env): ObjectStorageEnv {
  const storage = readObjectStorageEnv(candidate);
  if (!storage) {
    throw new Error(
      `Object storage is not configured: missing ${objectStorageGaps(candidate).join(', ')}. ` +
        'See infrastructure/docker-compose.yml for the local MinIO defaults.',
    );
  }
  return storage;
}

/**
 * Values that must never reach a log line (PROJECT_CONTRACT §10, PHASE_02 §5.2:
 * "redact password|secret|token|key paths"). Both the bare and the nested form are
 * listed because pino treats `password` and `*.password` as different paths.
 */
export const REDACTED_LOG_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-branch-id"]',
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'current',
  '*.current',
  'new',
  '*.new',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'token',
  '*.token',
  'tokenHash',
  '*.tokenHash',
  'mfaCode',
  '*.mfaCode',
  'mfaSecretEnc',
  '*.mfaSecretEnc',
  'secret',
  '*.secret',
  'key',
  '*.key',
  'apiKey',
  '*.apiKey',
  'api_key',
  '*.api_key',
] as const;
