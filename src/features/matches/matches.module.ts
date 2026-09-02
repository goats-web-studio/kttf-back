import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { ScreenModule } from '../screen/screen.module.js';
import { MatchesController } from './matches.controller.js';
import { MatchesService } from './matches.service.js';

@Module({
  // ScreenModule — ради шины изменений: ввод счёта будит второй экран.
  imports: [AuthModule, ScreenModule],
  controllers: [MatchesController],
  providers: [MatchesService],
  // Синхронизация офлайн-очереди применяет операции этим же сервисом (ТС 6.3).
  exports: [MatchesService],
})
export class MatchesModule {}
