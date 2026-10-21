import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { YoutubeCovers } from '../club-content/youtube-covers.js';
import { CoachOwnerGuard } from '../coaches/coach-owner.guard.js';
import { FilesModule } from '../files/files.module.js';
import { CoachContentAdminService } from './coach-content-admin.service.js';
import { CoachContentAdminController, CoachContentController } from './coach-content.controller.js';
import { CoachMediaService } from './coach-media.service.js';
import { CoachPostsService } from './coach-posts.service.js';

/**
 * Живая страница тренера — T2.2 (ADR-059), как у клуба (ADR-055).
 * Владелец страницы проверяется своим guard'ом, FilesModule — ради
 * обработки и хранения картинок, YoutubeCovers — тот же, что у клуба.
 */
@Module({
  imports: [AuthModule, FilesModule],
  controllers: [CoachContentController, CoachContentAdminController],
  providers: [
    CoachPostsService,
    CoachMediaService,
    CoachContentAdminService,
    YoutubeCovers,
    CoachOwnerGuard,
  ],
})
export class CoachContentModule {}
