import { Body, Controller, HttpCode, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { env } from '@erp/config';
import {
  changePasswordRequestSchema,
  forgotPasswordRequestSchema,
  handoffCreateResponseSchema,
  handoffRedeemSchema,
  loginRequestSchema,
  logoutRequestSchema,
  refreshRequestSchema,
  resetPasswordRequestSchema,
  type ChangePasswordRequest,
  type ForgotPasswordRequest,
  type HandoffRedeemRequest,
  type HandoffResponse,
  type LoginRequest,
  type LoginResponse,
  type RefreshRequest,
  type ResetPasswordRequest,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { getAuthContext } from '../../../request-context/request-context.js';
import { zodApiBody } from '../../../openapi/zod-api-body.js';
import { Public } from '../decorators/public.decorator.js';
import { RateLimit } from '../decorators/rate-limit.decorator.js';

import { AuthService } from './auth.service.js';

/** API_CONTRACT §1 — Auth & Identity. */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @RateLimit({ name: 'login', limit: env.RATE_LIMIT_LOGIN_PER_MINUTE, windowMs: 60_000 })
  @zodApiBody(loginRequestSchema)
  @ApiOperation({ summary: 'Exchange credentials for an access/refresh token pair' })
  @ApiResponse({ status: 200, description: 'Authenticated' })
  @ApiResponse({ status: 401, description: 'Invalid credentials (UNAUTHENTICATED)' })
  @ApiResponse({ status: 423, description: 'Tenant suspended (TENANT_SUSPENDED)' })
  @ApiResponse({ status: 429, description: 'Login bucket exhausted or account locked (RATE_LIMITED)' })
  async login(
    @Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest,
    @Req() request: Request,
  ): Promise<{ data: LoginResponse }> {
    const data = await this.auth.login(body, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    return { data };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @RateLimit({ name: 'auth', limit: env.RATE_LIMIT_DEFAULT_PER_MINUTE, windowMs: 60_000 })
  @zodApiBody(refreshRequestSchema)
  @ApiOperation({ summary: 'Rotate a refresh token and issue a new access token' })
  @ApiResponse({ status: 200, description: 'Rotated pair' })
  @ApiResponse({ status: 401, description: 'Unknown, expired or reused token (family revoked)' })
  async refresh(
    @Body(new ZodValidationPipe(refreshRequestSchema)) body: RefreshRequest,
    @Req() request: Request,
  ): Promise<{ data: LoginResponse }> {
    const data = await this.auth.refresh(body, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    return { data };
  }

  /**
   * AUD-08 — إصدار رمز تسليم لمرة واحدة. الواجهة المصدر (التسويق) تصدره بعد الدخول،
   * ثم توجّه المتصفح إلى الواجهة الهدف بـ`?handoff=<code>` بدل `?token=&refresh=`.
   */
  @Post('handoff')
  @HttpCode(201)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mint a single-use login handoff code for another surface' })
  @ApiResponse({ status: 201, description: 'Handoff code (valid ~60s, single use)' })
  @ApiResponse({ status: 401, description: 'User, tenant or membership is not active' })
  async handoff(@Req() request: Request): Promise<{ data: HandoffResponse }> {
    const data: HandoffResponse = handoffCreateResponseSchema.parse(await this.auth.createHandoff(getAuthContext(), {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    }));
    return { data };
  }

  /**
   * AUD-08 — استبدال رمز التسليم بجلسة. عامّ بلا رمزٍ مسبق (الواجهة الهدف لم تسجّل
   * الدخول بعد)، ومحدَّد المعدّل، والخطأ واحد لكل الحالات (مجهول/منتهٍ/مستعمل).
   */
  @Public()
  @Post('handoff/redeem')
  @HttpCode(200)
  @RateLimit({ name: 'auth', limit: env.RATE_LIMIT_DEFAULT_PER_MINUTE, windowMs: 60_000 })
  @zodApiBody(handoffRedeemSchema)
  @ApiOperation({ summary: 'Redeem a handoff code for a fresh session' })
  @ApiResponse({ status: 200, description: 'Fresh access/refresh pair' })
  @ApiResponse({ status: 401, description: 'Invalid, expired or already-redeemed code (HANDOFF_CODE_INVALID)' })
  async redeemHandoff(
    @Body(new ZodValidationPipe(handoffRedeemSchema)) body: HandoffRedeemRequest,
    @Req() request: Request,
  ): Promise<{ data: LoginResponse }> {
    const data = await this.auth.redeemHandoff(body.code, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    return { data };
  }

  @Post('logout')
  @HttpCode(204)
  @RateLimit({ name: 'auth', limit: env.RATE_LIMIT_DEFAULT_PER_MINUTE, windowMs: 60_000 })
  @zodApiBody(logoutRequestSchema)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke every active refresh token of the current user' })
  @ApiResponse({ status: 204, description: 'Logged out' })
  async logout(): Promise<void> {
    await this.auth.logout(getAuthContext());
  }

  @Post('change-password')
  @HttpCode(204)
  @RateLimit({ name: 'change-password', limit: env.RATE_LIMIT_LOGIN_PER_MINUTE, windowMs: 60_000 })
  @zodApiBody(changePasswordRequestSchema)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change the caller password and revoke all sessions' })
  @ApiResponse({ status: 204, description: 'Password changed' })
  @ApiResponse({ status: 400, description: 'Wrong current password or policy rejection' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded (RATE_LIMITED)' })
  async changePassword(
    @Body(new ZodValidationPipe(changePasswordRequestSchema)) body: ChangePasswordRequest,
  ): Promise<void> {
    await this.auth.changePassword(getAuthContext(), body);
  }

  @Patch('profile')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update caller profile fullName' })
  async updateProfile(@Body() body: { fullName?: string }): Promise<{ data: { fullName: string } }> {
    const data = await this.auth.updateProfile(getAuthContext(), body ?? {});
    return { data };
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(200)
  @RateLimit({ name: 'login', limit: env.RATE_LIMIT_LOGIN_PER_MINUTE, windowMs: 60_000 })
  @zodApiBody(forgotPasswordRequestSchema)
  @ApiOperation({ summary: 'Request a one-time password reset token and email link' })
  @ApiResponse({ status: 200, description: 'Reset email queued if the account exists' })
  async forgotPassword(
    @Body(new ZodValidationPipe(forgotPasswordRequestSchema)) body: ForgotPasswordRequest,
  ): Promise<{ data: { ok: true; message: string } }> {
    const data = await this.auth.forgotPassword(body);
    return { data };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(200)
  @RateLimit({ name: 'login', limit: env.RATE_LIMIT_LOGIN_PER_MINUTE, windowMs: 60_000 })
  @zodApiBody(resetPasswordRequestSchema)
  @ApiOperation({ summary: 'Reset a user password using a valid one-time reset token' })
  @ApiResponse({ status: 200, description: 'Password reset succeeded' })
  @ApiResponse({ status: 400, description: 'Invalid/expired token or password policy failure' })
  async resetPassword(
    @Body(new ZodValidationPipe(resetPasswordRequestSchema)) body: ResetPasswordRequest,
  ): Promise<{ data: { ok: true; message: string } }> {
    const data = await this.auth.resetPassword(body);
    return { data };
  }
}
