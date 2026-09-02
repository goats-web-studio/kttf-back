import { Module } from '@nestjs/common';

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
  controllers: [ScreenController],
  providers: [ScreenService, ScreenEventsService],
  exports: [ScreenEventsService],
})
export class ScreenModule {}
