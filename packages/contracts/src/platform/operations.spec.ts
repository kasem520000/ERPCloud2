import { describe, expect, it } from 'vitest';

import {
  healthProbeNames,
  healthProbeStatuses,
  operationsAuditActions,
  PLATFORM_FILE_FILTERS,
  PLATFORM_JOB_FILTERS,
  PLATFORM_JOB_SORTS,
  platformFileActionSchema,
  platformFileQuerySchema,
  platformFileRowSchema,
  platformFileScanResultSchema,
  platformHealthSchema,
  platformJobActionSchema,
  platformJobActions,
  platformJobQuerySchema,
  platformJobRowSchema,
  platformJobStatuses,
  workerHeartbeatSchema,
} from './operations.js';

/**
 * عقد العمليات (P-C9). ما يُختبَر هنا **ما لا يحتاج قاعدة**: أسماء المجسّات، والحالات
 * الثلاث للطابور، ومعنى `null` في حكم الفحص («لم يُفحص» ≠ «نظيف»)، وأن الفعلين يطلبان
 * سبباً مكتوباً. أما السلوك (إعادةٌ تصفّر المحاولات، وحجرٌ يُبقي الصفّ) ففي
 * `apps/api/test/platform-operations.spec.ts` وحيّاً في `scripts/verify-platform-operations.mjs`.
 */

const tenantId = '0198f3c2-3d5b-7c9e-9a11-6f2e0f1c4a10';

const jobRow = {
  id: '0198f3c2-3d5b-7c9e-9a11-6f2e0f1c4a11',
  tenantId,
  tenantCode: 'demo',
  queue: 'notifications',
  type: 'email.send',
  status: 'dead',
  attempts: 3,
  lastError: 'SMTP refused connection',
  runAt: '2026-09-17T09:00:00.000Z',
  processedAt: null,
  createdAt: '2026-09-17T08:59:00.000Z',
  payloadKeys: ['emailId', 'tenantId'],
};

const scannedFile = {
  id: '0198f3c2-3d5b-7c9e-9a11-6f2e0f1c4a12',
  tenantId,
  tenantCode: 'demo',
  name: 'كشف-حساب.pdf',
  mime: 'application/pdf',
  sizeBytes: 2048,
  status: 'ready',
  entity: 'sales_invoices',
  entityId: '0198f3c2-3d5b-7c9e-9a11-6f2e0f1c4a13',
  uploadedByLabel: 'مالك المنشأة',
  createdAt: '2026-09-17T09:00:00.000Z',
  deletedAt: null,
  scan: {
    verdict: 'skipped',
    scanner: 'noop',
    detail: 'no scanner configured',
    recordedAt: '2026-09-17T09:00:05.000Z',
  },
};

