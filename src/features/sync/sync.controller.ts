import {
  syncRequestSchema,
  type SyncRequest,
  type SyncResult,
  type TournamentSnapshotView,
} from '@kttf/shared/types';
import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard.js';

import { SyncService } from './sync.service.js';

/**
 * Снимок и синхронизация — ТС 7.5, маршруты турнира.
 *
 * Отдельный контроллер, а не два метода в контроллере турниров: здесь другой
 * читатель. Всё остальное в ТС 7.5 обслуживает организатора с телефона, а эти
 * два — консоль судьи, которая уходит с ними в зал без сети.
 */

const uuidParam = z.uuid();

@Controller('tournaments')
@UseGuards(JwtAuthGuard)
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Get(':id/snapshot')
  async snapshot(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @CurrentUserId() userId: string,
  ): Promise<TournamentSnapshotView> {
    return this.sync.snapshot(id, userId);
  }

  @Post(':id/sync')
  async apply(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(syncRequestSchema)) body: SyncRequest,
    @CurrentUserId() userId: string,
  ): Promise<SyncResult> {
    return this.sync.sync(id, body, userId);
  }
}
