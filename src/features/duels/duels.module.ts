import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { DuelMatchService } from './duel-match.service.js';
import { DuelRatingService } from './duel-rating.service.js';
import { DuelRemindersService } from './duel-reminders.service.js';
import { DuelsAdminService } from './duels-admin.service.js';
import { DuelMatchController, DuelsAdminController, DuelsController } from './duels.controller.js';
import { DuelsService } from './duels.service.js';

/**
 * Дуэли и спарринги — ADR-065, `docs/13`. Уведомления и рейтинг — той же транзакцией;
 * матч и напоминания — ADR-068.
 */
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [DuelsController, DuelMatchController, DuelsAdminController],
  providers: [
    DuelRatingService,
    DuelsService,
    DuelMatchService,
    DuelsAdminService,
    DuelRemindersService,
  ],
})
export class DuelsModule {}
