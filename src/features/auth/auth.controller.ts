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

import {
  loginSchema,
  refreshSchema,
  signUpSchema,
  type AuthSession,
  type AuthUserView,
  type LoginInput,
  type RefreshInput,
  type SignUpInput,
  type TokenPair,
} from '@kttf/shared/types';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { AuthService } from './auth.service.js';
import { CurrentUserId, JwtAuthGuard } from './jwt-auth.guard.js';

/** Контракт — ТС 7.1. Маршруты и их формы менять нельзя без правки документа. */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Вход логином или телефоном — ADR-034. */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginInput,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AuthSession> {
    return this.auth.login(body, userAgent);
  }

  /** Регистрация: аккаунт и, если человек себя назвал, привязка к игроку. */
  @Post('sign-up')
  @HttpCode(HttpStatus.CREATED)
  async signUp(
    @Body(new ZodValidationPipe(signUpSchema)) body: SignUpInput,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AuthSession> {
    return this.auth.signUp(body, userAgent);
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
