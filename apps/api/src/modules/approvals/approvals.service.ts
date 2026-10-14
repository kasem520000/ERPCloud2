import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  APPROVAL_APPROVED_EVENT,
  APPROVAL_APPROVED_NOTIFICATION,
  APPROVAL_REJECTED_NOTIFICATION,
  APPROVAL_REQUESTED_NOTIFICATION,
  approvalConditionSchema,
  approvalEntityTypeSchema,
  errorCodes,
  DomainError,
  newId,
  type ApprovalDecisionInput,
  type ApprovalEntityType,
  type ApprovalStepInput,
  type ApprovalWorkflowInput,
} from '@erp/contracts';
import {
  approvalDecisions,
  approvalRequests,
  approvalSteps,
  approvalWorkflows,
  memberships,
  membershipRoles,
  roles,
  withTenantTx,
  type ApprovalRequest,
  type ApprovalStep,
  type ApprovalWorkflow,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { DomainEventsService } from '../../events/domain-events.service.js';
import { tryGetAuthContext } from '../platform/context/tenant-context.js';
import { NotificationsService } from '../platform-services/notifications/notifications.service.js';
import { isUniqueViolation } from '../organization/shared/org-support.js';

export type ApprovalContext = {
  amount?: string | null;
  branchId?: string | null;
  costCenterId?: string | null;
  /** Original posting options are replayed by the final approval event. */
  posting?: Record<string, unknown> | null;
};

type ApprovalStepRow = ApprovalStep;
type ApprovalRequestResult = { dto: ReturnType<ApprovalService['toRequestDto']>; completed: boolean };

/**
 * The Phase 04 engine.  It owns workflow selection and the sequential state machine;
 * domain modules only ask `ensureApprovalRequired` before doing irreversible posting.
 */
@Injectable()
export class ApprovalService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly notifications: NotificationsService,
    private readonly events: DomainEventsService,
  ) {}

  // --------------------------------------------------------------------------- workflows

  async listWorkflows(tenantId: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(approvalWorkflows)
        .where(eq(approvalWorkflows.tenantId, tenantId))
        .orderBy(asc(approvalWorkflows.createdAt));
      return this.withSteps(tx, rows);
    });
  }

  async getWorkflow(tenantId: string, workflowId: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const workflow = await this.mustWorkflow(tx, tenantId, workflowId);
      return this.withSteps(tx, [workflow]).then((rows) => rows[0]);
    });
  }

  async createWorkflow(tenantId: string, actorUserId: string, input: ApprovalWorkflowInput) {
    const normalized = this.normalizeWorkflowInput(input);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.assertWorkflowNameAvailable(tx, tenantId, normalized.name);
      await this.assertDirectUsersBelongToTenant(tx, tenantId, normalized.steps);
      const id = newId();
      const [workflow] = await tx
        .insert(approvalWorkflows)
        .values({
          id,
          tenantId,
          entity: normalized.entity,
          name: normalized.name,
          isActive: normalized.is_active,
          createdBy: actorUserId,
        })
        .returning();
      await this.insertSteps(tx, id, normalized.steps);
      return (await this.withSteps(tx, [workflow as ApprovalWorkflow]))[0];
    });
  }

  async updateWorkflow(
    tenantId: string,
    actorUserId: string,
    workflowId: string,
    input: ApprovalWorkflowInput,
  ) {
    const normalized = this.normalizeWorkflowInput(input);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const current = await this.mustWorkflow(tx, tenantId, workflowId);
      if (normalized.name !== current.name) {
        await this.assertWorkflowNameAvailable(tx, tenantId, normalized.name, workflowId);
      }
      await this.assertDirectUsersBelongToTenant(tx, tenantId, normalized.steps);
      await tx
        .update(approvalWorkflows)
        .set({
          entity: normalized.entity,
          name: normalized.name,
          isActive: normalized.is_active,
          updatedAt: new Date(),
          updatedBy: actorUserId,
          version: current.version + 1,
        })
        .where(and(eq(approvalWorkflows.tenantId, tenantId), eq(approvalWorkflows.id, workflowId)));
      await tx.delete(approvalSteps).where(eq(approvalSteps.workflowId, workflowId));
      await this.insertSteps(tx, workflowId, normalized.steps);
      const [workflow] = await tx
        .select()
        .from(approvalWorkflows)
        .where(and(eq(approvalWorkflows.tenantId, tenantId), eq(approvalWorkflows.id, workflowId)));
      return (await this.withSteps(tx, [workflow as ApprovalWorkflow]))[0];
    });
  }

  /** DELETE is a safe deactivate: historical requests keep their workflow reference. */
  async deactivateWorkflow(tenantId: string, actorUserId: string, workflowId: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.mustWorkflow(tx, tenantId, workflowId);
      const [workflow] = await tx
        .update(approvalWorkflows)
        .set({ isActive: false, updatedAt: new Date(), updatedBy: actorUserId })
        .where(and(eq(approvalWorkflows.tenantId, tenantId), eq(approvalWorkflows.id, workflowId)))
        .returning();
      return (await this.withSteps(tx, [workflow as ApprovalWorkflow]))[0];
    });
  }

  async listSteps(tenantId: string, workflowId: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.mustWorkflow(tx, tenantId, workflowId);
      const rows = await tx
        .select()
        .from(approvalSteps)
        .where(eq(approvalSteps.workflowId, workflowId))
        .orderBy(asc(approvalSteps.stepOrder));
      return rows.map((row) => this.toStepDto(row));
    });
  }

  async addStep(tenantId: string, workflowId: string, input: ApprovalStepInput) {
    const parsed = this.normalizeStep(input, 1);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.mustWorkflow(tx, tenantId, workflowId);
      await this.assertDirectUsersBelongToTenant(tx, tenantId, [parsed]);
      const existing = await tx
        .select({ stepOrder: approvalSteps.stepOrder })
        .from(approvalSteps)
        .where(eq(approvalSteps.workflowId, workflowId))
        .orderBy(desc(approvalSteps.stepOrder));
      const stepOrder = input.step_order ?? (existing[0]?.stepOrder ?? 0) + 1;
      if (existing.some((row) => row.stepOrder === stepOrder)) {
        throw new DomainError(errorCodes.VALIDATION_FAILED, 'Step order is already used by this workflow', 422, {
          field: 'step_order',
        });
      }
      const [step] = await tx
        .insert(approvalSteps)
        .values({ ...this.stepValues(parsed), id: newId(), workflowId, stepOrder })
        .returning();
      return this.toStepDto(step as ApprovalStep);
    });
  }

  // --------------------------------------------------------------------------- posting gate

  /** Used by atomic POS callers to decide whether they must leave the atomic path. */
  async hasApplicableWorkflow(
    tenantId: string,
    entityType: ApprovalEntityType,
    context: ApprovalContext,
  ): Promise<boolean> {
    return withTenantTx(this.database.db, tenantId, async (tx) =>
      Boolean(await this.findApplicableWorkflowInTx(tx, tenantId, entityType, context)),
    );
  }

  /**
   * Creates the request and its first in-app notifications in one transaction.  A true
   * return means the caller may continue posting (there was no applicable workflow, or a
   * notify-only chain completed); otherwise this method throws the stable 202 gate.
   */
  async ensureApprovalRequired(
    tenantId: string,
    entityType: ApprovalEntityType,
    entityId: string,
    context: ApprovalContext,
  ): Promise<boolean> {
    const actor = tryGetAuthContext();
    try {
      const result = await withTenantTx(this.database.db, tenantId, async (tx) => {
        const match = await this.findApplicableWorkflowInTx(tx, tenantId, entityType, context);
        if (!match) return { continuePosting: true, requestId: null };

        const existing = await tx
          .select({ id: approvalRequests.id })
          .from(approvalRequests)
          .where(
            and(
              eq(approvalRequests.tenantId, tenantId),
              eq(approvalRequests.entityType, entityType),
              eq(approvalRequests.entityId, entityId),
              eq(approvalRequests.status, 'pending'),
            ),
          )
          .limit(1);
        // Never throw from inside the transaction: doing so would roll back the request
        // that the caller must now approve.
        if (existing[0]) return { continuePosting: false, requestId: existing[0].id };

        const previousApproved = await tx
          .select({ id: approvalRequests.id })
          .from(approvalRequests)
          .where(
            and(
              eq(approvalRequests.tenantId, tenantId),
              eq(approvalRequests.entityType, entityType),
              eq(approvalRequests.entityId, entityId),
              eq(approvalRequests.status, 'approved'),
            ),
          )
          .limit(1);
        // The final approval handler may be racing the original post request. Once an
        // approved request exists, never open a second chain for the same document.
        if (previousApproved[0]) return { continuePosting: true, requestId: null };

        const requestId = newId();
        const contextJson = {
          amount: context.amount ?? null,
          branch_id: context.branchId ?? null,
          cost_center_id: context.costCenterId ?? null,
          posting: context.posting ?? null,
        };
        await tx.insert(approvalRequests).values({
          id: requestId,
          tenantId,
          workflowId: match.workflow.id,
          entityType,
          entityId,
          status: 'pending',
          currentStepOrder: match.steps[0]?.stepOrder ?? null,
          contextJson,
          createdBy: actor?.userId ?? null,
        });

        const state = await this.advanceNotifyStepsInTx(tx, tenantId, {
          requestId,
          workflow: match.workflow,
          steps: match.steps,
          context: contextJson,
          entityType,
          entityId,
          createdBy: actor?.userId ?? null,
        });
        return { continuePosting: state.completed, requestId: state.completed ? null : requestId };
      });

      if (!result.continuePosting && result.requestId) this.throwApprovalRequired(result.requestId);
      return true;
    } catch (error) {
      // The partial unique index is the final idempotency authority under concurrent
      // POSTs. Return the already-created request rather than leaking a 500.
      if (isUniqueViolation(error, 'approval_requests_pending_entity_key')) {
        const existing = await withTenantTx(this.database.db, tenantId, async (tx) =>
          tx
            .select({ id: approvalRequests.id, status: approvalRequests.status })
            .from(approvalRequests)
            .where(
              and(
                eq(approvalRequests.tenantId, tenantId),
                eq(approvalRequests.entityType, entityType),
                eq(approvalRequests.entityId, entityId),
                inArray(approvalRequests.status, ['pending', 'approved']),
              ),
            )
            .orderBy(desc(approvalRequests.createdAt))
            .limit(1),
        );
        if (existing[0]?.status === 'pending') this.throwApprovalRequired(existing[0].id);
        if (existing[0]?.status === 'approved') return true;
      }
      throw error;
    }
  }

  // --------------------------------------------------------------------------- inbox and history

  async listInbox(tenantId: string, userId: string, membershipId: string, status = 'pending') {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const statusValues = this.parseStatuses(status);
      const requests = await tx
        .select()
        .from(approvalRequests)
        .where(and(eq(approvalRequests.tenantId, tenantId), inArray(approvalRequests.status, statusValues)))
        .orderBy(desc(approvalRequests.createdAt));
      const roleKeys = await this.actorRoleKeys(tx, membershipId);
      const result = [];
      for (const request of requests) {
        const detail = await this.requestDetailInTx(tx, tenantId, request, userId, roleKeys);
        if (request.status !== 'pending' || detail.canAct) result.push(detail);
      }
      return result;
    });
  }

  async listHistory(tenantId: string, status?: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const statuses = status ? this.parseStatuses(status) : (['approved', 'rejected'] as const);
      const requests = await tx
        .select()
        .from(approvalRequests)
        .where(and(eq(approvalRequests.tenantId, tenantId), inArray(approvalRequests.status, statuses)))
        .orderBy(desc(approvalRequests.createdAt));
      const result = [];
      for (const request of requests) result.push(await this.requestDetailInTx(tx, tenantId, request));
      return result;
    });
  }

  async getRequest(tenantId: string, requestId: string, userId?: string, membershipId?: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const request = await this.mustRequest(tx, tenantId, requestId);
      const roleKeys = membershipId ? await this.actorRoleKeys(tx, membershipId) : [];
      return this.requestDetailInTx(tx, tenantId, request, userId, roleKeys);
    });
  }

  async latestForEntity(tenantId: string, entityType: ApprovalEntityType, entityId: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [request] = await tx
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.tenantId, tenantId),
            eq(approvalRequests.entityType, entityType),
            eq(approvalRequests.entityId, entityId),
          ),
        )
        .orderBy(desc(approvalRequests.createdAt))
        .limit(1);
      return request ? this.requestDetailInTx(tx, tenantId, request) : null;
    });
  }

  async decide(
    tenantId: string,
    requestId: string,
    userId: string,
    membershipId: string,
    decision: 'approved' | 'rejected',
    input: ApprovalDecisionInput,
  ) {
    let completed = false;
    let replayPosting: Record<string, unknown> | null = null;
    let result!: ApprovalRequestResult['dto'];
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const request = await this.mustRequest(tx, tenantId, requestId);
      replayPosting = this.contextFromRequest(request).posting ?? null;
      if (request.status !== 'pending' || request.currentStepOrder === null) {
        throw new DomainError(errorCodes.INVALID_STATE, 'This approval request is no longer pending', 409);
      }
      const workflow = await this.mustWorkflow(tx, tenantId, request.workflowId);
      const steps = await tx
        .select()
        .from(approvalSteps)
        .where(eq(approvalSteps.workflowId, workflow.id))
        .orderBy(asc(approvalSteps.stepOrder));
      const context = this.contextFromRequest(request);
      const applicable = steps.filter((step) => this.conditionMatches(step.conditionJson, context));
      const current = applicable.find((step) => step.stepOrder === request.currentStepOrder);
      if (!current || current.action !== 'approve') {
        throw new DomainError(errorCodes.INVALID_STATE, 'The current approval step is not actionable', 409);
      }
      const roleKeys = await this.actorRoleKeys(tx, membershipId);
      if (!this.canActorAct(current, userId, roleKeys)) {
        throw new DomainError(errorCodes.FORBIDDEN, 'This approval is not assigned to you', 403);
      }

      const [existingDecision] = await tx
        .select({ id: approvalDecisions.id })
        .from(approvalDecisions)
        .where(and(eq(approvalDecisions.requestId, requestId), eq(approvalDecisions.stepId, current.id)))
        .limit(1);
      if (existingDecision) {
        throw new DomainError(errorCodes.INVALID_STATE, 'This approval step already has a decision', 409);
      }

      await tx.insert(approvalDecisions).values({
        id: newId(),
        requestId,
        stepId: current.id,
        userId,
        decision,
        comment: input.comment?.trim() || null,
      });

      if (decision === 'rejected') {
        await tx
          .update(approvalRequests)
          .set({ status: 'rejected', currentStepOrder: null, updatedAt: new Date() })
          .where(and(eq(approvalRequests.tenantId, tenantId), eq(approvalRequests.id, requestId)));
        await this.notifyCreatorInTx(tx, tenantId, request, APPROVAL_REJECTED_NOTIFICATION, {
          requestId,
          entityType: request.entityType,
          entityId: request.entityId,
          comment: input.comment?.trim() || null,
        });
      } else {
        const currentIndex = applicable.findIndex((step) => step.id === current.id);
        const next = applicable[currentIndex + 1];
        if (!next) {
          completed = true;
          await tx
            .update(approvalRequests)
            .set({ status: 'approved', currentStepOrder: null, updatedAt: new Date() })
            .where(and(eq(approvalRequests.tenantId, tenantId), eq(approvalRequests.id, requestId)));
          await this.notifyCreatorInTx(tx, tenantId, request, APPROVAL_APPROVED_NOTIFICATION, {
            requestId,
            entityType: request.entityType,
            entityId: request.entityId,
          });
        } else {
          const state = await this.advanceNotifyStepsInTx(tx, tenantId, {
            requestId,
            workflow,
            steps: applicable,
            context,
            entityType: request.entityType,
            entityId: request.entityId,
            createdBy: request.createdBy,
            startAt: currentIndex + 1,
          });
          completed = state.completed;
        }
      }
      const updated = await this.mustRequest(tx, tenantId, requestId);
      result = await this.requestDetailInTx(tx, tenantId, updated, userId, roleKeys);
    });

    if (completed && result) {
      await this.events.emit({
        type: APPROVAL_APPROVED_EVENT,
        tenantId,
        actorUserId: userId,
        membershipId,
        payload: {
          requestId,
          entityType: result.entityType,
          entityId: result.entityId,
          posting: replayPosting,
        },
      });
    }
    return result;
  }

  // --------------------------------------------------------------------------- internals

  private normalizeWorkflowInput(input: ApprovalWorkflowInput): ApprovalWorkflowInput {
    const entity = approvalEntityTypeSchema.parse(input.entity);
    const used = new Set<number>();
    const steps = input.steps.map((step, index) => {
      const normalized = this.normalizeStep(step, index + 1);
      if (used.has(normalized.stepOrder)) {
        throw new DomainError(errorCodes.VALIDATION_FAILED, 'Step orders must be unique', 422, {
          field: 'steps.step_order',
        });
      }
      used.add(normalized.stepOrder);
      return normalized;
    });
    steps.sort((left, right) => left.stepOrder - right.stepOrder);
    return { ...input, entity, name: input.name.trim(), steps: steps as ApprovalStepInput[] };
  }

  private normalizeStep(input: ApprovalStepInput, fallbackOrder: number): ApprovalStepInput & { stepOrder: number } {
    const condition = approvalConditionSchema.parse(input.condition ?? {});
    return {
      ...input,
      stepOrder: input.step_order ?? fallbackOrder,
      approver_role: input.approver_role?.trim() || undefined,
      condition,
      action: input.action ?? 'approve',
      is_required: input.is_required ?? true,
    };
  }

  private stepValues(step: ApprovalStepInput & { stepOrder: number }) {
    return {
      stepOrder: step.stepOrder,
      approverRole: step.approver_role ?? null,
      approverUserId: step.approver_user_id ?? null,
      conditionJson: step.condition as Record<string, unknown>,
      action: step.action,
      isRequired: step.is_required,
    };
  }

  private async insertSteps(tx: DrizzleTx, workflowId: string, steps: ApprovalStepInput[]): Promise<void> {
    await tx.insert(approvalSteps).values(
      steps.map((raw, index) => {
        const normalized = this.normalizeStep(raw, index + 1);
        const step =
          'stepOrder' in raw && typeof raw.stepOrder === 'number'
            ? { ...normalized, stepOrder: raw.stepOrder }
            : normalized;
        return { ...this.stepValues(step), id: newId(), workflowId };
      }),
    );
  }

  private async withSteps(tx: DrizzleTx, workflows: ApprovalWorkflow[]) {
    const result = [];
    for (const workflow of workflows) {
      const steps = await tx
        .select()
        .from(approvalSteps)
        .where(eq(approvalSteps.workflowId, workflow.id))
        .orderBy(asc(approvalSteps.stepOrder));
      result.push({
        id: workflow.id,
        tenantId: workflow.tenantId,
        entity: workflow.entity,
        name: workflow.name,
        isActive: workflow.isActive,
        steps: steps.map((step) => this.toStepDto(step)),
        createdAt: workflow.createdAt.toISOString(),
        updatedAt: workflow.updatedAt?.toISOString() ?? null,
      });
    }
    return result;
  }

  private async findApplicableWorkflowInTx(
    tx: DrizzleTx,
    tenantId: string,
    entityType: ApprovalEntityType,
    context: ApprovalContext,
  ): Promise<{ workflow: ApprovalWorkflow; steps: ApprovalStep[] } | undefined> {
    const workflows = await tx
      .select()
      .from(approvalWorkflows)
      .where(
        and(
          eq(approvalWorkflows.tenantId, tenantId),
          eq(approvalWorkflows.entity, entityType),
          eq(approvalWorkflows.isActive, true),
        ),
      )
      .orderBy(asc(approvalWorkflows.createdAt));
    for (const workflow of workflows) {
      const steps = await tx
        .select()
        .from(approvalSteps)
        .where(eq(approvalSteps.workflowId, workflow.id))
        .orderBy(asc(approvalSteps.stepOrder));
      const applicable = steps.filter((step) => this.conditionMatches(step.conditionJson, context));
      if (applicable.length > 0) return { workflow, steps: applicable };
    }
    return undefined;
  }

  private conditionMatches(conditionJson: Record<string, unknown>, context: ApprovalContext): boolean {
    const condition = approvalConditionSchema.safeParse(conditionJson ?? {});
    if (!condition.success) return false;
    const value = context.amount == null ? undefined : new Decimal(context.amount);
    if (condition.data.min_amount !== undefined) {
      if (!value || value.lt(String(condition.data.min_amount))) return false;
    }
    if (condition.data.max_amount !== undefined) {
      if (!value || value.gt(String(condition.data.max_amount))) return false;
    }
    if (condition.data.branch_id !== undefined && condition.data.branch_id !== null) {
      if (condition.data.branch_id !== context.branchId) return false;
    }
    if (condition.data.cost_center_id !== undefined && condition.data.cost_center_id !== null) {
      if (condition.data.cost_center_id !== context.costCenterId) return false;
    }
    return true;
  }

  private contextFromRequest(request: ApprovalRequest): ApprovalContext {
    const context = request.contextJson ?? {};
    return {
      amount: typeof context.amount === 'string' || typeof context.amount === 'number' ? String(context.amount) : null,
      branchId: typeof context.branch_id === 'string' ? context.branch_id : null,
      costCenterId: typeof context.cost_center_id === 'string' ? context.cost_center_id : null,
      posting: context.posting && typeof context.posting === 'object' ? (context.posting as Record<string, unknown>) : null,
    };
  }

  private async advanceNotifyStepsInTx(
    tx: DrizzleTx,
    tenantId: string,
    input: {
      requestId: string;
      workflow: ApprovalWorkflow;
      steps: ApprovalStep[];
      context: ApprovalContext;
      entityType: string;
      entityId: string;
      createdBy: string | null;
      startAt?: number;
    },
  ): Promise<{ completed: boolean }> {
    let index = input.startAt ?? 0;
    while (index < input.steps.length && input.steps[index]) {
      const step = input.steps[index] as ApprovalStep;
      await tx
        .update(approvalRequests)
        .set({ currentStepOrder: step.stepOrder, updatedAt: new Date() })
        .where(eq(approvalRequests.id, input.requestId));
      await this.notifyStepInTx(tx, tenantId, step, {
        requestId: input.requestId,
        entityType: input.entityType,
        entityId: input.entityId,
        workflowId: input.workflow.id,
        stepOrder: step.stepOrder,
        action: step.action,
      });
      if (step.action === 'approve') return { completed: false };
      index += 1;
    }
    await tx
      .update(approvalRequests)
      .set({ status: 'approved', currentStepOrder: null, updatedAt: new Date() })
      .where(eq(approvalRequests.id, input.requestId));
    await this.notifyCreatorInTx(tx, tenantId, { createdBy: input.createdBy }, APPROVAL_APPROVED_NOTIFICATION, {
      requestId: input.requestId,
      entityType: input.entityType,
      entityId: input.entityId,
    });
    return { completed: true };
  }

  private async notifyStepInTx(
    tx: DrizzleTx,
    tenantId: string,
    step: ApprovalStep,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const recipients = await this.recipientsForStepInTx(tx, tenantId, step);
    for (const membershipId of recipients) {
      await this.notifications.createInTx(tx, {
        tenantId,
        membershipId,
        type: APPROVAL_REQUESTED_NOTIFICATION,
        payload,
      });
    }
  }

  private async notifyCreatorInTx(
    tx: DrizzleTx,
    tenantId: string,
    request: Pick<ApprovalRequest, 'createdBy'>,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!request.createdBy) return;
    const [membership] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.userId, request.createdBy),
          eq(memberships.status, 'active'),
          isNull(memberships.deletedAt),
        ),
      )
      .limit(1);
    if (!membership) return;
    await this.notifications.createInTx(tx, { tenantId, membershipId: membership.id, type, payload });
  }

  private async recipientsForStepInTx(tx: DrizzleTx, tenantId: string, step: ApprovalStep): Promise<string[]> {
    const ids = new Set<string>();
    if (step.approverUserId) {
      const [membership] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.tenantId, tenantId),
            eq(memberships.userId, step.approverUserId),
            eq(memberships.status, 'active'),
            eq(memberships.kind, 'staff'),
            isNull(memberships.deletedAt),
          ),
        )
        .limit(1);
      if (membership) ids.add(membership.id);
    }
    if (step.approverRole) {
      const rows = await tx
        .select({ membershipId: memberships.id, roleName: roles.name })
        .from(membershipRoles)
        .innerJoin(memberships, eq(memberships.id, membershipRoles.membershipId))
        .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
        .where(
          and(
            eq(memberships.tenantId, tenantId),
            eq(memberships.status, 'active'),
            eq(memberships.kind, 'staff'),
            isNull(memberships.deletedAt),
            isNull(roles.deletedAt),
          ),
        );
      const wanted = this.roleKey(step.approverRole);
      for (const row of rows) if (this.roleKey(row.roleName) === wanted) ids.add(row.membershipId);
    }
    return [...ids];
  }

  private async actorRoleKeys(tx: DrizzleTx, membershipId: string): Promise<string[]> {
    const rows = await tx
      .select({ name: roles.name })
      .from(membershipRoles)
      .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
      .where(and(eq(membershipRoles.membershipId, membershipId), isNull(roles.deletedAt)));
    return rows.map((row) => this.roleKey(row.name));
  }

  private canActorAct(step: ApprovalStep, userId: string, roleKeys: string[]): boolean {
    return Boolean(
      (step.approverUserId && step.approverUserId === userId) ||
        (step.approverRole && roleKeys.includes(this.roleKey(step.approverRole))),
    );
  }

  private roleKey(value: string): string {
    return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  }

  private async requestDetailInTx(
    tx: DrizzleTx,
    tenantId: string,
    request: ApprovalRequest,
    userId?: string,
    roleKeys: string[] = [],
  ) {
    const [workflow] = await tx
      .select()
      .from(approvalWorkflows)
      .where(and(eq(approvalWorkflows.tenantId, tenantId), eq(approvalWorkflows.id, request.workflowId)))
      .limit(1);
    const steps = await tx
      .select()
      .from(approvalSteps)
      .where(eq(approvalSteps.workflowId, request.workflowId))
      .orderBy(asc(approvalSteps.stepOrder));
    const [current] = steps.filter((step) => step.stepOrder === request.currentStepOrder);
    const decisions = await tx
      .select()
      .from(approvalDecisions)
      .where(eq(approvalDecisions.requestId, request.id))
      .orderBy(asc(approvalDecisions.decidedAt));
    return this.toRequestDto(request, workflow?.name ?? null, current, decisions, userId, roleKeys);
  }

  private toRequestDto(
    request: ApprovalRequest,
    workflowName: string | null,
    current: ApprovalStep | undefined,
    decisions: typeof approvalDecisions.$inferSelect[],
    userId?: string,
    roleKeys: string[] = [],
  ) {
    return {
      id: request.id,
      tenantId: request.tenantId,
      workflowId: request.workflowId,
      entityType: request.entityType as ApprovalEntityType,
      entityId: request.entityId,
      status: request.status as 'pending' | 'approved' | 'rejected',
      currentStepOrder: request.currentStepOrder,
      createdBy: request.createdBy,
      createdAt: request.createdAt.toISOString(),
      updatedAt: request.updatedAt?.toISOString() ?? null,
      workflowName,
      currentStep: current ? this.toStepDto(current) : null,
      decisions: decisions.map((decision) => ({
        id: decision.id,
        requestId: decision.requestId,
        stepId: decision.stepId,
        userId: decision.userId,
        decision: decision.decision as 'approved' | 'rejected',
        comment: decision.comment,
        decidedAt: decision.decidedAt.toISOString(),
      })),
      canAct: Boolean(
        request.status === 'pending' &&
          current &&
          current.action === 'approve' &&
          userId &&
          this.canActorAct(current, userId, roleKeys),
      ),
    };
  }

  private toStepDto(row: ApprovalStepRow) {
    const parsed = approvalConditionSchema.safeParse(row.conditionJson ?? {});
    return {
      id: row.id,
      workflowId: row.workflowId,
      stepOrder: row.stepOrder,
      approverRole: row.approverRole,
      approverUserId: row.approverUserId,
      condition: parsed.success ? parsed.data : {},
      action: row.action as 'approve' | 'notify',
      isRequired: row.isRequired,
    };
  }

  private parseStatuses(value: string): ('pending' | 'approved' | 'rejected')[] {
    const values = value
      .split(',')
      .map((item) => item.trim())
      .filter((item): item is 'pending' | 'approved' | 'rejected' =>
        item === 'pending' || item === 'approved' || item === 'rejected',
      );
    if (values.length === 0) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'status must be pending, approved or rejected', 422, {
        field: 'status',
      });
    }
    return [...new Set(values)];
  }

  private async mustWorkflow(tx: DrizzleTx, tenantId: string, workflowId: string): Promise<ApprovalWorkflow> {
    const [workflow] = await tx
      .select()
      .from(approvalWorkflows)
      .where(and(eq(approvalWorkflows.tenantId, tenantId), eq(approvalWorkflows.id, workflowId)))
      .limit(1);
    if (!workflow) throw new DomainError(errorCodes.NOT_FOUND, 'Approval workflow was not found', 404);
    return workflow;
  }

  private async mustRequest(tx: DrizzleTx, tenantId: string, requestId: string): Promise<ApprovalRequest> {
    const [request] = await tx
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.tenantId, tenantId), eq(approvalRequests.id, requestId)))
      .limit(1);
    if (!request) throw new DomainError(errorCodes.NOT_FOUND, 'Approval request was not found', 404);
    return request;
  }

  private async assertWorkflowNameAvailable(
    tx: DrizzleTx,
    tenantId: string,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const [existing] = await tx
      .select({ id: approvalWorkflows.id })
      .from(approvalWorkflows)
      .where(and(eq(approvalWorkflows.tenantId, tenantId), eq(approvalWorkflows.name, name)))
      .limit(1);
    if (existing && existing.id !== exceptId) {
      throw new DomainError(errorCodes.VERSION_CONFLICT, 'An approval workflow with this name already exists', 409);
    }
  }

  private async assertDirectUsersBelongToTenant(
    tx: DrizzleTx,
    tenantId: string,
    steps: ApprovalStepInput[],
  ): Promise<void> {
    const userIds = [...new Set(steps.map((step) => step.approver_user_id).filter((id): id is string => Boolean(id)))];
    if (!userIds.length) return;
    const rows = await tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          inArray(memberships.userId, userIds),
          eq(memberships.status, 'active'),
          isNull(memberships.deletedAt),
        ),
      );
    const found = new Set(rows.map((row) => row.userId));
    if (userIds.some((userId) => !found.has(userId))) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'Every approver user must be an active tenant member', 422, {
        field: 'approver_user_id',
      });
    }
  }

  private throwApprovalRequired(requestId: string): never {
    throw new DomainError(
      errorCodes.APPROVAL_REQUIRED,
      'This document was submitted for approval and has not been posted',
      202,
      { requestId },
    );
  }
}
