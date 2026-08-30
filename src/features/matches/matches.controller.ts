import {
  assignTableSchema,
  matchResultSchema,
  type AssignTableInput,
  type MatchDetailView,
  type MatchResultInput,
  type MatchUpdateResult,
  type MatchView,
} from '@kttf/shared/types';
import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard.js';

import { MatchesService } from './matches.service.js';

const uuidParam = z.uuid();

/**
 * Контракт — ТС 7.6. Маршруты и их формы менять нельзя без правки документа.
 *
 * Чтение открыто без токена: встреча видна на публичной странице результатов
 * (ТЗ 9.4) и на втором экране (ТЗ 6.5). Всё остальное — консоль турнира.
 */
@Controller('matches')
export class MatchesController {
  constructor(private readonly matches: MatchesService) {}

  @Get(':id')
  async findById(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
  ): Promise<MatchDetailView> {
    return this.matches.findById(id);
  }

  /** Назначение на стол — ТЗ 6.2. */
  @Post(':id/assign')
  @UseGuards(JwtAuthGuard)
  async assign(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(assignTableSchema)) body: AssignTableInput,
    @CurrentUserId() userId: string,
  ): Promise<MatchView> {
    return this.matches.assign(id, body, userId);
  }

  /** Ввод счёта — ТЗ 6.3. Победитель уезжает в следующий круг сам (ADR-019). */
  @Post(':id/result')
  @UseGuards(JwtAuthGuard)
  async result(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(matchResultSchema)) body: MatchResultInput,
    @CurrentUserId() userId: string,
  ): Promise<MatchUpdateResult> {
    return this.matches.result(id, body, userId);
  }

  /** Отмена встречи с возвратом в очередь — ТЗ 6.3. */
  @Post(':id/cancel')
  @UseGuards(JwtAuthGuard)
  async cancel(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @CurrentUserId() userId: string,
  ): Promise<MatchUpdateResult> {
    return this.matches.cancel(id, userId);
  }

  /** Изменение уже введённого результата с фиксацией в журнале — ТЗ 6.3. */
  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  async update(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(matchResultSchema)) body: MatchResultInput,
    @CurrentUserId() userId: string,
  ): Promise<MatchUpdateResult> {
    return this.matches.update(id, body, userId);
  }
}
