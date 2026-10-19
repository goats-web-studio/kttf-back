import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  createClubApplicationSchema,
  listClubApplicationsSchema,
  updateClubApplicationSchema,
  type ClubApplicationView,
  type CreateClubApplicationInput,
  type ListClubApplicationsQuery,
  type Page,
  type UpdateClubApplicationInput,
} from '@kttf/shared/types';
import type { Request } from 'express';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RequireAdmin } from '../auth/admin.guard.js';
import { OptionalJwtGuard, OptionalUserId } from '../auth/optional-jwt.guard.js';
import { ClubApplicationsService } from './club-applications.service.js';
import { clientIp } from '../../common/client-ip.js';

/**
 * Заявка клуба с сайта — ADR-047. Открыта всем: представитель зала ещё
 * не пользователь. Вошедший привязывается к заявке.
 *
 * Ответ пустой: отправителю нечего показывать, кроме «заявка отправлена».
 */
@Controller('club-applications')
export class ClubApplicationsController {
  constructor(private readonly applications: ClubApplicationsService) {}

  @Post()
  @UseGuards(OptionalJwtGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async create(
    @Body(new ZodValidationPipe(createClubApplicationSchema)) body: CreateClubApplicationInput,
    @OptionalUserId() userId: string | undefined,
    @Req() request: Request,
  ): Promise<void> {
    await this.applications.create(body, userId, clientIp(request));
  }
}

/** Разбор заявок — только администратор платформы. */
@Controller('admin/club-applications')
@RequireAdmin()
export class ClubApplicationsAdminController {
  constructor(private readonly applications: ClubApplicationsService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(listClubApplicationsSchema)) query: ListClubApplicationsQuery,
  ): Promise<Page<ClubApplicationView>> {
    return this.applications.list(query);
  }

  @Patch(':id')
  async update(
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
    @Body(new ZodValidationPipe(updateClubApplicationSchema)) body: UpdateClubApplicationInput,
  ): Promise<ClubApplicationView> {
    return this.applications.update(id, body);
  }
}
