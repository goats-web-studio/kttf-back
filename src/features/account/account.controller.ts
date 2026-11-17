import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';

import { deleteAccountSchema, type DeleteAccountInput } from '@kttf/shared/types';
import type { Request } from 'express';

import { clientIp } from '../../common/client-ip.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { AccountDeletionService } from './account-deletion.service.js';

@Controller('auth')
export class AccountController {
  constructor(private readonly deletion: AccountDeletionService) {}

  /**
   * Удаление аккаунта — ADR-092. POST, а не DELETE с телом, как смена
   * пароля: пароль — повторная проверка личности перед необратимым шагом.
   */
  @Post('delete-account')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  async deleteAccount(
    @Body(new ZodValidationPipe(deleteAccountSchema)) body: DeleteAccountInput,
    @CurrentUserId() userId: string,
    @Req() request: Request,
  ): Promise<void> {
    await this.deletion.deleteAccount(userId, body, clientIp(request));
  }
}
