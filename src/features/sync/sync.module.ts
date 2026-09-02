import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { MatchesModule } from '../matches/matches.module.js';
import { TournamentsModule } from '../tournaments/tournaments.module.js';

import { SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';

/**
 * Офлайн-синхронизация — ТС 6.
 *
 * Собственной логики турнира здесь нет: модуль берёт готовые сервисы встреч
 * и турниров и применяет ими то, что судья успел сделать без сети.
 */
@Module({
  imports: [AuthModule, MatchesModule, TournamentsModule],
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
