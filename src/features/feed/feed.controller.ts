import { feedQuerySchema, type FeedPage, type FeedQuery } from '@kttf/shared/types';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { OptionalJwtGuard, OptionalUserId } from '../auth/optional-jwt.guard.js';
import { FeedService } from './feed.service.js';

/**
 * Лента — ADR-073. Открыта гостю; вошедшему «Для вас» и «Подписки»
 * собираются по его подпискам и городу.
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
}
