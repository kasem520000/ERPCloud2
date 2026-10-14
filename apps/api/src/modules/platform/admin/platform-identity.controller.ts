import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  platformMfaResetSchema,
  platformOperatorInviteSchema,
  platformRoleGrantSchema,
  platformRolePermissionsUpdateSchema,
  platformRoleRevokeQuerySchema,
  platformSessionRevokeQuerySchema,
  platformPermissionRegistry,
  uuidSchema,
  type PlatformDirectoryUser,
  type PlatformMfaReset,
  type PlatformOperatorInvite,
  type PlatformRoleGrant,
  type PlatformRolePermissionsResponse,
  type PlatformRolePermissionsUpdate,
  type PlatformRoleRevokeQuery,
  type PlatformSessionRevokeQuery,
  type PlatformSessionView,
  type PlatformUserDetailResponse,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { RequiresPlatformRole } from '../decorators/requires-platform-role.decorator.js';
import { PlatformAdminGuard } from '../guards/platform-admin.guard.js';

import { PlatformIdentityService } from './platform-identity.service.js';

/**
 * `/api/v1/platform/*` — P-C3 «الهوية والوصول على المنصة».
 *
 * | Route | Code |
 * |---|---|
 * | `GET users` · `GET users/:id` · `GET roles` · `GET permissions` · `GET sessions/:id` | `console.users.view` |
 * | `POST operators/invite` · `POST users/:id/roles` · `DELETE users/:id/roles/:roleCode` · `POST users/:id/mfa/reset` · `DELETE sessions/:id` · `PUT roles/:code/permissions` | `console.users.manage` |
 *
 * The split is the plan's: seeing who exists is «view», changing who may do what — or
 * reaching into someone's account — is «manage». These five paths used to live in
 * `PlatformAdminController`; P-C3 moved them here so that *identity* has one owner and the
 * older controller keeps tenants, plans, licences and activation review. The paths
 * themselves did not move — only the class that answers them.
 */
@ApiTags('platform-identity')
@ApiBearerAuth()
@Controller('platform')
@UseGuards(PlatformAdminGuard)
export class PlatformIdentityController {
  constructor(private readonly identity: PlatformIdentityService) {}

  // ------------------------------------------------------------------ directory

  @Get('users')
  @RequiresPlatformRole('console.users.view')
  @ApiOperation({ summary: 'Directory of users across every tenant, with tenants, roles and 2FA state' })
  async list(@Query('search') search?: string): Promise<{ data: PlatformDirectoryUser[] }> {
    return { data: await this.identity.list(search) };
  }

  @Get('users/:id')
  @RequiresPlatformRole('console.users.view')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'One user: platform roles, memberships across tenants, sessions' })
  async detail(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<{ data: PlatformUserDetailResponse }> {
    return { data: await this.identity.detail(id) };
  }

  @Post('operators/invite')
  @HttpCode(201)
  @RequiresPlatformRole('console.users.manage')
  @ApiOperation({ summary: 'Invite a platform operator with a role' })
  async invite(
    @Body(new ZodValidationPipe(platformOperatorInviteSchema)) body: PlatformOperatorInvite,
  ): Promise<{ data: PlatformDirectoryUser }> {
    return { data: await this.identity.inviteOperator(body) };
  }

  // ------------------------------------------------------------------ roles on a user

  @Post('users/:id/roles')
  // No `@HttpCode(200)` here on purpose: this route predates P-C3 and its shipped answer is
  // `201 Created` (it creates a `platform_memberships` row). Moving the handler into this
  // class must not change what the surface answers — `test/surface-isolation.spec.ts` pins it.
  @RequiresPlatformRole('console.users.manage')
  @ApiOperation({ summary: 'Grant a platform role' })
  async grant(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(platformRoleGrantSchema)) body: PlatformRoleGrant,
  ) {
    return { data: await this.identity.grantRole(id, body.roleCode, body.reason) };
  }

  @Delete('users/:id/roles/:roleCode')
  @RequiresPlatformRole('console.users.manage')
  @ApiOperation({ summary: 'Revoke a platform role' })
  async revoke(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('roleCode') roleCode: string,
    @Query(new ZodValidationPipe(platformRoleRevokeQuerySchema)) query: PlatformRoleRevokeQuery,
  ) {
    return { data: await this.identity.revokeRole(id, roleCode, query.reason) };
  }

  // ------------------------------------------------------------------ 2FA

  @Post('users/:id/mfa/reset')
  @HttpCode(200)
  @RequiresPlatformRole('console.users.manage')
  @ApiOperation({ summary: 'Clear 2FA on an account (reason required, written to the audit trail)' })
  async resetMfa(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(platformMfaResetSchema)) body: PlatformMfaReset,
  ) {
    return { data: await this.identity.resetMfa(id, body.reason) };
  }

  // ------------------------------------------------------------------ sessions

  @Get('sessions/:id')
  @RequiresPlatformRole('console.users.view')
  @ApiOperation({ summary: 'One login session (a refresh-token rotation family)' })
  async session(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<{ data: PlatformSessionView }> {
    return { data: await this.identity.session(id) };
  }

  @Delete('sessions/:id')
  @RequiresPlatformRole('console.users.manage')
  @ApiOperation({ summary: 'Revoke a session (whole rotation family) with a written reason' })
  async revokeSession(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Query(new ZodValidationPipe(platformSessionRevokeQuerySchema)) query: PlatformSessionRevokeQuery,
  ) {
    return { data: await this.identity.revokeSession(id, query.reason) };
  }

  // ------------------------------------------------------------------ the matrix

  @Get('roles')
  @RequiresPlatformRole('console.users.view')
  @ApiOperation({ summary: 'Platform roles with catalogue vs effective console codes and holder counts' })
  async roles() {
    return { data: await this.identity.roleMatrix() };
  }

  @Get('permissions')
  @RequiresPlatformRole('console.users.view')
  @ApiOperation({ summary: 'Platform-console (console.*) permission registry' })
  permissions() {
    return {
      data: platformPermissionRegistry
        .map((entry) => ({ code: entry.code, module: entry.module, description: entry.description }))
        .sort((left, right) => left.code.localeCompare(right.code)),
    };
  }

  @Put('roles/:code/permissions')
  @HttpCode(200)
  @RequiresPlatformRole('console.users.manage')
  @ApiParam({ name: 'code' })
  @ApiResponse({ status: 200, description: 'The role’s new effective console codes' })
  @ApiOperation({ summary: 'Replace one role’s console codes (reason required; audited with the diff)' })
  async setPermissions(
    @Param('code') code: string,
    @Body(new ZodValidationPipe(platformRolePermissionsUpdateSchema)) body: PlatformRolePermissionsUpdate,
  ): Promise<{ data: PlatformRolePermissionsResponse }> {
    return { data: await this.identity.setRolePermissions(code, body.permissions, body.reason) };
  }
}
