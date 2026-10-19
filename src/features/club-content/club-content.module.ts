import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { ClubsModule } from '../clubs/clubs.module.js';
import { FilesModule } from '../files/files.module.js';
import { ClubContentAdminService } from './club-content-admin.service.js';
import { ClubContentAdminController, ClubContentController } from './club-content.controller.js';
import { ClubMediaService } from './club-media.service.js';
import { ClubPostsService } from './club-posts.service.js';
import { YoutubeCovers } from './youtube-covers.js';

/**
 * Живая страница клуба — ADR-055, `docs/09` 3.2. ClubsModule — ради
 * проверки роли в клубе, FilesModule — ради обработки и хранения картинок.
 */
@Module({
  imports: [AuthModule, ClubsModule, FilesModule],
  controllers: [ClubContentController, ClubContentAdminController],
  providers: [ClubPostsService, ClubMediaService, ClubContentAdminService, YoutubeCovers],
})
export class ClubContentModule {}
