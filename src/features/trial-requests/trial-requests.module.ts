import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { TrialRequestsController } from './trial-requests.controller.js';
import { TrialRequestsService } from './trial-requests.service.js';

/** Заявка на пробную с сайта — T3 (ADR-059). Уведомления пишутся той же транзакцией. */
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [TrialRequestsController],
  providers: [TrialRequestsService],
})
export class TrialRequestsModule {}
