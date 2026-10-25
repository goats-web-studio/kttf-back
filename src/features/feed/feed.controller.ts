import {
  adminFeedQuerySchema,
  feedCurationSchema,
  feedQuerySchema,
  playerPostsQuerySchema,
  type AdminFeedQuery,
  type FeedCurationInput,
  type FeedPage,
  type FeedQuery,
  type PlayerPostsPage,
  type PlayerPostsQuery,
} from '@kttf/shared/types';
import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RequireAdmin } from '../auth/admin.guard.js';
import { CurrentUserId } from '../auth/jwt-auth.guard.js';
import { OptionalJwtGuard, OptionalUserId } from '../auth/optional-jwt.guard.js';
import { FeedService } from './feed.service.js';

const uuidParam = new ZodValidationPipe(z.uuid());

/**
 * Лента — ADR-073, ADR-075. Открыта гостю; вошедшему «Для вас» и «Подписки»
 * собираются по его подпискам и городу. Решения по карточкам — у
 * администратора.
 */
@Controller('feed')
export class FeedController {
  constructor(private readonly feed: FeedService) {}

  @Get()
  @UseGuards(OptionalJwtGuard)
  async list(
    @Query(new ZodValidationPipe(feedQuerySchema)) query: FeedQuery,
    @OptionalUserId() userId?: string,
  ): Promise<FeedPage> {
    return this.feed.feed(query, userId);
  }

  /** Стена игрока — его записи; архив только ему самому. */
  @Get('players/:id/posts')
  @UseGuards(OptionalJwtGuard)
  async wall(
    @Param('id', uuidParam) id: string,
    @Query(new ZodValidationPipe(playerPostsQuerySchema)) query: PlayerPostsQuery,
    @OptionalUserId() userId?: string,
  ): Promise<PlayerPostsPage> {
    return this.feed.wall(id, query, userId);
  }

  /** Лента глазами администратора — со скрытыми и закреплёнными. */
  @Get('admin')
  @RequireAdmin()
  async admin(
    @Query(new ZodValidationPipe(adminFeedQuerySchema)) query: AdminFeedQuery,
  ): Promise<FeedPage> {
    return this.feed.adminFeed(query);
  }

  /** Закрепить или скрыть карточку. */
  @Post('curation')
  @HttpCode(204)
  @RequireAdmin()
  async curate(
    @Body(new ZodValidationPipe(feedCurationSchema)) body: FeedCurationInput,
    @CurrentUserId() userId: string,
  ): Promise<void> {
    await this.feed.curate(body, userId);
  }
}
