import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { PlacesAdminController, PlacesController } from './places.controller.js';
import { PlacesService } from './places.service.js';

@Module({
  // AuthModule нужен ради guard'ов администратора.
  imports: [AuthModule],
  controllers: [PlacesController, PlacesAdminController],
  providers: [PlacesService],
  // Клубы и игроки сверяют выбранный город со справочником.
  exports: [PlacesService],
})
export class PlacesModule {}
