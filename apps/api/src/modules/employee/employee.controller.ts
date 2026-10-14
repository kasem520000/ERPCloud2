import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { DomainError, errorCodes, permissionGrants } from '@erp/contracts';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import { EmployeeService } from './employee.service.js';

function assertAny(codes: string[]): void {
  const granted = getTenantContext().permissions;
  if (codes.some((code) => permissionGrants(granted, code))) return;
  throw new DomainError(errorCodes.FORBIDDEN, `permission ${codes.join(' or ')} required`, 403);
}

@Controller('employee')
export class EmployeeController {
  constructor(private readonly employee: EmployeeService) {}

  @Get('me')
  me() {
    assertAny(['employee.self.view', 'employee.self.manage', 'hrm.view']);
    const { tenantId, membershipId } = getTenantContext();
    return this.employee.me(tenantId, membershipId);
  }

  @Post('attendance')
  attendance(@Body() body: { type?: string; lat?: number; lng?: number; selfieFileId?: string; branchId?: string; clientId?: string; at?: string }) {
    assertAny(['employee.self.manage', 'hrm.manage']);
    const { tenantId, membershipId } = getTenantContext();
    return this.employee.punch(tenantId, membershipId, body ?? {});
  }

  @Post('attendance/sync')
  sync(@Body() body: { punches?: Array<{ clientId?: string; type?: string; lat?: number; lng?: number; at?: string; selfieFileId?: string }> }) {
    assertAny(['employee.self.manage', 'hrm.manage']);
    const { tenantId, membershipId } = getTenantContext();
    return this.employee.sync(tenantId, membershipId, body?.punches ?? []);
  }

  @Get('attendance/today')
  today() {
    assertAny(['employee.self.view', 'employee.self.manage', 'hrm.view']);
    const { tenantId, membershipId } = getTenantContext();
    return this.employee.today(tenantId, membershipId);
  }

  @Post('requests')
  createRequest(@Body() body: { type?: string; from?: string; to?: string; reason?: string; fileId?: string; amount?: string }) {
    assertAny(['employee.self.manage', 'hrm.manage']);
    const { tenantId, membershipId } = getTenantContext();
    return this.employee.createRequest(tenantId, membershipId, body ?? {});
  }

  @Get('requests')
  requests(@Query('status') status?: string) {
    assertAny(['employee.self.view', 'employee.self.manage', 'employee.team.approve', 'hrm.view', 'hrm.manage']);
    const context = getTenantContext();
    return this.employee.listRequests(context.tenantId, context.membershipId, context.permissions, status);
  }

  @Post('requests/:id/approve')
  approve(@Param('id') id: string, @Body() body: { note?: string }) {
    assertAny(['employee.team.approve', 'hrm.manage']);
    const { tenantId, membershipId } = getTenantContext();
    return this.employee.decide(tenantId, membershipId, id, 'approved', body?.note);
  }

  @Post('requests/:id/reject')
  reject(@Param('id') id: string, @Body() body: { note?: string }) {
    assertAny(['employee.team.approve', 'hrm.manage']);
    const { tenantId, membershipId } = getTenantContext();
    return this.employee.decide(tenantId, membershipId, id, 'rejected', body?.note);
  }

  @Get('payslips')
  payslips() {
    assertAny(['employee.self.view', 'employee.self.manage']);
    const { tenantId, membershipId } = getTenantContext();
    return this.employee.payslips(tenantId, membershipId);
  }

  @Get('custodies')
  custodies() {
    assertAny(['employee.self.view', 'employee.self.manage']);
    const { tenantId, membershipId } = getTenantContext();
    return this.employee.custodies(tenantId, membershipId);
  }

  @Get('leaves')
  leaves() {
    assertAny(['employee.self.view', 'employee.self.manage']);
    const { tenantId, membershipId } = getTenantContext();
    return this.employee.leaves(tenantId, membershipId);
  }

  @Post('push-subscription')
  subscribe(@Body() body: { endpoint?: string; p256dh?: string; auth?: string }) {
    assertAny(['employee.self.manage', 'employee.team.approve']);
    const { tenantId, userId } = getTenantContext();
    return this.employee.saveSubscription(tenantId, userId, body ?? {});
  }

  @Get('push-config')
  pushConfig() {
    assertAny(['employee.self.view', 'employee.self.manage', 'employee.team.approve']);
    return this.employee.pushConfig();
  }

  @Get('notices')
  notices() {
    assertAny(['employee.self.view', 'employee.self.manage', 'employee.team.approve', 'hrm.view']);
    const { tenantId, userId, membershipId } = getTenantContext();
    return this.employee.notices(tenantId, userId, membershipId);
  }
}

@Controller('hrm')
export class EmployeeHrmController {
  constructor(private readonly employee: EmployeeService) {}

  @Get('employee-leaves')
  @RequiresPermission('hrm.view')
  leaves() {
    return this.employee.hrmLeaves(getTenantContext().tenantId);
  }

  @Get('geofences')
  @RequiresPermission('hrm.view')
  geofences() {
    return this.employee.listGeofences(getTenantContext().tenantId);
  }

  @Put('geofences/:branchId')
  @RequiresPermission('hrm.manage')
  saveGeofence(@Param('branchId') branchId: string, @Body() body: { lat?: number; lng?: number; radiusMeters?: number }) {
    return this.employee.saveGeofence(getTenantContext().tenantId, branchId, body ?? {});
  }
}
