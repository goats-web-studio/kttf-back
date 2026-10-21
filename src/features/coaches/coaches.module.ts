import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { ClubsModule } from '../clubs/clubs.module.js';
import { FilesModule } from '../files/files.module.js';
import { PlacesModule } from '../places/places.module.js';
import { TournamentsModule } from '../tournaments/tournaments.module.js';
import { ClubStaffService } from './club-staff.service.js';
import { CoachAdminService } from './coach-admin.service.js';
import { CoachCatalogService } from './coach-catalog.service.js';
import { CoachOwnerGuard } from './coach-owner.guard.js';
import { CoachStatsService } from './coach-stats.service.js';
import {
  ClubTrainingsController,
  CoachesAdminController,
  CoachesController,
  TrainingsController,
} from './coaches.controller.js';
import { CoachesService } from './coaches.service.js';
import {
  ClubCoachesController,
  ClubStaffController,
  CoachStaffController,
} from './staff.controller.js';
import { StudentsService } from './students.service.js';
import { TrainingsService } from './trainings.service.js';

@Module({
  // FilesModule — ради выдачи сканов документов из хранилища, PlacesModule —
  // ради проверки города страницы по справочнику, ClubsModule — ради роли
  // в клубе у тренировок и штаба клуба, TournamentsModule — ради мест
  // в турнирах у медалей учеников (ADR-048).
  imports: [AuthModule, ClubsModule, FilesModule, PlacesModule, TournamentsModule],
  controllers: [
    CoachesController,
    TrainingsController,
    ClubTrainingsController,
    CoachesAdminController,
    ClubStaffController,
    ClubCoachesController,
    CoachStaffController,
  ],
  providers: [
    CoachesService,
    CoachCatalogService,
    CoachAdminService,
    CoachStatsService,
    TrainingsService,
    ClubStaffService,
    StudentsService,
    CoachOwnerGuard,
  ],
})
export class CoachesModule {}
