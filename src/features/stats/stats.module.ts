import { Module } from '@nestjs/common';

import { TournamentsModule } from '../tournaments/tournaments.module.js';
import { HomeStatsService } from './home-stats.service.js';
import { StatsController } from './stats.controller.js';

@Module({
  imports: [TournamentsModule],
  controllers: [StatsController],
  providers: [HomeStatsService],
})
export class StatsModule {}
