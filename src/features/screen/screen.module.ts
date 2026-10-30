import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';

import { ScreenControlController } from './screen-control.controller.js';
import { ScreenControlService } from './screen-control.service.js';
import { ScreenController } from './screen.controller.js';
import { ScreenEventsService } from './screen-events.service.js';
import { ScreenService } from './screen.service.js';

/**
 * Второй экран — ТЗ 6.5.
 *
 * `ScreenEventsService` экспортируется наружу: в шину пишут те, кто меняет
 * турнир, — встречи и сам турнир. Обратной зависимости нет, экран собирает
 * состояние из базы сам, поэтому цикла между модулями не возникает.
 */
@Module({
  // Вход нужен управлению экраном из консоли (ADR-082); сама стена — без входа.
  imports: [AuthModule],
  controllers: [ScreenController, ScreenControlController],
  providers: [ScreenService, ScreenEventsService, ScreenControlService],
  exports: [ScreenEventsService],
})
export class ScreenModule {}
