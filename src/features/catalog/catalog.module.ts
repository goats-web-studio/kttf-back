import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { FilesModule } from '../files/files.module.js';
import { CatalogAdminService } from './catalog-admin.service.js';
import { CatalogImageFetcher } from './catalog-image-fetcher.js';
import { CatalogImportService } from './catalog-import.service.js';
import { CatalogAdminController, CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';

/**
 * Каталог маркета — ADR-058, этап M1.1. AuthModule — ради проверки
 * администратора, FilesModule — ради обработки и хранения картинок.
 */
@Module({
  imports: [AuthModule, FilesModule],
  controllers: [CatalogController, CatalogAdminController],
  providers: [CatalogService, CatalogAdminService, CatalogImportService, CatalogImageFetcher],
})
export class CatalogModule {}
