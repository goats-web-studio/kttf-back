import { guideQuerySchema, type GuideQuery, type GuideView } from '@kttf/shared/types';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { GuidesService } from './guides.service.js';

/** Руководства на сайте — ADR-144. */
@Controller('guides')
export class GuidesController {
  constructor(private readonly guides: GuidesService) {}

  /** Руководство игрока — открыто всем, и гостю тоже. */
  @Get('player')
  async player(
    @Query(new ZodValidationPipe(guideQuerySchema)) query: GuideQuery,
  ): Promise<GuideView> {
    return this.guides.guide('player', query.locale);
  }

  /** Руководство организатора — только владельцам и организаторам клубов. */
  @Get('organizer')
  @UseGuards(JwtAuthGuard)
  async organizer(
    @Query(new ZodValidationPipe(guideQuerySchema)) query: GuideQuery,
    @CurrentUserId() userId: string,
  ): Promise<GuideView> {
    return this.guides.guide('organizer', query.locale, userId);
  }
}
