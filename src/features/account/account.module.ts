import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { FilesModule } from '../files/files.module.js';
import { AccountDeletionService } from './account-deletion.service.js';
import { AccountRequestsService } from './account-requests.service.js';
import { AccountRestoreService } from './account-restore.service.js';
import { AccountController, AccountRequestsAdminController } from './account.controller.js';
import { ArchivePurgeService } from './archive-purge.service.js';

/**
 * Удаление аккаунта заявкой, архив и восстановление — ADR-092, ADR-095.
 * Отдельно от `AuthModule`: удалению нужно хранилище файлов, а `FilesModule`
 * сам зависит от `AuthModule`.
 */
@Module({
  imports: [AuthModule, FilesModule],
  controllers: [AccountController, AccountRequestsAdminController],
  providers: [
    AccountDeletionService,
    AccountRestoreService,
    AccountRequestsService,
    ArchivePurgeService,
  ],
})
export class AccountModule {}
