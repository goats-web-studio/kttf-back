import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { AuthService } from './auth.service.js';
import {
  refreshSchema,
  requestCodeSchema,
  verifyCodeSchema,
  type RefreshInput,
  type RequestCodeInput,
  type VerifyCodeInput,
} from './auth.schemas.js';
import { CurrentUserId, JwtAuthGuard } from './jwt-auth.guard.js';
import type { AuthSession, AuthUserView, TokenPair } from './auth.types.js';

/** Контракт — ТС 7.1. Маршруты и их формы менять нельзя без правки документа. */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('request-code')
  @HttpCode(HttpStatus.ACCEPTED)
  async requestCode(
    @Body(new ZodValidationPipe(requestCodeSchema)) body: RequestCodeInput,
  ): Promise<{ expiresInSeconds: number }> {
    return this.auth.requestCode(body.phone);
  }

  @Post('verify-code')
  @HttpCode(HttpStatus.OK)
  async verifyCode(
    @Body(new ZodValidationPipe(verifyCodeSchema)) body: VerifyCodeInput,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AuthSession> {
    return this.auth.verifyCode(body.phone, body.code, userAgent);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body(new ZodValidationPipe(refreshSchema)) body: RefreshInput,
    @Headers('user-agent') userAgent?: string,
  ): Promise<TokenPair> {
    return this.auth.refresh(body.refreshToken, userAgent);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body(new ZodValidationPipe(refreshSchema)) body: RefreshInput): Promise<void> {
    await this.auth.logout(body.refreshToken);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUserId() userId: string): Promise<AuthUserView> {
    return this.auth.findUser(userId);
  }
}
