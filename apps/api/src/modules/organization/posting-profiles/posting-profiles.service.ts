import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  DomainError,
  POSTING_PROFILE_FILTERS,
  POSTING_PROFILE_SORT_COLUMNS,
  POSTING_PROFILE_WILDCARD,
  buildMeta,
  errorCodes,
  parseFilters,
  parseSort,
  postProfileV1Schema,
  type ListEnvelope,
  type OrgListQuery,
  type PostProfileV1,
  type PostingProfileDto,
  type PostingProfileResolutionDto,
  type PostingProfileUpsert,
} from '@erp/contracts';
import {
  branchPostingProfiles,
  branches,
  newId,
  withTenantTx,
  type BranchPostingProfile,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.module.js';
import { getRequestContext, markRequestAudited } from '../../../request-context/request-context.js';
import { AuditService } from '../../platform-services/index.js';
import {
  actorStamp,
  assertVersion,
  isoOf,
  isoOrNull,
  notFound,
  validationFailed,
  visibleBranchIds,
} from '../shared/org-support.js';

/**
 * Branch posting profiles — API_CONTRACT §3, PHASE_05 §5.5.
 *
 * The resolution chain is the whole point of the resource, so it is stated once, here,
 * and unit-tested rung by rung:
 *
 * | # | branch          | doc_type | meaning                              |
 * |---|-----------------|----------|--------------------------------------|
 * | 1 | the branch      | exact    | a branch overrides everything        |
 * | 2 | the branch      | `*`      | the branch's catch-all               |
 * | 3 | NULL (tenant)   | exact    | the tenant default for that document |
 * | 4 | NULL (tenant)   | `*`      | the legacy global mapping            |
 *
 * A branch override always beats a tenant default, because that is what
 * `Branches.*Acc` did to `SettingGeneral.*Acc` in the legacy system (DOMAIN_MODEL §3).
 * When no rung matches the caller gets `ACCOUNT_PROFILE_MISSING` — never a guessed
 * account, because a wrong posting account is a silently corrupted ledger.
 */
@Injectable()
export class PostingProfilesService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string, query: OrgListQuery): Promise<ListEnvelope<PostingProfileDto>> {
    const filters = parseFilters(query.filter, POSTING_PROFILE_FILTERS);
    const sort = parseSort(query.sort, POSTING_PROFILE_SORT_COLUMNS);
    const scoped = visibleBranchIds();

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const conditions: SQL[] = [eq(branchPostingProfiles.tenantId, tenantId)];
      if (filters.branchId) conditions.push(eq(branchPostingProfiles.branchId, filters.branchId));
      if (filters.docType) conditions.push(eq(branchPostingProfiles.docType, filters.docType));
      if (scoped) {
        // Tenant-wide defaults (NULL branch) stay visible to every scoped membership:
        // they are what its branches fall back to.
        const scopeCondition =
          scoped.length > 0
            ? or(inArray(branchPostingProfiles.branchId, scoped), isNull(branchPostingProfiles.branchId))
            : isNull(branchPostingProfiles.branchId);
        if (scopeCondition) conditions.push(scopeCondition);
      }

      const where = and(...conditions);
      const [totalRow] = await tx.select({ value: count() }).from(branchPostingProfiles).where(where);

      const order =
        sort.length > 0 && sort[0]?.column === 'createdAt'
          ? [
              sort[0].direction === 'desc'
                ? sql`${branchPostingProfiles.createdAt} DESC`
                : sql`${branchPostingProfiles.createdAt} ASC`,
            ]
          : [asc(branchPostingProfiles.docType)];

      const rows = await tx
        .select()
        .from(branchPostingProfiles)
        .where(where)
        .orderBy(...order)
        .limit(query.limit)
        .offset(query.offset);

