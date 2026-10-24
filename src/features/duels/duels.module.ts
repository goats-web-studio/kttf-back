import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { DuelRatingService } from './duel-rating.service.js';
import { DuelsAdminService } from './duels-admin.service.js';
import { DuelsAdminController, DuelsController } from './duels.controller.js';
import { DuelsService } from './duels.service.js';

/** Дуэли и спарринги — ADR-065, `docs/13`. Уведомления и рейтинг — той же транзакцией. */
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [DuelsController, DuelsAdminController],
  providers: [DuelRatingService, DuelsService, DuelsAdminService],
})
export class DuelsModule {}
