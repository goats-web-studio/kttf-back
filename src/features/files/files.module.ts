import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { FilesController } from './files.controller.js';
import { StorageService } from './storage.service.js';

@Module({
  imports: [AuthModule],
  controllers: [FilesController],
  providers: [StorageService],
  exports: [StorageService],
})
export class FilesModule {}
