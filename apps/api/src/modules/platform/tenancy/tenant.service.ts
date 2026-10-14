import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DomainError, errorCodes, type TenantDto, type TenantPatch } from '@erp/contracts';
import {
  parseTenantSettingValue,
  isTenantSettingKey,
  resolveTenantSettings,
  tenantSettingsRegistry,
} from '@erp/config';
import { tenantSettings, tenants, withTenantTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.module.js';

/** `GET`/`PATCH /tenant` — API_CONTRACT §2, `platform.tenant.*`. */
@Injectable()
export class TenantService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  async read(tenantId: string): Promise<TenantDto> {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: tenants.id,
          code: tenants.code,
          name: tenants.name,
          status: tenants.status,
          baseCurrency: tenants.baseCurrency,
          timezone: tenants.timezone,
          locale: tenants.locale,
          countryCode: tenants.countryCode,
        })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      const tenant = rows[0];
      if (!tenant) {
        throw new DomainError(errorCodes.NOT_FOUND, 'Tenant not found', 404);
      }

      const settingRows = await tx
        .select({ key: tenantSettings.key, value: tenantSettings.value })
        .from(tenantSettings)
        .where(eq(tenantSettings.tenantId, tenantId));

      const stored = new Map(
        settingRows.map((row) => [row.key, row.value as string | boolean | number | null]),
      );

      return {
        id: tenant.id,
        code: tenant.code,
        name: tenant.name,
        status: tenant.status as TenantDto['status'],
        baseCurrency: tenant.baseCurrency.trim(),
        timezone: tenant.timezone,
        locale: tenant.locale,
        countryCode: tenant.countryCode.trim(),
        settings: resolveTenantSettings(stored),
      };
    });
  }

  /**
   * Bulk update of the tenant record and its typed settings. Unknown setting keys are a
   * hard 400 — MULTI_TENANCY §5 makes the registry in `packages/config` authoritative.
   */
  async patch(tenantId: string, actorUserId: string, patch: TenantPatch): Promise<TenantDto> {
    if (patch.settings) {
      for (const key of Object.keys(patch.settings)) {
        if (!isTenantSettingKey(key)) {
          throw new DomainError(errorCodes.VALIDATION_FAILED, `Unknown tenant setting '${key}'`, 400, {
            field: `settings.${key}`,
          });
        }
      }
    }

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const updates: Record<string, unknown> = {};
      if (patch.name !== undefined) updates.name = patch.name;
      if (patch.timezone !== undefined) updates.timezone = patch.timezone;
      if (patch.locale !== undefined) updates.locale = patch.locale;
      if (Object.keys(updates).length > 0) {
        updates.updatedAt = new Date();
        updates.updatedBy = actorUserId;
        updates.version = sql`${tenants.version} + 1`;
        await tx.update(tenants).set(updates).where(eq(tenants.id, tenantId));
      }

      for (const [key, raw] of Object.entries(patch.settings ?? {})) {
        const value = parseTenantSettingValue(key, raw);
        await tx
          .insert(tenantSettings)
          .values({ tenantId, key, value, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: [tenantSettings.tenantId, tenantSettings.key],
            set: { value, updatedAt: new Date() },
          });
      }

      const rows = await tx
        .select({
          id: tenants.id,
          code: tenants.code,
          name: tenants.name,
          status: tenants.status,
          baseCurrency: tenants.baseCurrency,
          timezone: tenants.timezone,
          locale: tenants.locale,
          countryCode: tenants.countryCode,
        })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      const tenant = rows[0];
      if (!tenant) {
        throw new DomainError(errorCodes.NOT_FOUND, 'Tenant not found', 404);
      }

      const settingRows = await tx
        .select({ key: tenantSettings.key, value: tenantSettings.value })
        .from(tenantSettings)
        .where(eq(tenantSettings.tenantId, tenantId));

      return {
        id: tenant.id,
        code: tenant.code,
        name: tenant.name,
        status: tenant.status as TenantDto['status'],
        baseCurrency: tenant.baseCurrency.trim(),
        timezone: tenant.timezone,
        locale: tenant.locale,
        countryCode: tenant.countryCode.trim(),
        settings: resolveTenantSettings(
          new Map(settingRows.map((row) => [row.key, row.value as string | boolean | number | null])),
        ),
      };
    });
  }

  /** Registry metadata — surfaced so the admin UI can render the settings form. */
  registry() {
    return tenantSettingsRegistry.map((entry) => ({
      key: entry.key,
      module: entry.module,
      description: entry.description,
      default: entry.defaultValue,
    }));
  }
}
