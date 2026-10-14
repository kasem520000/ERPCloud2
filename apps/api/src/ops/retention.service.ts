import { Injectable } from '@nestjs/common';

export type RetentionPlan = {
  auditArchiveBefore: string;
  idempotencyPurgeBefore: string;
  outboxPurgeBefore: string;
  fileOrphanPurgeBefore: string;
  auditHardDeleteAllowed: false;
};

@Injectable()
export class RetentionService {
  plan(now = new Date()): RetentionPlan {
    return computeRetentionPlan(now);
  }
}

export function computeRetentionPlan(now = new Date()): RetentionPlan {
  return {
    auditArchiveBefore: shiftDays(now, -365).toISOString(),
    idempotencyPurgeBefore: shiftDays(now, -30).toISOString(),
    outboxPurgeBefore: shiftDays(now, -90).toISOString(),
    fileOrphanPurgeBefore: shiftDays(now, -2).toISOString(),
    auditHardDeleteAllowed: false,
  };
}

function shiftDays(now: Date, days: number): Date { return new Date(now.getTime() + days * 86_400_000); }
