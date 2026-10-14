import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  COMPANY_PROFILE_FILE_ENTITY,
  type CompanyProfileDto,
  type CompanyProfilePut,
} from '@erp/contracts';
import {
  companyProfiles,
  files,
  withTenantTx,
  type CompanyProfile,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.module.js';
import { getRequestContext, markRequestAudited } from '../../../request-context/request-context.js';
import { AuditService, FileAttachmentRegistry } from '../../platform-services/index.js';
import {
  actorStamp,
  assertVersion,
  isoOf,
  isoOrNull,
  notFound,
  validationFailed,
} from '../shared/org-support.js';

/**
 * Company profile — API_CONTRACT §3 (`GET/PUT /company-profile`), legacy `Foundation`.
 *
 * One row per tenant, so the write is an upsert against `tenant_id` rather than a
 * collection POST. Two integrations beyond plain CRUD:
 *
 * - **Logo.** `logoFileId` must point at a finalised row of the PHASE_04 `files` table
 *   in the same tenant. This module also registers the `company_profile` attachment
 *   validator, which is the first entry in a registry PHASE_04 deliberately shipped
 *   empty — until now every `entity` on a presign was a 422.
 * - **Audit with a real diff.** The profile carries tax and address data that appears on
 *   every invoice, so the before/after is written inside the same transaction as the
 *   change (SECURITY_ARCHITECTURE §10).
 */
@Injectable()
export class CompanyProfileService implements OnModuleInit {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly audit: AuditService,
    private readonly attachments: FileAttachmentRegistry,
  ) {}

  /**
   * A company logo attaches to the profile of the *current* tenant, whose id is the
   * profile's primary key — so the entity id must be the tenant id and the row must
   * already exist.
   */
  onModuleInit(): void {
    this.attachments.register(COMPANY_PROFILE_FILE_ENTITY, async (tx, tenantId, entityId) => {
      if (entityId !== tenantId) return false;
      const [row] = await tx
        .select({ tenantId: companyProfiles.tenantId })
        .from(companyProfiles)
        .where(eq(companyProfiles.tenantId, tenantId))
        .limit(1);
      return row !== undefined;
    });
  }

  async read(tenantId: string): Promise<CompanyProfileDto> {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const row = await this.find(tx, tenantId);
      if (!row) throw notFound('Company profile');
      return toCompanyProfileDto(row);
    });
  }

  async put(tenantId: string, input: CompanyProfilePut): Promise<CompanyProfileDto> {
    const { actorUserId, now } = actorStamp();

    const saved = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const existing = await this.find(tx, tenantId);
      if (existing) assertVersion(existing.version, input.version);
      if (input.logoFileId) await assertUsableLogo(tx, tenantId, input.logoFileId);

      const values = {
        nameAr: input.nameAr,
        nameEn: input.nameEn ?? null,
        taxNo: input.taxNo ?? null,
        crNo: input.crNo ?? null,
        logoFileId: input.logoFileId ?? null,
        address: input.address ?? null,
        phones: input.phones ?? [],
        email: input.email ?? null,
        countryCode: input.countryCode ?? null,
        einvoiceFlags: input.einvoiceFlags ?? {},
      };

      if (existing) {
        await tx
          .update(companyProfiles)
          .set({
            ...values,
            updatedAt: now,
            updatedBy: actorUserId,
            version: sql`${companyProfiles.version} + 1`,
          })
          .where(eq(companyProfiles.tenantId, tenantId));
      } else {
        await tx.insert(companyProfiles).values({
          tenantId,
          ...values,
          createdAt: now,
          createdBy: actorUserId,
        });
      }

      const row = await this.find(tx, tenantId);
      if (!row) throw notFound('Company profile');

      const context = getRequestContext();
      await this.audit.recordInTx(tx, {
        tenantId,
        actorUserId: context.auth?.userId ?? null,
        membershipId: context.auth?.membershipId ?? null,
        action: existing ? 'update' : 'create',
        entity: 'company_profile',
        entityId: tenantId,
        before: existing ? auditView(existing) : null,
        after: auditView(row),
        meta: { traceId: context.traceId ?? null },
      });

      return row;
    });

    markRequestAudited();
    return toCompanyProfileDto(saved);
  }

  private async find(tx: DrizzleTx, tenantId: string): Promise<CompanyProfile | undefined> {
    const [row] = await tx
      .select()
      .from(companyProfiles)
      .where(eq(companyProfiles.tenantId, tenantId))
      .limit(1);
    return row;
  }
}

/** A logo must be a *finalised* file of this tenant — a pending upload has no bytes yet. */
async function assertUsableLogo(tx: DrizzleTx, tenantId: string, fileId: string): Promise<void> {
  const [row] = await tx
    .select({ id: files.id, status: files.status, mime: files.mime })
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)))
    .limit(1);

  if (!row) throw validationFailed('The logo file does not exist in this tenant', 'logoFileId');
  if (row.status !== 'ready') {
    throw validationFailed('The logo file has not been finalised yet', 'logoFileId');
  }
  if (!row.mime.startsWith('image/')) {
    throw validationFailed('The logo file must be an image', 'logoFileId');
  }
}

function auditView(row: CompanyProfile): Record<string, unknown> {
  return {
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    taxNo: row.taxNo,
    crNo: row.crNo,
    logoFileId: row.logoFileId,
    address: row.address,
    phones: row.phones,
    email: row.email,
    countryCode: row.countryCode?.trim() ?? null,
    einvoiceFlags: row.einvoiceFlags,
  };
}

export function toCompanyProfileDto(row: CompanyProfile): CompanyProfileDto {
  return {
    tenantId: row.tenantId,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    taxNo: row.taxNo,
    crNo: row.crNo,
    logoFileId: row.logoFileId,
    address: (row.address ?? null) as CompanyProfileDto['address'],
    phones: row.phones ?? [],
    email: row.email,
    countryCode: row.countryCode?.trim() ?? null,
    einvoiceFlags: (row.einvoiceFlags ?? {}) as CompanyProfileDto['einvoiceFlags'],
    version: row.version,
    createdAt: isoOf(row.createdAt),
    updatedAt: isoOrNull(row.updatedAt),
  };
}
