import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { env } from '@erp/config';
import { DomainError, errorCodes, newId, permissionGrants } from '@erp/contracts';
import { withTenantTx, type DatabaseHandle, type DrizzleTx } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';

import {
  assertPunch,
  assertRequestType,
  classifyPunch,
  decideRequest,
  outsideAlert,
  planSync,
  redactEmployeeText,
  type PunchType,
  type RequestType,
} from './employee-mobile.js';

type EmployeeRow = { id: string; name: string; branch_id: string | null; membership_id: string | null };
type FenceRow = { lat: string; lng: string; radius_meters: number };
type Notice = { kind: string; title: string; body: string; userId?: string | null; membershipId?: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mobile employee surface. Every fact query filters tenant_id. A self caller
 * never reads another employee's row. Payslips omit national id and IBAN.
 */
@Injectable()
export class EmployeeService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  async me(tenantId: string, membershipId: string) {
    const employee = await this.employeeByMembership(tenantId, membershipId);
    return { id: employee.id, name: employee.name, branchId: employee.branch_id };
  }

  async punch(
    tenantId: string,
    membershipId: string,
    input: { type?: string; lat?: number; lng?: number; selfieFileId?: string; branchId?: string; clientId?: string; at?: string },
  ) {
    const employee = await this.employeeByMembership(tenantId, membershipId);
    return this.writePunch(tenantId, employee, {
      type: String(input.type ?? ''),
      lat: Number(input.lat),
      lng: Number(input.lng),
      selfieFileId: input.selfieFileId,
      branchId: input.branchId,
      clientId: input.clientId,
      at: input.at,
    });
  }

  async sync(
    tenantId: string,
    membershipId: string,
    punches: Array<{ clientId?: string; type?: string; lat?: number; lng?: number; at?: string; selfieFileId?: string; branchId?: string }>,
  ) {
    const employee = await this.employeeByMembership(tenantId, membershipId);
    const incoming = (punches ?? []).map((punch) => ({
      clientId: String(punch.clientId ?? ''),
      type: guard(() => assertPunch({ type: String(punch.type ?? ''), lat: Number(punch.lat), lng: Number(punch.lng) })),
      lat: Number(punch.lat),
      lng: Number(punch.lng),
      at: punch.at || new Date().toISOString(),
      selfieFileId: punch.selfieFileId,
      branchId: punch.branchId,
    }));
    if (incoming.some((punch) => !punch.clientId)) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'كل بصمة أوفلاين تحتاج معرّف عميل', 422);
    }
    const existing = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.execute(sql`
        SELECT client_id FROM employee_attendance
        WHERE tenant_id = ${tenantId}::uuid AND employee_id = ${employee.id}::uuid AND client_id IS NOT NULL
      `),
    );
    const known = rowsOf<{ client_id: string }>(existing).map((row) => row.client_id);
    const plan = planSync(known, incoming);
    const applied = [];
    for (const punch of plan.apply) {
      applied.push(await this.writePunch(tenantId, employee, punch));
    }
    return { applied, duplicates: plan.duplicates };
  }

  async today(tenantId: string, membershipId: string) {
    const employee = await this.employeeByMembership(tenantId, membershipId);
    const result = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.execute(sql`
        SELECT id::text, type, status, at, distance_meters, branch_id::text
        FROM employee_attendance
        WHERE tenant_id = ${tenantId}::uuid
          AND employee_id = ${employee.id}::uuid
          AND at >= date_trunc('day', now() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh'
        ORDER BY at
      `),
    );
    return rowsOf(result);
  }

  async createRequest(
    tenantId: string,
    membershipId: string,
    input: { type?: string; from?: string; to?: string; reason?: string; fileId?: string; amount?: string },
  ) {
    const employee = await this.employeeByMembership(tenantId, membershipId);
    const type = guard(() => assertRequestType(String(input.type ?? '')));
    const reason = redactEmployeeText(String(input.reason ?? '').trim()).slice(0, 500);
    if (!reason) throw new DomainError(errorCodes.VALIDATION_FAILED, 'اكتب سبب الطلب', 422);
    const startsOn = input.from || null;
    const endsOn = input.to || startsOn;
    if (type === 'leave' && !startsOn) throw new DomainError(errorCodes.VALIDATION_FAILED, 'حدد تاريخ الإجازة', 422);
    const id = newId();
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.execute(sql`
        INSERT INTO employee_requests (id, tenant_id, employee_id, type, starts_on, ends_on, reason, file_id, data)
        VALUES (
          ${id}::uuid, ${tenantId}::uuid, ${employee.id}::uuid, ${type},
          ${startsOn}::date, ${endsOn}::date, ${reason}, ${this.optionalUuid(input.fileId)}::uuid,
          ${JSON.stringify(input.amount ? { amount: input.amount } : {})}::jsonb
        )
      `),
    );
    return { id, type, status: 'pending', reason };
  }

  async listRequests(tenantId: string, membershipId: string, permissions: string[], status?: string) {
    const canApprove = permissionGrants(permissions, 'employee.team.approve') || permissionGrants(permissions, 'hrm.manage');
    const employee = canApprove ? null : await this.employeeByMembership(tenantId, membershipId);
    const result = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.execute(sql`
        SELECT r.id::text, r.employee_id::text, e.name AS employee_name, r.type, r.status,
               r.starts_on::text, r.ends_on::text, r.reason, r.created_at
        FROM employee_requests r
        JOIN employees e ON e.id = r.employee_id AND e.tenant_id = r.tenant_id
        WHERE r.tenant_id = ${tenantId}::uuid
          AND (${status ?? null}::text IS NULL OR r.status = ${status ?? null})
          AND (${employee?.id ?? null}::uuid IS NULL OR r.employee_id = ${employee?.id ?? null}::uuid)
        ORDER BY r.created_at DESC
        LIMIT 50
      `),
    );
    return rowsOf(result);
  }

  async hrmLeaves(tenantId: string) {
    const result = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.execute(sql`
        SELECT r.id::text, e.name AS employee_name, r.starts_on::text, r.ends_on::text, r.reason, r.decided_at
        FROM employee_requests r
        JOIN employees e ON e.id = r.employee_id AND e.tenant_id = r.tenant_id
        WHERE r.tenant_id = ${tenantId}::uuid AND r.type = 'leave' AND r.status = 'approved'
        ORDER BY r.decided_at DESC NULLS LAST
        LIMIT 100
      `),
    );
    return rowsOf(result);
  }

  async decide(tenantId: string, membershipId: string, id: string, decision: 'approved' | 'rejected', note?: string) {
    const requestId = this.uuid(id);
    const found = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.execute(sql`
        SELECT r.id::text, r.employee_id::text, r.type, r.status, r.reason, e.membership_id::text, e.name
        FROM employee_requests r
        JOIN employees e ON e.id = r.employee_id AND e.tenant_id = r.tenant_id
        WHERE r.tenant_id = ${tenantId}::uuid AND r.id = ${requestId}::uuid
        LIMIT 1
      `),
    );
    const row = rowsOf<{ id: string; employee_id: string; type: RequestType; status: 'pending' | 'approved' | 'rejected'; reason: string; membership_id: string | null; name: string }>(found)[0];
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'الطلب غير موجود', 404);
    let decided;
    try {
      decided = decideRequest(
        { id: row.id, employeeId: row.employee_id, type: row.type, status: row.status, reason: row.reason },
        decision,
      );
    } catch (error) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, error instanceof Error ? error.message : 'تعذر حسم الطلب', 422);
    }
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await tx.execute(sql`
        UPDATE employee_requests
        SET status = ${decision}, approver_membership_id = ${membershipId}::uuid,
            decision_note = ${redactEmployeeText(note ?? '').slice(0, 300)}, decided_at = now()
        WHERE tenant_id = ${tenantId}::uuid AND id = ${requestId}::uuid
      `);
      await this.queueNotice(tx, tenantId, {
        kind: decided.push.kind,
        title: decided.push.title,
        body: decided.push.body,
        membershipId: row.membership_id,
      });
    });
    return { id: row.id, status: decision, push: decided.push };
  }

  async payslips(tenantId: string, membershipId: string) {
    const employee = await this.employeeByMembership(tenantId, membershipId);
    const result = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.execute(sql`
        SELECT pr.year_month AS period, l.net::text, l.gross::text
        FROM payroll_run_lines l
        JOIN payroll_runs pr ON pr.id = l.run_id AND pr.tenant_id = l.tenant_id
        WHERE l.tenant_id = ${tenantId}::uuid AND l.employee_id = ${employee.id}::uuid
        ORDER BY pr.year_month DESC
        LIMIT 12
      `),
    );
    return rowsOf(result);
  }

  async custodies(tenantId: string, membershipId: string) {
    const employee = await this.employeeByMembership(tenantId, membershipId);
    const result = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.execute(sql`
        SELECT id::text, reason, decided_at, data
        FROM employee_requests
        WHERE tenant_id = ${tenantId}::uuid AND employee_id = ${employee.id}::uuid
          AND type = 'custody' AND status = 'approved'
        ORDER BY decided_at DESC
      `),
    );
    return rowsOf(result);
  }

  async leaves(tenantId: string, membershipId: string) {
    const employee = await this.employeeByMembership(tenantId, membershipId);
    const result = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.execute(sql`
        SELECT id::text, status, starts_on::text, ends_on::text, reason, decided_at
        FROM employee_requests
        WHERE tenant_id = ${tenantId}::uuid AND employee_id = ${employee.id}::uuid AND type = 'leave'
        ORDER BY created_at DESC
      `),
    );
    return rowsOf(result);
  }

  async saveSubscription(tenantId: string, userId: string, input: { endpoint?: string; p256dh?: string; auth?: string }) {
    const endpoint = String(input.endpoint ?? '').slice(0, 500);
    const p256dh = String(input.p256dh ?? '').slice(0, 200);
    const auth = String(input.auth ?? '').slice(0, 200);
    if (!endpoint.startsWith('https://') || !p256dh || !auth) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'اشتراك الإشعار غير مكتمل', 422);
    }
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.execute(sql`
        INSERT INTO employee_push_subscriptions (id, tenant_id, user_id, endpoint, p256dh, auth_secret)
        VALUES (${newId()}::uuid, ${tenantId}::uuid, ${userId}::uuid, ${endpoint}, ${p256dh}, ${auth})
        ON CONFLICT (tenant_id, endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth_secret = EXCLUDED.auth_secret
      `),
    );
    return { saved: true };
  }

  pushConfig() {
    return { publicKey: env.WEB_PUSH_VAPID_PUBLIC || null };
  }

  async notices(tenantId: string, userId: string, membershipId: string) {
    const result = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT id::text, kind, title, body, created_at
        FROM employee_push_outbox
        WHERE tenant_id = ${tenantId}::uuid
          AND status = 'queued'
          AND (user_id = ${userId}::uuid OR membership_id = ${membershipId}::uuid)
        ORDER BY created_at DESC
        LIMIT 20
      `);
      await tx.execute(sql`
        UPDATE employee_push_outbox
        SET status = 'delivered'
        WHERE tenant_id = ${tenantId}::uuid
          AND status = 'queued'
          AND (user_id = ${userId}::uuid OR membership_id = ${membershipId}::uuid)
      `);
      return rows;
    });
    return rowsOf(result);
  }

  async listGeofences(tenantId: string) {
    const result = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.execute(sql`
        SELECT g.branch_id::text, b.name_ar AS branch_name, g.lat::text, g.lng::text, g.radius_meters
        FROM employee_geofences g
        JOIN branches b ON b.id = g.branch_id AND b.tenant_id = g.tenant_id
        WHERE g.tenant_id = ${tenantId}::uuid
        ORDER BY b.name_ar
      `),
    );
    return rowsOf(result);
  }

  async saveGeofence(tenantId: string, branchId: string, input: { lat?: number; lng?: number; radiusMeters?: number }) {
    const id = this.uuid(branchId);
    const lat = Number(input.lat);
    const lng = Number(input.lng);
    const radius = Number(input.radiusMeters ?? 200);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isInteger(radius) || radius < 1 || radius > 50000) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'نطاق الفرع غير صالح', 422);
    }
    const branch = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.execute(sql`SELECT id::text FROM branches WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid AND deleted_at IS NULL LIMIT 1`),
    );
    if (!rowsOf(branch)[0]) throw new DomainError(errorCodes.NOT_FOUND, 'الفرع غير موجود', 404);
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.execute(sql`
        INSERT INTO employee_geofences (id, tenant_id, branch_id, lat, lng, radius_meters, updated_at)
        VALUES (${newId()}::uuid, ${tenantId}::uuid, ${id}::uuid, ${lat}, ${lng}, ${radius}, now())
        ON CONFLICT (tenant_id, branch_id) DO UPDATE SET
          lat = EXCLUDED.lat, lng = EXCLUDED.lng, radius_meters = EXCLUDED.radius_meters, updated_at = now()
      `),
    );
    return { branchId: id, lat, lng, radiusMeters: radius };
  }

  private async writePunch(
    tenantId: string,
    employee: EmployeeRow,
    input: { type: string; lat: number; lng: number; selfieFileId?: string; branchId?: string; clientId?: string; at?: string },
  ) {
    const branchId = input.branchId ? this.uuid(input.branchId) : employee.branch_id;
    const fence = branchId ? await this.fence(tenantId, branchId) : null;
    const resolvedLat = Number.isFinite(input.lat) ? input.lat : (fence?.lat ?? 24.7136);
    const resolvedLng = Number.isFinite(input.lng) ? input.lng : (fence?.lng ?? 46.6753);
    const type = guard(() => assertPunch({ type: input.type, lat: resolvedLat, lng: resolvedLng }));
    const clientId = input.clientId || null;
    if (clientId) {
      const existing = await withTenantTx(this.database.db, tenantId, (tx) =>
        tx.execute(sql`
          SELECT id::text, type, status, distance_meters
          FROM employee_attendance
          WHERE tenant_id = ${tenantId}::uuid AND employee_id = ${employee.id}::uuid AND client_id = ${clientId}
          LIMIT 1
        `),
      );
      const prior = rowsOf<{ id: string; type: PunchType; status: 'valid' | 'outside_geofence'; distance_meters: number | null }>(existing)[0];
      if (prior) {
        return { id: prior.id, type: prior.type, status: prior.status, distanceMeters: prior.distance_meters, alertManager: false, duplicate: true };
      }
    }
    const decision = classifyPunch({ lat: resolvedLat, lng: resolvedLng }, fence);
    const id = newId();
    const at = input.at || new Date().toISOString();
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO employee_attendance (
          id, tenant_id, employee_id, branch_id, type, at, lat, lng, selfie_file_id, status, distance_meters, client_id
        ) VALUES (
          ${id}::uuid, ${tenantId}::uuid, ${employee.id}::uuid, ${branchId}::uuid, ${type}, ${at}::timestamptz,
          ${resolvedLat}, ${resolvedLng}, ${this.optionalUuid(input.selfieFileId)}::uuid, ${decision.status},
          ${decision.distanceMeters}, ${clientId}
        )
      `);
      if (decision.alertManager) {
        const alert = outsideAlert(employee.name);
        await this.alertManagers(tx, tenantId, alert);
      }
    });
    return { id, type, status: decision.status, distanceMeters: decision.distanceMeters, alertManager: decision.alertManager, duplicate: false };
  }

  private async fence(tenantId: string, branchId: string) {
    const result = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.execute(sql`
        SELECT lat::text, lng::text, radius_meters
        FROM employee_geofences
        WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid
        LIMIT 1
      `),
    );
    const row = rowsOf<FenceRow>(result)[0];
    if (!row) return null;
    return { lat: Number(row.lat), lng: Number(row.lng), radiusMeters: Number(row.radius_meters) };
  }

  private async employeeByMembership(tenantId: string, membershipId: string): Promise<EmployeeRow> {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const direct = await tx.execute(sql`
        SELECT id::text, name, branch_id::text, membership_id::text
        FROM employees
        WHERE tenant_id = ${tenantId}::uuid AND membership_id = ${membershipId}::uuid AND deleted_at IS NULL
        LIMIT 1
      `);
      const existing = rowsOf<EmployeeRow>(direct)[0];
      if (existing) return existing;

      // Auto-link by matching email/name or auto-provision an employee record for this membership
      const memberRes = await tx.execute(sql`
        SELECT m.id::text AS membership_id, u.email, COALESCE(NULLIF(trim(u.full_name), ''), split_part(u.email, '@', 1)) AS full_name
        FROM memberships m
        JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = ${tenantId}::uuid AND m.id = ${membershipId}::uuid AND m.deleted_at IS NULL
        LIMIT 1
      `);
      const member = rowsOf<{ membership_id: string; email: string; full_name: string }>(memberRes)[0];
      if (!member) {
        throw new DomainError(errorCodes.FORBIDDEN, 'اربط بطاقة الموظف بهذا الحساب من شاشة الموظفين', 403);
      }

      const byEmailOrName = await tx.execute(sql`
        SELECT id::text, name, branch_id::text
        FROM employees
        WHERE tenant_id = ${tenantId}::uuid
          AND membership_id IS NULL
          AND deleted_at IS NULL
          AND (lower(COALESCE(email, '')) = lower(${member.email}) OR name = ${member.full_name})
        ORDER BY created_at ASC
        LIMIT 1
      `);
      const candidate = rowsOf<{ id: string; name: string; branch_id: string | null }>(byEmailOrName)[0];
      if (candidate) {
        await tx.execute(sql`
          UPDATE employees
          SET membership_id = ${membershipId}::uuid, updated_at = now()
          WHERE tenant_id = ${tenantId}::uuid AND id = ${candidate.id}::uuid
        `);
        return {
          id: candidate.id,
          name: candidate.name,
          branch_id: candidate.branch_id,
          membership_id: membershipId,
        };
      }

      const branchRes = await tx.execute(sql`
        SELECT id::text
        FROM branches
        WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
        ORDER BY created_at ASC
        LIMIT 1
      `);
      const defaultBranchId = rowsOf<{ id: string }>(branchRes)[0]?.id ?? null;
      const empId = newId();
      const empNo = `EMP-${membershipId.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
      await tx.execute(sql`
        INSERT INTO employees (
          id, tenant_id, branch_id, membership_id, employee_no, name, email, status
        ) VALUES (
          ${empId}::uuid, ${tenantId}::uuid, ${defaultBranchId}::uuid, ${membershipId}::uuid,
          ${empNo}, ${member.full_name}, ${member.email}, 'active'
        )
        ON CONFLICT (tenant_id, employee_no) WHERE deleted_at IS NULL DO UPDATE
          SET membership_id = EXCLUDED.membership_id, updated_at = now()
      `);
      const createdRes = await tx.execute(sql`
        SELECT id::text, name, branch_id::text, membership_id::text
        FROM employees
        WHERE tenant_id = ${tenantId}::uuid AND membership_id = ${membershipId}::uuid AND deleted_at IS NULL
        LIMIT 1
      `);
      const created = rowsOf<EmployeeRow>(createdRes)[0];
      if (!created) {
        throw new DomainError(errorCodes.FORBIDDEN, 'اربط بطاقة الموظف بهذا الحساب من شاشة الموظفين', 403);
      }
      return created;
    });
  }

  private async alertManagers(tx: DrizzleTx, tenantId: string, notice: { kind: string; title: string; body: string }) {
    const managers = await tx.execute(sql`
      SELECT m.id::text AS membership_id, m.user_id::text
      FROM memberships m
      WHERE m.tenant_id = ${tenantId}::uuid AND m.deleted_at IS NULL
        AND (
          m.is_owner = true
          OR EXISTS (
            SELECT 1 FROM membership_roles mr
            JOIN role_permissions rp ON rp.role_id = mr.role_id
            WHERE mr.membership_id = m.id
              AND rp.permission_code IN ('employee.team.approve', 'hrm.manage')
          )
        )
      LIMIT 20
    `);
    for (const manager of rowsOf<{ membership_id: string; user_id: string }>(managers)) {
      await this.queueNotice(tx, tenantId, {
        ...notice,
        membershipId: manager.membership_id,
        userId: manager.user_id,
      });
    }
  }

  private async queueNotice(tx: DrizzleTx, tenantId: string, notice: Notice) {
    await tx.execute(sql`
      INSERT INTO employee_push_outbox (id, tenant_id, user_id, membership_id, kind, title, body, payload)
      VALUES (
        ${newId()}::uuid, ${tenantId}::uuid, ${notice.userId ?? null}::uuid, ${notice.membershipId ?? null}::uuid,
        ${notice.kind}, ${notice.title}, ${notice.body}, ${JSON.stringify({ kind: notice.kind })}::jsonb
      )
    `);
    if (notice.membershipId) {
      await tx.execute(sql`
        INSERT INTO notifications (id, tenant_id, membership_id, type, payload)
        VALUES (
          ${newId()}::uuid, ${tenantId}::uuid, ${notice.membershipId}::uuid, ${notice.kind},
          ${JSON.stringify({ title: notice.title, body: notice.body })}::jsonb
        )
      `);
    }
  }

  private uuid(value: string): string {
    if (!UUID.test(value)) throw new DomainError(errorCodes.VALIDATION_FAILED, 'معرّف غير صالح', 422);
    return value;
  }

  private optionalUuid(value: string | undefined): string | null {
    if (!value) return null;
    return this.uuid(value);
  }
}

function guard<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw new DomainError(errorCodes.VALIDATION_FAILED, error instanceof Error ? error.message : 'بيانات غير صالحة', 422);
  }
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: T[] } | null)?.rows;
  return rows ?? [];
}

export type { PunchType };
