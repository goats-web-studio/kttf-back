import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { FollowsModule } from '../follows/follows.module.js';
import { TournamentsModule } from '../tournaments/tournaments.module.js';
import { FeedController } from './feed.controller.js';
import { FeedService } from './feed.service.js';

@Module({
  imports: [AuthModule, FollowsModule, TournamentsModule],
  controllers: [FeedController],
  providers: [FeedService],
})
export class FeedModule {}
