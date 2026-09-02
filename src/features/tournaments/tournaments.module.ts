import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { ScreenModule } from '../screen/screen.module.js';
import { TournamentsController } from './tournaments.controller.js';
import { TournamentsService } from './tournaments.service.js';

@Module({
  // AuthModule нужен обоим guard'ам: и обязательному, и необязательному.
  imports: [AuthModule, ScreenModule],
  controllers: [TournamentsController],
  providers: [TournamentsService],
  exports: [TournamentsService],
})
export class TournamentsModule {}
