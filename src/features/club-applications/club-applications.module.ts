import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import {
  ClubApplicationsAdminController,
  ClubApplicationsController,
} from './club-applications.controller.js';
import { ClubApplicationsService } from './club-applications.service.js';

@Module({
  // AuthModule — ради guard'ов: необязательного токена и администратора.
  imports: [AuthModule],
  controllers: [ClubApplicationsController, ClubApplicationsAdminController],
  providers: [ClubApplicationsService],
})
export class ClubApplicationsModule {}
