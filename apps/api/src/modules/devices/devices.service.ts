import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DomainError, errorCodes, newId, type DeviceDto } from '@erp/contracts';
import { branches, devices, withTenantTx, type DatabaseHandle, type DrizzleTx } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { isUniqueViolation } from '../organization/shared/org-support.js';

/**
 * Canonical tenant device registry (2026-09 architecture/RBAC reorganisation).
 *
 * A device is an enrolled hardware identity — a till, handheld, kiosk, printer
 * agent or API client — with its own activation lifecycle and hashed credential.
 * It is deliberately separate from:
 *
 *   - `users` (humans, password login),
 *   - the `cashier` *role* (what a human may do),
 *   - `compat_devices` (the legacy desktop gateway's own registry, untouched).
 *
 * The plaintext credential is generated here and returned exactly once; only the
 * SHA-256 hash is stored, exactly like refresh tokens.
 */
@Injectable()
export class DevicesService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  async list(tenantId: string): Promise<DeviceDto[]> {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(devices)
        .where(and(eq(devices.tenantId, tenantId), isNull(devices.deletedAt)))
        .orderBy(devices.deviceName);
      return rows.map(toDto);
    });
  }

  async create(
    tenantId: string,
    actorUserId: string,
    input: { branchId: string; deviceType: string; deviceName: string; capabilities?: Record<string, unknown> },
  ): Promise<DeviceDto & { credential: string }> {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const branch = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.id, input.branchId), eq(branches.tenantId, tenantId)))
        .limit(1);
      if (!branch[0]) {
        throw new DomainError(errorCodes.NOT_FOUND, 'Branch not found in this tenant', 404, {
          field: 'branchId',
        });
      }

      const credential = randomBytes(32).toString('base64url');
      const id = newId();
      await tx.insert(devices).values({
        id,
        tenantId,
        branchId: input.branchId,
        deviceType: input.deviceType,
        deviceName: input.deviceName.trim(),
        activationStatus: 'pending',
        credentialHash: hashCredential(credential),
        capabilities: input.capabilities ?? {},
        createdAt: new Date(),
        createdBy: actorUserId,
      });
      const created = await this.mustFind(tx, tenantId, id);
      return { ...toDto(created), credential };
    }).catch((error: unknown) => {
      if (error instanceof DomainError) throw error;
      if (isUniqueViolation(error)) {
        throw new DomainError(
          errorCodes.VERSION_CONFLICT,
          'A device with this name already exists in the branch',
          409,
          { field: 'deviceName' },
        );
      }
      throw error;
    });
  }

  async update(
    tenantId: string,
    actorUserId: string,
    deviceId: string,
    input: { deviceName?: string; branchId?: string; deviceType?: string; capabilities?: Record<string, unknown> },
  ): Promise<DeviceDto> {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.mustFind(tx, tenantId, deviceId);
      if (input.branchId) {
        const branch = await tx
          .select({ id: branches.id })
          .from(branches)
          .where(and(eq(branches.id, input.branchId), eq(branches.tenantId, tenantId)))
          .limit(1);
        if (!branch[0]) {
          throw new DomainError(errorCodes.NOT_FOUND, 'Branch not found in this tenant', 404, {
            field: 'branchId',
          });
        }
      }
      const updates: Record<string, unknown> = { updatedAt: new Date(), updatedBy: actorUserId };
      if (input.deviceName !== undefined) updates.deviceName = input.deviceName.trim();
      if (input.branchId !== undefined) updates.branchId = input.branchId;
      if (input.deviceType !== undefined) updates.deviceType = input.deviceType;
      if (input.capabilities !== undefined) updates.capabilities = input.capabilities;
      await tx.update(devices).set(updates).where(eq(devices.id, deviceId));
      return toDto(await this.mustFind(tx, tenantId, deviceId));
    }).catch((error: unknown) => {
      if (error instanceof DomainError) throw error;
      if (isUniqueViolation(error)) {
        throw new DomainError(
          errorCodes.VERSION_CONFLICT,
          'A device with this name already exists in the branch',
          409,
          { field: 'deviceName' },
        );
      }
      throw error;
    });
  }

  async setStatus(
    tenantId: string,
    actorUserId: string,
    deviceId: string,
    status: 'active' | 'suspended' | 'revoked',
  ): Promise<DeviceDto> {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const existing = await this.mustFind(tx, tenantId, deviceId);
      if (existing.activationStatus === 'revoked' && status !== 'revoked') {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          'A revoked device cannot be reactivated; enrol a new one',
          422,
          { field: 'activationStatus' },
        );
      }
      await tx
        .update(devices)
        .set({
          activationStatus: status,
          // Revocation burns the credential: a stolen secret dies with the device.
          ...(status === 'revoked' ? { credentialHash: null } : {}),
          updatedAt: new Date(),
          updatedBy: actorUserId,
        })
        .where(eq(devices.id, deviceId));
      return toDto(await this.mustFind(tx, tenantId, deviceId));
    });
  }

  async rotateCredential(
    tenantId: string,
    actorUserId: string,
    deviceId: string,
  ): Promise<DeviceDto & { credential: string }> {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const existing = await this.mustFind(tx, tenantId, deviceId);
      if (existing.activationStatus === 'revoked') {
        throw new DomainError(
          errorCodes.VALIDATION_FAILED,
          'A revoked device cannot receive a new credential',
          422,
        );
      }
      const credential = randomBytes(32).toString('base64url');
      await tx
        .update(devices)
        .set({ credentialHash: hashCredential(credential), updatedAt: new Date(), updatedBy: actorUserId })
        .where(eq(devices.id, deviceId));
      return { ...toDto(await this.mustFind(tx, tenantId, deviceId)), credential };
    });
  }

  async remove(tenantId: string, actorUserId: string, deviceId: string): Promise<void> {
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.mustFind(tx, tenantId, deviceId);
      await tx
        .update(devices)
        .set({
          deletedAt: new Date(),
          deletedBy: actorUserId,
          credentialHash: null,
          updatedAt: new Date(),
          updatedBy: actorUserId,
        })
        .where(eq(devices.id, deviceId));
    });
  }

  private async mustFind(tx: DrizzleTx, tenantId: string, deviceId: string) {
    const rows = await tx
      .select()
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.tenantId, tenantId), isNull(devices.deletedAt)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      // A row belonging to another tenant is indistinguishable from a missing row
      // (MULTI_TENANCY §7.1: cross-tenant read must be a 404).
      throw new DomainError(errorCodes.NOT_FOUND, 'Device not found', 404);
    }
    return row;
  }
}

type DeviceRow = Awaited<ReturnType<DevicesService['list']>>[number] extends never
  ? never
  : {
      id: string;
      branchId: string;
      deviceType: string;
      deviceName: string;
      activationStatus: string;
      credentialHash: string | null;
      lastSeenAt: Date | null;
      capabilities: unknown;
      createdAt: Date;
      updatedAt: Date | null;
    };

function toDto(row: DeviceRow): DeviceDto {
  return {
    id: row.id,
    branchId: row.branchId,
    deviceType: row.deviceType,
    deviceName: row.deviceName,
    activationStatus: row.activationStatus as DeviceDto['activationStatus'],
    hasCredential: row.credentialHash !== null,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    capabilities: (row.capabilities as Record<string, unknown>) ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

function hashCredential(credential: string): string {
  return createHash('sha256').update(credential, 'utf8').digest('hex');
}
