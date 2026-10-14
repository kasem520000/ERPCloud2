import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  mfaDisableRequestSchema,
  mfaEnableRequestSchema,
  type MfaDisableRequest,
  type MfaEnableRequest,
  type MfaEnrollResponse,
  type MfaStatusResponse,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { getAuthContext } from '../../../request-context/request-context.js';
import { zodApiBody } from '../../../openapi/zod-api-body.js';
import { RateLimit } from '../decorators/rate-limit.decorator.js';

import { MfaService } from './mfa.service.js';

/**
 * Two-factor authentication management — SECURITY_ARCHITECTURE §2.
 *
 * Every route is authenticated but *permissionless*: 2FA is personal security state, and
 * making it subject to role permissions would let a misconfigured role lock every user
 * out of protecting their own account.
 */
@ApiTags('auth')
@ApiBearerAuth()
@Controller('auth/mfa')
export class MfaController {
  constructor(private readonly mfa: MfaService) {}

  @Get()
  @ApiOperation({ summary: 'Current 2FA state of the caller' })
  @ApiResponse({ status: 200, description: 'Status' })
  async status(): Promise<{ data: MfaStatusResponse }> {
    const data = await this.mfa.status(getAuthContext().userId);
    return { data };
  }

  @Post('enroll')
  @HttpCode(201)
  @RateLimit({ name: 'mfa', limit: 20, windowMs: 60_000 })
  @ApiOperation({ summary: 'Generate a TOTP secret (pending confirmation)' })
  @ApiResponse({ status: 201, description: 'Secret issued; login unaffected until enable' })
  @ApiResponse({ status: 409, description: '2FA is already enabled' })
  async enroll(): Promise<{ data: MfaEnrollResponse }> {
    const data = await this.mfa.enroll(getAuthContext().userId);
    return { data };
  }

  @Post('enable')
  @HttpCode(200)
  @RateLimit({ name: 'mfa', limit: 20, windowMs: 60_000 })
  @zodApiBody(mfaEnableRequestSchema)
  @ApiOperation({ summary: 'Confirm the secret with a code; issues one-time recovery codes' })
  @ApiResponse({ status: 200, description: '2FA enforced from the next login' })
  @ApiResponse({ status: 400, description: 'Code does not match (VALIDATION_FAILED)' })
  async enable(
    @Body(new ZodValidationPipe(mfaEnableRequestSchema)) body: MfaEnableRequest,
  ): Promise<{ data: { recoveryCodes: string[] } }> {
    const data = await this.mfa.enable(getAuthContext().userId, body.code);
    return { data };
  }

  @Post('disable')
  @HttpCode(204)
  @RateLimit({ name: 'mfa', limit: 20, windowMs: 60_000 })
  @zodApiBody(mfaDisableRequestSchema)
  @ApiOperation({ summary: 'Turn 2FA off (requires the account password)' })
  @ApiResponse({ status: 204, description: 'Disabled' })
  @ApiResponse({ status: 400, description: 'Wrong password (VALIDATION_FAILED)' })
  async disable(@Body(new ZodValidationPipe(mfaDisableRequestSchema)) body: MfaDisableRequest): Promise<void> {
    await this.mfa.disable(getAuthContext().userId, body.password);
  }
}
