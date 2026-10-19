import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { ClubsModule } from '../clubs/clubs.module.js';
import { CoachOwnerGuard } from '../coaches/coach-owner.guard.js';
import { FilesController } from './files.controller.js';
import { ImageService } from './image.service.js';
import { StorageService } from './storage.service.js';

@Module({
  // ClubsModule — ради проверки роли в клубе на загрузке его картинок.
  // Проверка владельца страницы тренера — своим guard'ом: модуль тренеров
  // сам берёт отсюда хранилище, и импорт в обе стороны замкнулся бы.
  imports: [AuthModule, ClubsModule],
  controllers: [FilesController],
  providers: [StorageService, ImageService, CoachOwnerGuard],
  exports: [StorageService, ImageService],
})
export class FilesModule {}
