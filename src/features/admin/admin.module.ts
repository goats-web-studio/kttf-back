import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { AdminAuditService } from './admin-audit.service.js';
import { AdminClubsService } from './admin-clubs.service.js';
import { AdminPlayersService } from './admin-players.service.js';
import { AdminUsersService } from './admin-users.service.js';
import { AdminController } from './admin.controller.js';

/**
 * Управление аккаунтами, профилями и клубами — ADR-103.
 *
 * `AuthModule` — ради охраны администратора и отзыва токенов при
 * блокировке. Слияние анкеты и подтверждение берутся функциями из модуля
 * игроков, без его сервиса: тому нужны места и турниры, а здесь — только
 * запись в базу той же транзакцией.
 */
@Module({
  imports: [AuthModule],
  controllers: [AdminController],
  providers: [AdminUsersService, AdminPlayersService, AdminClubsService, AdminAuditService],
})
export class AdminModule {}
