import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { PlacesModule } from '../places/places.module.js';
import { TournamentsModule } from '../tournaments/tournaments.module.js';
import { ClubPageService } from './club-page.service.js';
import { ClubRoleGuard } from './club-role.guard.js';
import { ClubStatsService } from './club-stats.service.js';
import { ClubsController } from './clubs.controller.js';
import { ClubsService } from './clubs.service.js';

@Module({
  // AuthModule нужен ради JwtAuthGuard: без него ClubRoleGuard не от кого
  // проверять роль. TournamentsModule — ради мест призёров (ADR-048).
  imports: [AuthModule, PlacesModule, TournamentsModule],
  controllers: [ClubsController],
  providers: [ClubsService, ClubPageService, ClubStatsService, ClubRoleGuard],
  exports: [ClubsService, ClubRoleGuard],
})
export class ClubsModule {}
