import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  createPlayerSchema,
  listPlayersSchema,
  updatePlayerSchema,
  type CreatePlayerInput,
  type ListPlayersQuery,
  type Page,
  type PlayerView,
  type UpdatePlayerInput,
} from '@kttf/shared/types';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { PlayersService } from './players.service.js';

const uuidParam = z.uuid();

/**
 * Контракт — ТС 7.2.
 *
 * Трёх маршрутов раздела здесь нет: `rating-history`, `matches` и
 * `head-to-head`. Все три читают журнал рейтинга и встречи, которых до
 * появления турниров попросту не существует. Заводить их сейчас означало бы
 * отдавать пустые списки там, где клиент вправе ждать данные.
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

  @Get(':id')
  async findOne(@Param('id', new ZodValidationPipe(uuidParam)) id: string): Promise<PlayerView> {
    return this.players.findById(id);
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
  ): Promise<PlayerView> {
    return this.players.create(body, userId);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  async update(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(updatePlayerSchema)) body: UpdatePlayerInput,
    @CurrentUserId() userId: string,
  ): Promise<PlayerView> {
    await this.players.assertCanEdit(id, userId);

    return this.players.update(id, body);
  }
}
