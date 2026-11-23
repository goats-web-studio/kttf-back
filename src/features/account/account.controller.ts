import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  listAccountRequestsSchema,
  rejectAccountRequestSchema,
  requestAccountDeletionSchema,
  requestAccountRestoreSchema,
  requestPlayerRenameSchema,
  type AccountRequestView,
  type AccountStatusView,
  type AdminAccountRequestView,
  type ListAccountRequestsQuery,
  type RejectAccountRequestInput,
  type RequestAccountDeletionInput,
  type RequestAccountRestoreInput,
  type RequestPlayerRenameInput,
} from '@kttf/shared/types';
import type { Request } from 'express';
import { z } from 'zod';

import { clientIp } from '../../common/client-ip.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RequireAdmin } from '../auth/admin.guard.js';
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { AccountRequestsService } from './account-requests.service.js';

const uuidParam = new ZodValidationPipe(z.uuid());

/**
 * Заявки на удаление и восстановление аккаунта — ADR-095. Сам человек
 * аккаунт не удаляет: `POST /auth/delete-account` (ADR-092) убран.
 */
@Controller('account')
@UseGuards(JwtAuthGuard)
export class AccountController {
  constructor(private readonly requests: AccountRequestsService) {}

  /** Пароль — повторная проверка личности: вкладка на чужом телефоне не просит удаления. */
  @Post('deletion-request')
  async requestDeletion(
    @Body(new ZodValidationPipe(requestAccountDeletionSchema)) body: RequestAccountDeletionInput,
    @CurrentUserId() userId: string,
    @Req() request: Request,
  ): Promise<AccountRequestView> {
    return this.requests.requestDeletion(userId, body, clientIp(request));
  }

  @Delete('deletion-request')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancelDeletion(@CurrentUserId() userId: string): Promise<void> {
    await this.requests.cancelDeletion(userId);
  }

  @Get('requests')
  async status(@CurrentUserId() userId: string): Promise<AccountStatusView> {
    return this.requests.status(userId);
  }

  /** Исправить имя подтверждённого профиля — ADR-102. */
  @Post('rename-request')
  async requestRename(
    @Body(new ZodValidationPipe(requestPlayerRenameSchema)) body: RequestPlayerRenameInput,
    @CurrentUserId() userId: string,
  ): Promise<AccountRequestView> {
    return this.requests.requestRename(userId, body);
  }

  @Post('restore-request')
  async requestRestore(
    @Body(new ZodValidationPipe(requestAccountRestoreSchema)) body: RequestAccountRestoreInput,
    @CurrentUserId() userId: string,
  ): Promise<AccountRequestView> {
    return this.requests.requestRestore(userId, body);
  }
}

/** Решение по заявкам — только администратор платформы. */
@Controller('admin/account-requests')
@RequireAdmin()
export class AccountRequestsAdminController {
  constructor(private readonly requests: AccountRequestsService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(listAccountRequestsSchema)) query: ListAccountRequestsQuery,
  ): Promise<AdminAccountRequestView[]> {
    return this.requests.list(query);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  async approve(
    @Param('id', uuidParam) id: string,
    @CurrentUserId() adminId: string,
  ): Promise<AdminAccountRequestView> {
    return this.requests.approve(id, adminId);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  async reject(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(rejectAccountRequestSchema)) body: RejectAccountRequestInput,
    @CurrentUserId() adminId: string,
  ): Promise<AdminAccountRequestView> {
    return this.requests.reject(id, adminId, body);
  }
}
