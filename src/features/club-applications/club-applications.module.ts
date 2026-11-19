import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { PlacesModule } from '../places/places.module.js';
import {
  ClubApplicationsAdminController,
  ClubApplicationsController,
} from './club-applications.controller.js';
import { ClubApplicationsService } from './club-applications.service.js';

@Module({
  // AuthModule — ради guard'ов: необязательного токена и администратора.
  // PlacesModule — сверить город заявки со справочником (ADR-096).
  imports: [AuthModule, PlacesModule],
  controllers: [ClubApplicationsController, ClubApplicationsAdminController],
  providers: [ClubApplicationsService],
})
export class ClubApplicationsModule {}
