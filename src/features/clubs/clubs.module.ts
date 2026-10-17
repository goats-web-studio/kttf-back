import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { PlacesModule } from '../places/places.module.js';
import { ClubRoleGuard } from './club-role.guard.js';
import { ClubsController } from './clubs.controller.js';
import { ClubsService } from './clubs.service.js';

@Module({
  // AuthModule нужен ради JwtAuthGuard: без него ClubRoleGuard не от кого
  // проверять роль.
  imports: [AuthModule, PlacesModule],
  controllers: [ClubsController],
  providers: [ClubsService, ClubRoleGuard],
  exports: [ClubsService, ClubRoleGuard],
})
export class ClubsModule {}
