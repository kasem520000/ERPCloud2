import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { MeResponse, PermissionDto } from '@erp/contracts';

import { getAuthContext } from '../../../request-context/request-context.js';

import { IdentityService } from './identity.service.js';

/** API_CONTRACT §1 — `GET /me`, `GET /permissions`. */
@ApiTags('identity')
@ApiBearerAuth()
@Controller()
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  @Get('me')
  @ApiOperation({ summary: 'Current user, membership, effective permissions and branch scope' })
  @ApiResponse({ status: 200, description: 'Current identity' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  async me(): Promise<{ data: MeResponse }> {
    return { data: await this.identity.me(getAuthContext()) };
  }

  @Get('permissions')
  @ApiOperation({ summary: 'Permission registry (the list the permissions table is seeded from)' })
  @ApiResponse({ status: 200, description: 'Registry' })
  async permissions(): Promise<{ data: PermissionDto[] }> {
    return { data: await this.identity.listPermissions() };
  }
}