      return { data: rows.map(toPostingProfileDto), meta: buildMeta(totalRow?.value ?? 0, query) };
    });
  }

  async read(tenantId: string, profileId: string): Promise<PostingProfileDto> {
    return withTenantTx(this.database.db, tenantId, async (tx) =>
      toPostingProfileDto(await this.mustFind(tx, tenantId, profileId)),
    );
  }

  /** Create or replace the profile of one `(branch, doc_type)` scope. */
  async upsert(tenantId: string, input: PostingProfileUpsert): Promise<PostingProfileDto> {
    const { actorUserId, now } = actorStamp();
    const branchId = input.branchId ?? null;

    const saved = await withTenantTx(this.database.db, tenantId, async (tx) => {
      if (branchId) await assertBranchExists(tx, tenantId, branchId);

      const [existing] = await tx
        .select()
        .from(branchPostingProfiles)
        .where(
          and(
            eq(branchPostingProfiles.tenantId, tenantId),
            branchId
              ? eq(branchPostingProfiles.branchId, branchId)
              : isNull(branchPostingProfiles.branchId),
            eq(branchPostingProfiles.docType, input.docType),
          ),
        )
        .limit(1);

      if (existing) {
        assertVersion(existing.version, input.version);
        await tx
          .update(branchPostingProfiles)
          .set({
            mapping: input.mapping,
            updatedAt: now,
            updatedBy: actorUserId,
            version: sql`${branchPostingProfiles.version} + 1`,
          })
          .where(eq(branchPostingProfiles.id, existing.id));

        const row = await this.mustFind(tx, tenantId, existing.id);
        await this.recordAudit(tx, tenantId, 'update', row, existing);
        return row;
      }

      const profileId = newId();
      await tx.insert(branchPostingProfiles).values({
        id: profileId,
        tenantId,
        branchId,
        docType: input.docType,
        mapping: input.mapping,
        createdAt: now,
        createdBy: actorUserId,
      });

      const row = await this.mustFind(tx, tenantId, profileId);
      await this.recordAudit(tx, tenantId, 'create', row, null);
      return row;
    });

    markRequestAudited();
    return toPostingProfileDto(saved);
  }

  async remove(tenantId: string, profileId: string): Promise<void> {
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const existing = await this.mustFind(tx, tenantId, profileId);
      // Hard delete: the table has no soft-delete columns, and a lingering "deleted"
      // mapping that still resolved would be worse than none.
      await tx.delete(branchPostingProfiles).where(eq(branchPostingProfiles.id, profileId));
      await this.recordAudit(tx, tenantId, 'delete', existing, existing, true);
    });

    markRequestAudited();
  }

  /** PHASE_05 §5.5 — the public entry point every posting engine will call. */
  async resolvePostProfile(
    tenantId: string,
    branchId: string,
    docType: string,
  ): Promise<PostingProfileResolutionDto> {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      this.resolvePostProfileInTx(tx, tenantId, branchId, docType),
    );
  }

  async resolvePostProfileInTx(
    tx: DrizzleTx,
    tenantId: string,
    branchId: string,
    docType: string,
  ): Promise<PostingProfileResolutionDto> {
    const candidates = await tx
      .select()
      .from(branchPostingProfiles)
      .where(
        and(
          eq(branchPostingProfiles.tenantId, tenantId),
          or(eq(branchPostingProfiles.branchId, branchId), isNull(branchPostingProfiles.branchId)),
          inArray(branchPostingProfiles.docType, [docType, POSTING_PROFILE_WILDCARD]),
        ),
      );

    const matched = pickByPrecedence(candidates, branchId, docType);
    if (!matched) {
      throw new DomainError(
        errorCodes.ACCOUNT_PROFILE_MISSING,
        `No posting profile resolves ${docType} for this branch`,
        422,
        { field: 'docType' },
      );
    }

    return {
      branchId,
      docType,
      mapping: parseMapping(matched.mapping),
      matchedBranchId: matched.branchId,
      matchedDocType: matched.docType,
    };
  }

  // --- internals ---------------------------------------------------------------

  private async mustFind(
    tx: DrizzleTx,
    tenantId: string,
    profileId: string,
  ): Promise<BranchPostingProfile> {
    const [row] = await tx
      .select()
      .from(branchPostingProfiles)
      .where(and(eq(branchPostingProfiles.id, profileId), eq(branchPostingProfiles.tenantId, tenantId)))
      .limit(1);
    if (!row) throw notFound('Posting profile');

    const scoped = visibleBranchIds();
    if (scoped && row.branchId !== null && !scoped.includes(row.branchId)) {
      throw notFound('Posting profile');
    }
    return row;
  }

  private async recordAudit(
    tx: DrizzleTx,
    tenantId: string,
    action: string,
    after: BranchPostingProfile,
    before: BranchPostingProfile | null,
    deleted = false,
  ): Promise<void> {
    const context = getRequestContext();
    await this.audit.recordInTx(tx, {
      tenantId,
      actorUserId: context.auth?.userId ?? null,
      membershipId: context.auth?.membershipId ?? null,
      action,
      entity: 'branch_posting_profile',
      entityId: after.id,
      before: before ? { branchId: before.branchId, docType: before.docType, mapping: before.mapping } : null,
      after: deleted ? null : { branchId: after.branchId, docType: after.docType, mapping: after.mapping },
      meta: { traceId: context.traceId ?? null },
    });
  }
}

/** Rung 1 → 4 of the table in the class comment. */
export function pickByPrecedence<T extends { branchId: string | null; docType: string }>(
  candidates: readonly T[],
  branchId: string,
  docType: string,
): T | undefined {
  const order: Array<[string | null, string]> = [
    [branchId, docType],
    [branchId, POSTING_PROFILE_WILDCARD],
    [null, docType],
    [null, POSTING_PROFILE_WILDCARD],
  ];

  for (const [candidateBranch, candidateDocType] of order) {
    const found = candidates.find(
      (entry) => entry.branchId === candidateBranch && entry.docType === candidateDocType,
    );
    if (found) return found;
  }
  return undefined;
}

/**
 * The column is jsonb, so its runtime shape is only as good as the writer that produced
 * it. Re-parsing on read means a hand-edited row surfaces as a clear 422 instead of an
 * undefined account id three modules downstream.
 */
function parseMapping(mapping: unknown): PostProfileV1 {
  const parsed = postProfileV1Schema.safeParse(mapping);
  if (!parsed.success) {
    throw validationFailed('The stored posting profile is not a valid PostProfileV1 document', 'mapping');
  }
  return parsed.data;
}

async function assertBranchExists(tx: DrizzleTx, tenantId: string, branchId: string): Promise<void> {
  const [row] = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.id, branchId), eq(branches.tenantId, tenantId), isNull(branches.deletedAt)))
    .limit(1);
  if (!row) throw notFound('Branch');

  const scoped = visibleBranchIds();
  if (scoped && !scoped.includes(branchId)) throw notFound('Branch');
}

export function toPostingProfileDto(row: BranchPostingProfile): PostingProfileDto {
  return {
    id: row.id,
    branchId: row.branchId,
    docType: row.docType,
    mapping: parseMapping(row.mapping),
    version: row.version,
    createdAt: isoOf(row.createdAt),
    updatedAt: isoOrNull(row.updatedAt),
  };
}
