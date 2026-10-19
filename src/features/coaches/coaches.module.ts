import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { FilesModule } from '../files/files.module.js';
import { PlacesModule } from '../places/places.module.js';
import { CoachAdminService } from './coach-admin.service.js';
import { CoachOwnerGuard } from './coach-owner.guard.js';
import { CoachesAdminController, CoachesController } from './coaches.controller.js';
import { CoachesService } from './coaches.service.js';

@Module({
  // FilesModule — ради выдачи сканов документов из хранилища, PlacesModule —
  // ради проверки города страницы по справочнику.
  imports: [AuthModule, FilesModule, PlacesModule],
  controllers: [CoachesController, CoachesAdminController],
  providers: [CoachesService, CoachAdminService, CoachOwnerGuard],
})
export class CoachesModule {}
