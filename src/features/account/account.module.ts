import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { FilesModule } from '../files/files.module.js';
import { AccountDeletionService } from './account-deletion.service.js';
import { AccountController } from './account.controller.js';

/**
 * Удаление аккаунта — ADR-092. Отдельно от `AuthModule`: удалению нужно
 * хранилище файлов, а `FilesModule` сам зависит от `AuthModule`.
 */
@Module({
  imports: [AuthModule, FilesModule],
  controllers: [AccountController],
  providers: [AccountDeletionService],
})
export class AccountModule {}
