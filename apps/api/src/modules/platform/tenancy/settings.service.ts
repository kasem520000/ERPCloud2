import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { ZodError } from 'zod';
import { DomainError, errorCodes } from '@erp/contracts';
import {
  findTenantSetting,
  isTenantSettingKey,
  parseTenantSettingValue,
  resolveTenantSettings,
  tenantSettingsRegistry,
  type TenantSettingsMap,
} from '@erp/config';
import { and, eq as eqColumn } from 'drizzle-orm';
import { tenantSettings, withTenantTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.module.js';
import { DomainEventsService, domainEventTypes } from '../../../events/domain-events.service.js';
import { getRequestContext, markRequestAudited } from '../../../request-context/request-context.js';
import { AuditService } from '../../platform-services/audit/audit.service.js';

export type SettingsListResponse = {
  settings: TenantSettingsMap;
  registry: Array<{
    key: string;
    module: string;
    description: string;
    default: string | boolean | number | null;
  }>;
};

/**
 * `GET /settings`, `PUT /settings/{key}` — API_CONTRACT §2, `platform.settings.manage`.
 * Every write is validated against the typed registry in `packages/config`
 * (MULTI_TENANCY §5); an unknown key or a value of the wrong shape is a 400.
 *
 * PHASE_04 adds two things to the write path:
 *
 * 1. **Audit with a real `before`.** The interceptor can only see the response, so the
 *    service writes the row itself — old value, new value, same transaction as the write
 *    — and marks the request audited so the interceptor stands down.
 * 2. **A domain event** after the transaction commits, which the notifications
 *    subscriber turns into an inbox entry plus an outbox e-mail job (PHASE_04 §4).
 */
@Injectable()
export class SettingsService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
  ) {}

  async list(tenantId: string): Promise<SettingsListResponse> {
    const stored = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const rows = await tx
        .select({ key: tenantSettings.key, value: tenantSettings.value })
        .from(tenantSettings)
        .where(eq(tenantSettings.tenantId, tenantId));
      return new Map(rows.map((row) => [row.key, row.value as string | boolean | number | null]));
    });

    return {
      settings: resolveTenantSettings(stored),
      registry: tenantSettingsRegistry.map((entry) => ({
        key: entry.key,
        module: entry.module,
        description: entry.description,
        default: entry.defaultValue,
      })),
    };
  }

  async put(
    tenantId: string,
    key: string,
    value: unknown,
  ): Promise<{ key: string; value: string | boolean | number | null }> {
    if (!isTenantSettingKey(key)) {
      // CR-004: was 404 in PHASE_02. PHASE_04 §5.8 and API_CONTRACT §2 require a 400 —
      // the key is a *value in the request*, not a missing resource, and answering 404
      // made a typo indistinguishable from a route that does not exist.
      throw new DomainError(errorCodes.VALIDATION_FAILED, `Unknown tenant setting '${key}'`, 400, {
        field: 'key',
      });
    }

    let parsed: string | boolean | number | null;
    try {
      parsed = parseTenantSettingValue(key, value);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          `Value for '${key}' failed validation`,
          400,
          error.issues.map((issue) => ({ field: 'value', message: issue.message })),
        );
      }
      throw error;
    }

    const context = getRequestContext();

    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const [existing] = await tx
        .select({ value: tenantSettings.value })
        .from(tenantSettings)
        .where(and(eqColumn(tenantSettings.tenantId, tenantId), eqColumn(tenantSettings.key, key)))
        .limit(1);

      await tx
        .insert(tenantSettings)
        .values({ tenantId, key, value: parsed, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [tenantSettings.tenantId, tenantSettings.key],
          set: { value: parsed, updatedAt: new Date() },
        });

      await this.audit.recordInTx(tx, {
        tenantId,
        actorUserId: context.auth?.userId ?? null,
        membershipId: context.auth?.membershipId ?? null,
        action: 'update',
        entity: 'settings',
        entityId: key,
        before: { key, value: existing ? (existing.value as unknown) : null },
        after: { key, value: parsed },
        meta: { method: 'PUT', path: `settings/${key}`, status: 200, traceId: context.traceId ?? null },
      });
    });

    markRequestAudited();

    // After commit: subscribers must never see a state that could still roll back.
    await this.events.emit({
      type: domainEventTypes.SETTINGS_UPDATED,
      tenantId,
      membershipId: context.auth?.membershipId ?? null,
      actorUserId: context.auth?.userId ?? null,
      payload: { key, value: parsed },
    });

    return { key, value: parsed };
  }

  describe(key: string) {
    const definition = findTenantSetting(key);
    if (!definition) return undefined;
    return {
      key: definition.key,
      module: definition.module,
      description: definition.description,
      default: definition.defaultValue,
    };
  }
}
