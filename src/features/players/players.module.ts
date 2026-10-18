import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { PlacesModule } from '../places/places.module.js';
import { TournamentsModule } from '../tournaments/tournaments.module.js';
import { PlayersController } from './players.controller.js';
import { PlayersService } from './players.service.js';
import { PlayerProfileService } from './profile.service.js';

@Module({
  // TournamentsModule — ради мест в турнирах: их считает и записывает он (ADR-048).
  imports: [AuthModule, PlacesModule, TournamentsModule],
  controllers: [PlayersController],
  providers: [PlayersService, PlayerProfileService],
  exports: [PlayersService],
})
export class PlayersModule {}
