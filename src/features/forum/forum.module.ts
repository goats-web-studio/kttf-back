import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ForumAccessService } from './forum-access.service.js';
import { ForumModerationService } from './forum-moderation.service.js';
import { ForumPostsService } from './forum-posts.service.js';
import { ForumSubjectsService } from './forum-subjects.service.js';
import { ForumTopicsService } from './forum-topics.service.js';
import { ForumAdminController, ForumController } from './forum.controller.js';

/** Форум — ADR-064, `docs/12`. Уведомления пишутся той же транзакцией, что и сообщение. */
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [ForumController, ForumAdminController],
  providers: [
    ForumAccessService,
    ForumSubjectsService,
    ForumPostsService,
    ForumTopicsService,
    ForumModerationService,
  ],
})
export class ForumModule {}