describe('operations contract (P-C9)', () => {
  it('freezes the queue states and the filters the plan lists', () => {
    expect(platformJobStatuses).toEqual(['pending', 'published', 'dead']);
    expect(PLATFORM_JOB_FILTERS).toEqual(['status', 'queue', 'type', 'tenantId']);
    expect(PLATFORM_JOB_SORTS).toEqual(['createdAt', 'runAt']);
    expect(PLATFORM_FILE_FILTERS).toEqual(['status', 'tenantId', 'entity', 'scan']);
    expect(healthProbeNames).toEqual(['database', 'redis', 'storage', 'email', 'queue', 'worker']);
    // «غير مهيّأ» حالةٌ معلَنة لا عطل: بدونها تُعلن كل بيئة تطوير حادثةً كاذبة.
    expect(healthProbeStatuses).toEqual(['up', 'degraded', 'down', 'not_configured']);
  });

  it('describes a job without ever carrying its payload values', () => {
    const parsed = platformJobRowSchema.parse(jobRow);
    expect(parsed.status).toBe('dead');
    expect(parsed.payloadKeys).toEqual(['emailId', 'tenantId']);
    // الحمولة لا حقل لها في العقد: مفاتيح zod تُجرَّد لا تُمرَّر، فلو أضافها الخادم
    // سهواً لما وصلت إلى الشاشة — وهذا هو الضمان المطلوب («لا قيم عملاء على اللوحة»).
    const stripped = platformJobRowSchema.parse({ ...jobRow, payload: { emailId: 'secret-value' } });
    expect('payload' in stripped).toBe(false);
    expect(JSON.stringify(stripped)).not.toContain('secret-value');
    expect(platformJobRowSchema.safeParse({ ...jobRow, status: 'cancelled' }).success).toBe(false);
    expect(platformJobRowSchema.safeParse({ ...jobRow, attempts: -1 }).success).toBe(false);
  });

  it('makes both job actions state the reason, and freezes what each does', () => {
    expect(platformJobActionSchema.parse({ reason: 'المزوّد عاد للعمل' }).reason).toBe('المزوّد عاد للعمل');
    expect(platformJobActionSchema.safeParse({ reason: 'لا' }).success).toBe(false);
    expect(platformJobActionSchema.safeParse({}).success).toBe(false);
    expect(platformJobActionSchema.safeParse({ reason: 'سببٌ كافٍ', force: true }).success).toBe(false);

    expect(platformJobActions.retry).toEqual({ status: 'pending', clearsAttempts: true, clearsError: true });
    // الإلغاء لا يمسح المحاولات: «كم مرّة حاول وفشل» جزءٌ من تاريخ الصفّ الذي بقي.
    expect(platformJobActions.cancel).toEqual({ status: 'dead', clearsAttempts: false, clearsError: false });
  });

  it('reads health as a roll-up of named probes, never as a sentence', () => {
    const health = platformHealthSchema.parse({
      status: 'degraded',
      checkedAt: '2026-09-17T09:00:00.000Z',
      startedAt: '2026-09-17T08:00:00.000Z',
      uptimeSeconds: 3600,
      incident: { active: true, message: 'ترقية قاعدة البيانات' },
      requests: { count: 120, errors: 3, errorRate: 0.025, p95Ms: 250 },
      backlog: { pending: 4, published: 90, dead: 1, oldestPendingAgeSeconds: 120 },
      probes: [
        { name: 'database', status: 'up', detail: 'ok', latencyMs: 1.5 },
        { name: 'storage', status: 'not_configured', detail: 'no credentials', latencyMs: null },
      ],
    });
    expect(health.status).toBe('degraded');
    expect(health.probes[1]?.latencyMs).toBeNull();
    // نسبة الخطأ نسبةٌ لا عدداً، وأعلى من 1 ليست نسبة.
    expect(
      platformHealthSchema.safeParse({ ...health, requests: { ...health.requests, errorRate: 1.5 } }).success,
    ).toBe(false);
    expect(platformHealthSchema.safeParse({ ...health, uptimeSeconds: -1 }).success).toBe(false);
    expect(
      platformHealthSchema.safeParse({
        ...health,
        probes: [{ name: 'gpu', status: 'up', detail: 'x', latencyMs: null }],
      }).success,
    ).toBe(false);
  });

  it('says «لم يُفحص» with null rather than «نظيف»', () => {
    const parsed = platformFileRowSchema.parse(scannedFile);
    expect(parsed.scan?.verdict).toBe('skipped');
    // ملفٌّ بلا حكم: `null` — وهذا هو الفرق الذي يمنع الشاشة من الكذب.
    const unscanned = platformFileRowSchema.parse({ ...scannedFile, scan: null });
    expect(unscanned.scan).toBeNull();
    expect(
      platformFileRowSchema.safeParse({
        ...scannedFile,
        scan: { verdict: 'ok', scanner: 'x', recordedAt: 'z' },
      }).success,
    ).toBe(false);
    expect(platformFileRowSchema.safeParse({ ...scannedFile, sizeBytes: -1 }).success).toBe(false);
    expect(
      platformFileScanResultSchema.parse({
        fileId: scannedFile.id,
        verdict: 'clean',
        scanner: 'clamav',
        detail: null,
        scannedAt: '2026-09-17T09:00:00.000Z',
      }).verdict,
    ).toBe('clean');
  });

  it('takes a reason for the file actions too', () => {
    expect(platformFileActionSchema.parse({ reason: 'محتوى مشتبه به' }).reason).toBe('محتوى مشتبه به');
    expect(platformFileActionSchema.safeParse({ reason: 'لا' }).success).toBe(false);
    expect(platformFileActionSchema.safeParse({ reason: 'محتوى مشتبه به', purgeObject: true }).success).toBe(
      false,
    );
  });

  it('counts the worker as three honest numbers', () => {
    expect(
      workerHeartbeatSchema.parse({ running: false, enabled: false, oldestPendingAgeSeconds: null }),
    ).toEqual({
      running: false,
      enabled: false,
      oldestPendingAgeSeconds: null,
    });
    expect(
      workerHeartbeatSchema.safeParse({ running: false, enabled: false, oldestPendingAgeSeconds: -5 })
        .success,
    ).toBe(false);
  });

  it('keeps paging inside the frozen caps, and names the four audit actions', () => {
    expect(platformJobQuerySchema.parse({}).limit).toBe(50);
    expect(platformJobQuerySchema.safeParse({ limit: 500 }).success).toBe(false);
    expect(platformFileQuerySchema.parse({ q: 'كشف' }).q).toBe('كشف');
    expect(Object.values(operationsAuditActions)).toEqual([
      'platform.job.retry',
      'platform.job.cancel',
      'platform.file.scan',
      'platform.file.purge',
    ]);
  });
});
