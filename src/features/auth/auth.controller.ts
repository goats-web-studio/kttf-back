import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import {
  changePasswordSchema,
  loginSchema,
  refreshSchema,
  signUpSchema,
  updateAccountSchema,
  type AuthSession,
  type AuthUserView,
  type ChangePasswordInput,
  type LoginInput,
  type RefreshInput,
  type SignUpInput,
  type TokenPair,
  type UpdateAccountInput,
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

  /**
   * Настройки аккаунта — ТЗ 2.1, ADR-035.
   *
   * Логин, почта, язык и Telegram. Спортивная анкета правится профилем
   * игрока, `PATCH /players/:id`: это разные сущности, а не два раздела
   * одного экрана.
   */
  @Patch('me')
  @UseGuards(JwtAuthGuard)
  async updateMe(
    @Body(new ZodValidationPipe(updateAccountSchema)) body: UpdateAccountInput,
    @CurrentUserId() userId: string,
  ): Promise<AuthUserView> {
    return this.auth.updateAccount(userId, body);
  }

  /**
   * Смена пароля — ТЗ 2.1.
   *
   * Отдаёт новую пару токенов: остальные сессии при смене пароля обрываются,
   * и без этого вкладка, из которой пароль сменили, умерла бы вместе с ними.
   */
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async changePassword(
    @Body(new ZodValidationPipe(changePasswordSchema)) body: ChangePasswordInput,
    @CurrentUserId() userId: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<TokenPair> {
    return this.auth.changePassword(userId, body, userAgent);
  }
}
