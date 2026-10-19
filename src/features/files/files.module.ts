import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { ClubsModule } from '../clubs/clubs.module.js';
import { FilesController } from './files.controller.js';
import { ImageService } from './image.service.js';
import { StorageService } from './storage.service.js';

@Module({
  // ClubsModule — ради проверки роли в клубе на загрузке его картинок.
  imports: [AuthModule, ClubsModule],
  controllers: [FilesController],
  providers: [StorageService, ImageService],
  exports: [StorageService, ImageService],
})
export class FilesModule {}
