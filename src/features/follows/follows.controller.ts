import {
  followParamsSchema,
  followSuggestionsQuerySchema,
  type Followed,
  type FollowParams,
  type FollowState,
  type FollowSuggestion,
  type FollowSuggestionsQuery,
} from '@kttf/shared/types';
import { Controller, Delete, Get, Param, Put, Query, UseGuards } from '@nestjs/common';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { OptionalJwtGuard, OptionalUserId } from '../auth/optional-jwt.guard.js';
import { FollowsService } from './follows.service.js';

/** Подписки — ADR-073. Счётчик и рекомендации видит и гость. */
@Controller('follows')
export class FollowsController {
  constructor(private readonly follows: FollowsService) {}

  @Get('suggestions')
  @UseGuards(OptionalJwtGuard)
  async suggestions(
    @Query(new ZodValidationPipe(followSuggestionsQuerySchema)) query: FollowSuggestionsQuery,
    @OptionalUserId() userId?: string,
  ): Promise<FollowSuggestion[]> {
    return this.follows.suggestions(userId, query.limit);
  }

  /** На кого подписан вошедший — кабинет «Подписки» (ADR-075). */
  @Get('mine')
  @UseGuards(JwtAuthGuard)
  async mine(@CurrentUserId() userId: string): Promise<Followed[]> {
    return this.follows.mine(userId);
  }

  @Get(':type/:id')
  @UseGuards(OptionalJwtGuard)
  async state(
    @Param(new ZodValidationPipe(followParamsSchema)) params: FollowParams,
    @OptionalUserId() userId?: string,
  ): Promise<FollowState> {
    return this.follows.state(params.type, params.id, userId);
  }

  @Put(':type/:id')
  @UseGuards(JwtAuthGuard)
  async follow(
    @Param(new ZodValidationPipe(followParamsSchema)) params: FollowParams,
    @CurrentUserId() userId: string,
  ): Promise<FollowState> {
    return this.follows.follow(params.type, params.id, userId);
  }

  @Delete(':type/:id')
  @UseGuards(JwtAuthGuard)
  async unfollow(
    @Param(new ZodValidationPipe(followParamsSchema)) params: FollowParams,
    @CurrentUserId() userId: string,
  ): Promise<FollowState> {
    return this.follows.unfollow(params.type, params.id, userId);
  }
}
