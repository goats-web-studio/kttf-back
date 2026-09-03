import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  createPlayerSchema,
  listPlayersSchema,
  playerMatchesQuerySchema,
  ratingHistoryQuerySchema,
  updatePlayerSchema,
  type CreatePlayerInput,
  type HeadToHeadView,
  type ListPlayersQuery,
  type Page,
  type PlayerMatchesQuery,
  type PlayerMatchView,
  type PlayerProfileView,
  type PlayerView,
  type RatingHistoryQuery,
  type RatingHistoryView,
  type UpdatePlayerInput,
} from '@kttf/shared/types';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { OptionalJwtGuard, OptionalUserId } from '../auth/optional-jwt.guard.js';
import { PlayersService } from './players.service.js';

const uuidParam = z.uuid();

/**
 * Контракт — ТС 7.2.
 *
 * История игрока открыта без входа, как и остальное чтение: результаты
 * турниров — спортивный факт, а не персональные данные (ТЗ 9.3).
 */
@Controller('players')
export class PlayersController {
  constructor(private readonly players: PlayersService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(listPlayersSchema)) query: ListPlayersQuery,
  ): Promise<Page<PlayerView>> {
    return this.players.list(query);
  }

  /**
   * Страница игрока — полный профиль.
   *
   * Токен необязателен, но меняет ответ: полную дату рождения видят сам
   * игрок и организаторы его клуба, остальные — только год, если игрок так
   * решил (ADR-037).
   */
  @Get(':id')
  @UseGuards(OptionalJwtGuard)
  async findOne(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @OptionalUserId() viewerId?: string,
  ): Promise<PlayerProfileView> {
    return this.players.findById(id, viewerId);
  }

  /** Кривая рейтинга — ТЗ 9.3. Границы по времени необязательны. */
  @Get(':id/rating-history')
  async ratingHistory(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Query(new ZodValidationPipe(ratingHistoryQuerySchema)) query: RatingHistoryQuery,
  ): Promise<RatingHistoryView> {
    return this.players.ratingHistory(id, query);
  }

  @Get(':id/matches')
  async matches(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Query(new ZodValidationPipe(playerMatchesQuerySchema)) query: PlayerMatchesQuery,
  ): Promise<Page<PlayerMatchView>> {
    return this.players.matches(id, query);
  }

  @Get(':id/head-to-head/:opponentId')
  async headToHead(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Param('opponentId', new ZodValidationPipe(uuidParam)) opponentId: string,
  ): Promise<HeadToHeadView> {
    return this.players.headToHead(id, opponentId);
  }

  /**
   * Заведение игрока.
   *
   * Права зависят от клуба в теле запроса, а не от маршрута, поэтому
   * `RequireClubRole` здесь не подходит: клуба в пути нет. Само правило —
   * в сервисе, целиком в одном методе.
   */
  @Post()
  @UseGuards(JwtAuthGuard)
  async create(
    @Body(new ZodValidationPipe(createPlayerSchema)) body: CreatePlayerInput,
    @CurrentUserId() userId: string,
  ): Promise<PlayerProfileView> {
    return this.players.create(body, userId);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  async update(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(updatePlayerSchema)) body: UpdatePlayerInput,
    @CurrentUserId() userId: string,
  ): Promise<PlayerProfileView> {
    await this.players.assertCanEdit(id, userId);

    return this.players.update(id, body);
  }
}
