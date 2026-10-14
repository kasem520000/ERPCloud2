import { and, eq, isNull } from 'drizzle-orm';
import type { MembershipDto, RoleDto, TenantDto, UserDto } from '@erp/contracts';
import { resolveTenantSettings } from '@erp/config';
import {
  membershipRoleScopes,
  membershipRoles,
  roles,
  tenantSettings,
  type DrizzleTx,
} from '@erp/database';

/** Row → DTO mapping. Column names stay snake_case in SQL and camelCase on the wire. */

export function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

export type UserRow = {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  status: string;
  isPlatformAdmin: boolean;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  /** Effective platform role codes (resolved at login / /me time). */
  platformRoles?: string[];
};

export function toUserDto(row: UserRow): UserDto {
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    phone: row.phone,
    status: row.status as UserDto['status'],
    isPlatformAdmin: row.isPlatformAdmin,
    platformRoles: row.platformRoles ?? [],
    mustChangePassword: row.mustChangePassword,
    lastLoginAt: toIso(row.lastLoginAt),
  };
}

export async function loadRolesForMembership(tx: DrizzleTx, membershipId: string): Promise<RoleDto[]> {
  const rows = await tx
    .select({ id: roles.id, name: roles.name, description: roles.description, isSystem: roles.isSystem })
    .from(membershipRoles)
    .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
    .where(and(eq(membershipRoles.membershipId, membershipId), isNull(roles.deletedAt)));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
  }));
}

export type MembershipRow = {
  id: string;
  tenantId: string;
  tenantCode: string;
  tenantName: string;
  displayName: string;
  status: string;
  isOwner: boolean;
  branchScope: unknown;
  kind?: string;
  /**
   * R1 — حدّ الخصم على العضوية. اختياريّةٌ في الصفّ لأنّ بعض المستدعين (لوحة المنصة،
   * `mustFind`) يقرأ صفّاً لا يعرض حدّاً؛ وغائبُها يعني «بلا حدّ» لا «صفر».
   */
  maxDiscountPct?: string | null;
  maxDiscountAmount?: string | null;
};

export async function toMembershipDto(tx: DrizzleTx, row: MembershipRow): Promise<MembershipDto> {
  const scopeRows = await tx
    .select({
      roleId: membershipRoleScopes.roleId,
      scopeType: membershipRoleScopes.scopeType,
      scopeId: membershipRoleScopes.scopeId,
    })
    .from(membershipRoleScopes)
    .where(eq(membershipRoleScopes.membershipId, row.id));

  return {
    id: row.id,
    tenantId: row.tenantId,
    tenantCode: row.tenantCode,
    tenantName: row.tenantName,
    displayName: row.displayName,
    status: row.status as MembershipDto['status'],
    isOwner: row.isOwner,
    branchScope: (row.branchScope as string[] | null) ?? null,
    maxDiscountPct: row.maxDiscountPct ?? null,
    maxDiscountAmount: row.maxDiscountAmount ?? null,
    roles: await loadRolesForMembership(tx, row.id),
    kind: row.kind === 'portal' ? 'portal' : 'staff',
    scopes: scopeRows.map((scope) => ({
      roleId: scope.roleId,
      scopeType: scope.scopeType as MembershipDto['scopes'][number]['scopeType'],
      scopeId: scope.scopeId,
    })),
  };
}

export type TenantRow = {
  id: string;
  code: string;
  name: string;
  status: string;
  baseCurrency: string;
  timezone: string;
  locale: string;
  countryCode: string;
};

export async function toTenantDto(tx: DrizzleTx, row: TenantRow): Promise<TenantDto> {
  const rows = await tx
    .select({ key: tenantSettings.key, value: tenantSettings.value })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, row.id));

  const stored = new Map(rows.map((entry) => [entry.key, entry.value as string | boolean | number | null]));

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status as TenantDto['status'],
    baseCurrency: row.baseCurrency.trim(),
    timezone: row.timezone,
    locale: row.locale,
    countryCode: row.countryCode.trim(),
    settings: resolveTenantSettings(stored),
  };
}
