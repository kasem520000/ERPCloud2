import { describe, expect, it } from 'vitest';

import { computeRetentionPlan } from './retention.service.js';

describe('computeRetentionPlan', () => {
  it('keeps audit append-only and computes deterministic retention cutoffs', () => {
    const plan = computeRetentionPlan(new Date('2026-09-07T00:00:00.000Z'));
    expect(plan.auditHardDeleteAllowed).toBe(false);
    expect(plan.auditArchiveBefore).toBe('2025-09-07T00:00:00.000Z');
    expect(plan.idempotencyPurgeBefore).toBe('2026-08-08T00:00:00.000Z');
    expect(plan.outboxPurgeBefore).toBe('2026-06-09T00:00:00.000Z');
    expect(plan.fileOrphanPurgeBefore).toBe('2026-09-05T00:00:00.000Z');
  });
});
