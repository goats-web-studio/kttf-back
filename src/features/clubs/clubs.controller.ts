import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  addMemberSchema,
  createClubSchema,
  listClubsSchema,
  updateClubSchema,
  type AddMemberInput,
  type ClubMemberView,
  type ClubView,
  type CreateClubInput,
  type ListClubsQuery,
  type Page,
  type UpdateClubInput,
} from '@kttf/shared/types';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RequireClubRole } from './club-role.guard.js';
import { ClubsService } from './clubs.service.js';

const uuidParam = z.uuid();

/**
 * Контракт — ТС 7.4.
 *
 * Двух маршрутов раздела здесь нет: `balance` и `transactions`. Они относятся
 * к финансам клуба, а оплата по разделу 9 состояния ждёт подтверждения
 * гипотез. Заводить их пустыми означало бы обещать функцию, которой нет.
 */
@Controller('clubs')
export class ClubsController {
  constructor(private readonly clubs: ClubsService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(listClubsSchema)) query: ListClubsQuery,
  ): Promise<Page<ClubView>> {
    return this.clubs.list(query);
  }

  @Get(':id')
  async findOne(@Param('id', new ZodValidationPipe(uuidParam)) id: string): Promise<ClubView> {
    return this.clubs.findById(id);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  async create(
    @Body(new ZodValidationPipe(createClubSchema)) body: CreateClubInput,
    @CurrentUserId() userId: string,
  ): Promise<ClubView> {
    return this.clubs.create(body, userId);
  }

  @Patch(':id')
  @RequireClubRole('OWNER', 'ORGANIZER')
  async update(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(updateClubSchema)) body: UpdateClubInput,
  ): Promise<ClubView> {
    return this.clubs.update(id, body);
  }

  /** Состав публичен — ТЗ 3.2 показывает его на странице клуба. */
  @Get(':id/members')
  async members(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
  ): Promise<readonly ClubMemberView[]> {
    return this.clubs.listMembers(id);
  }

  /** Состав организаторов ведёт владелец — ТЗ 1. */
  @Post(':id/members')
  @RequireClubRole('OWNER')
  async addMember(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(addMemberSchema)) body: AddMemberInput,
  ): Promise<ClubMemberView> {
    return this.clubs.addMember(id, body);
  }

  @Delete(':id/members/:userId')
  @RequireClubRole('OWNER')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeMember(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Param('userId', new ZodValidationPipe(uuidParam)) userId: string,
  ): Promise<void> {
    await this.clubs.removeMember(id, userId);
  }
}
