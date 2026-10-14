export const migrationModes = ['analyze', 'dry_run', 'import', 'reconcile', 'rollback'] as const;
export type MigrationMode = (typeof migrationModes)[number];
export const runStatuses = ['queued', 'running', 'succeeded', 'failed', 'rolled_back'] as const;
export type RunStatus = (typeof runStatuses)[number];
export const issueSeverities = ['info', 'warn', 'error', 'block'] as const;
export type IssueSeverity = (typeof issueSeverities)[number];
export const pipelineSteps = ['EXTRACT', 'MAP', 'TRANSFORM', 'VALIDATE', 'STAGE', 'LOAD', 'VERIFY'] as const;
export type PipelineStep = (typeof pipelineSteps)[number];

export type LegacyValue = string | number | boolean | null | undefined;
export type LegacyRow = Record<string, LegacyValue>;
export type LegacySnapshot = Record<string, LegacyRow[]>;

export type MigrationIssueInput = {
  entity: string;
  legacyPk?: string;
  severity: IssueSeverity;
  code: string;
  message: string;
  payload?: Record<string, unknown>;
};

export type RcAnswer = {
  code: string;
  status: 'answered' | 'needs_owner' | 'not_present';
  answer: string;
  evidence: Record<string, unknown>;
};

export type ReconciliationCheck = {
  key: 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7';
  status: 'pass' | 'fail' | 'waived';
  expected: string;
  actual: string;
  variance: string;
  details?: Record<string, unknown>;
};

export type MigrationRunRecord = {
  id: string;
  tenantId: string;
  sourceLabel: string;
  mode: MigrationMode;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  summary: Record<string, unknown>;
  issues: MigrationIssueInput[];
  reconciliation?: { checks: ReconciliationCheck[]; signedAt: string; artifact: string };
};

export interface LegacySource {
  readonly label: string;
  readonly readOnly: true;
  extract(tableName: string): Promise<LegacyRow[]>;
  listTables(): Promise<string[]>;
}
