import {
  createForumPostSchema,
  createForumReportSchema,
  createForumTopicSchema,
  forumMuteInputSchema,
  forumSectionInputSchema,
  forumSubjectTypeSchema,
  hideForumPostSchema,
  listForumPlayerPostsSchema,
  listForumPostsSchema,
  listForumReportsSchema,
  listForumTopicsSchema,
  moderateForumTopicSchema,
  pageQuerySchema,
  renameForumTopicSchema,
  resolveForumReportSchema,
  updateForumPostSchema,
  updateForumSectionSchema,
  type CreateForumPostInput,
  type CreateForumReportInput,
  type CreateForumTopicInput,
  type ForumLikeView,
  type ForumMe,
  type ForumMuteInput,
  type ForumMuteView,
  type ForumPostItem,
  type ForumPostLocation,
  type ForumPostView,
  type ForumReportView,
  type ForumSectionInput,
  type ForumSectionView,
  type ForumSubjectThread,
  type ForumSubjectType,
  type ForumTopicItem,
  type ForumTopicView,
  type HideForumPostInput,
  type ListForumPlayerPostsQuery,
  type ListForumPostsQuery,
  type ListForumReportsQuery,
  type ListForumTopicsQuery,
  type ModerateForumTopicInput,
  type Page,
  type PageQuery,
  type RenameForumTopicInput,
  type UpdateForumPostInput,
  type UpdateForumSectionInput,
} from '@kttf/shared/types';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RequireAdmin } from '../auth/admin.guard.js';
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { OptionalJwtGuard, OptionalUserId } from '../auth/optional-jwt.guard.js';
import { ForumAccessService } from './forum-access.service.js';
import { ForumModerationService } from './forum-moderation.service.js';
import { ForumPostsService } from './forum-posts.service.js';
import { ForumTopicsService } from './forum-topics.service.js';

const uuidParam = new ZodValidationPipe(z.uuid());
const subjectTypeParam = new ZodValidationPipe(forumSubjectTypeSchema);

/**
 * Форум — ADR-064, `docs/12`. Чтение открыто всем; ответ зависит от того,
 * кто спрашивает (скрытое видят автор и администратор), поэтому токен
 * читается, если он есть. Писать — под входом.
 */
@Controller('forum')
export class ForumController {
  constructor(
    private readonly access: ForumAccessService,
    private readonly topics: ForumTopicsService,
    private readonly posts: ForumPostsService,
  ) {}

  @Get('sections')
  async sections(): Promise<ForumSectionView[]> {
    return this.topics.sections();
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUserId() userId: string): Promise<ForumMe> {
    return this.access.me(userId);
  }

  // ---------------------------------------------------------------- темы

  @Get('topics')
  async listTopics(
    @Query(new ZodValidationPipe(listForumTopicsSchema)) query: ListForumTopicsQuery,
  ): Promise<Page<ForumTopicItem>> {
    return this.topics.list(query);
  }

  @Post('topics')
  @UseGuards(JwtAuthGuard)
  async createTopic(
    @Body(new ZodValidationPipe(createForumTopicSchema)) body: CreateForumTopicInput,
    @CurrentUserId() userId: string,
  ): Promise<ForumTopicView> {
    return this.topics.create(userId, body);
  }

  @Get('topics/:id')
  @UseGuards(OptionalJwtGuard)
  async topic(
    @Param('id', uuidParam) id: string,
    @OptionalUserId() userId?: string,
  ): Promise<ForumTopicView> {
    return this.topics.get(id, await this.access.viewer(userId));
  }

  @Patch('topics/:id')
  @UseGuards(JwtAuthGuard)
  async renameTopic(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(renameForumTopicSchema)) body: RenameForumTopicInput,
    @CurrentUserId() userId: string,
  ): Promise<ForumTopicView> {
    return this.topics.rename(id, userId, body);
  }

  @Get('topics/:id/posts')
  @UseGuards(OptionalJwtGuard)
  async listPosts(
    @Param('id', uuidParam) id: string,
    @Query(new ZodValidationPipe(listForumPostsSchema)) query: ListForumPostsQuery,
    @OptionalUserId() userId?: string,
  ): Promise<Page<ForumPostView>> {
    return this.posts.list(id, await this.access.viewer(userId), query);
  }

  @Post('topics/:id/posts')
  @UseGuards(JwtAuthGuard)
  async reply(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(createForumPostSchema)) body: CreateForumPostInput,
    @CurrentUserId() userId: string,
  ): Promise<ForumPostView> {
    return this.posts.reply(id, userId, body);
  }

  @Put('topics/:id/subscription')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async subscribe(
    @Param('id', uuidParam) id: string,
    @CurrentUserId() userId: string,
  ): Promise<void> {
    await this.topics.subscribe(id, userId, true);
  }

  @Delete('topics/:id/subscription')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async unsubscribe(
    @Param('id', uuidParam) id: string,
    @CurrentUserId() userId: string,
  ): Promise<void> {
    await this.topics.subscribe(id, userId, false);
  }

  // ---------------------------------------------------------------- сообщения

  /** Сообщения игрока — блок «На форуме» в профиле. */
  @Get('posts')
  async playerPosts(
    @Query(new ZodValidationPipe(listForumPlayerPostsSchema)) query: ListForumPlayerPostsQuery,
  ): Promise<Page<ForumPostItem>> {
    return this.posts.byPlayer(query);
  }

  @Get('posts/:id/locate')
  @UseGuards(OptionalJwtGuard)
  async locate(
    @Param('id', uuidParam) id: string,
    @OptionalUserId() userId?: string,
  ): Promise<ForumPostLocation> {
    return this.posts.locate(id, await this.access.viewer(userId));
  }

  @Patch('posts/:id')
  @UseGuards(JwtAuthGuard)
  async updatePost(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(updateForumPostSchema)) body: UpdateForumPostInput,
    @CurrentUserId() userId: string,
  ): Promise<ForumPostView> {
    return this.posts.update(id, userId, body);
  }

  @Delete('posts/:id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async removePost(
    @Param('id', uuidParam) id: string,
    @CurrentUserId() userId: string,
  ): Promise<void> {
    await this.posts.remove(id, userId);
  }

  @Put('posts/:id/like')
  @UseGuards(JwtAuthGuard)
  async like(
    @Param('id', uuidParam) id: string,
    @CurrentUserId() userId: string,
  ): Promise<ForumLikeView> {
    return this.posts.like(id, userId, true);
  }

  @Delete('posts/:id/like')
  @UseGuards(JwtAuthGuard)
  async unlike(
    @Param('id', uuidParam) id: string,
    @CurrentUserId() userId: string,
  ): Promise<ForumLikeView> {
    return this.posts.like(id, userId, false);
  }

  @Post('posts/:id/reports')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async report(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(createForumReportSchema)) body: CreateForumReportInput,
    @CurrentUserId() userId: string,
  ): Promise<void> {
    await this.posts.report(id, userId, body);
  }

  // ---------------------------------------------------------------- тема предмета (F2)

  @Get('subjects/:type/:id')
  @UseGuards(OptionalJwtGuard)
  async subject(
    @Param('type', subjectTypeParam) type: ForumSubjectType,
    @Param('id', uuidParam) id: string,
    @OptionalUserId() userId?: string,
  ): Promise<ForumSubjectThread> {
    return this.topics.subjectThread(type, id, await this.access.viewer(userId));
  }

  @Post('subjects/:type/:id/posts')
  @UseGuards(JwtAuthGuard)
  async postToSubject(
    @Param('type', subjectTypeParam) type: ForumSubjectType,
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(createForumPostSchema)) body: CreateForumPostInput,
    @CurrentUserId() userId: string,
  ): Promise<ForumPostView> {
    return this.topics.postToSubject(type, id, userId, body);
  }
}

/** Модерация форума — только администратор платформы (ADR-064 §5). */
@Controller('admin/forum')
export class ForumAdminController {
  constructor(private readonly moderation: ForumModerationService) {}

  @Get('reports')
  @RequireAdmin()
  async reports(
    @Query(new ZodValidationPipe(listForumReportsSchema)) query: ListForumReportsQuery,
  ): Promise<Page<ForumReportView>> {
    return this.moderation.reports(query);
  }

  @Post('reports/:id/resolve')
  @RequireAdmin()
  @HttpCode(HttpStatus.NO_CONTENT)
  async resolveReport(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(resolveForumReportSchema)) _body: unknown,
    @CurrentUserId() adminId: string,
  ): Promise<void> {
    await this.moderation.rejectReport(id, adminId);
  }

  @Patch('posts/:id')
  @RequireAdmin()
  @HttpCode(HttpStatus.NO_CONTENT)
  async hidePost(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(hideForumPostSchema)) body: HideForumPostInput,
    @CurrentUserId() adminId: string,
  ): Promise<void> {
    await this.moderation.hidePost(id, adminId, body);
  }

  @Patch('topics/:id')
  @RequireAdmin()
  @HttpCode(HttpStatus.NO_CONTENT)
  async moderateTopic(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(moderateForumTopicSchema)) body: ModerateForumTopicInput,
    @CurrentUserId() adminId: string,
  ): Promise<void> {
    await this.moderation.moderateTopic(id, adminId, body);
  }

  @Get('mutes')
  @RequireAdmin()
  async mutes(
    @Query(new ZodValidationPipe(pageQuerySchema)) query: PageQuery,
  ): Promise<Page<ForumMuteView>> {
    return this.moderation.mutes(query);
  }

  @Put('mutes/:userId')
  @RequireAdmin()
  @HttpCode(HttpStatus.NO_CONTENT)
  async mute(
    @Param('userId', uuidParam) userId: string,
    @Body(new ZodValidationPipe(forumMuteInputSchema)) body: ForumMuteInput,
    @CurrentUserId() adminId: string,
  ): Promise<void> {
    await this.moderation.mute(userId, adminId, body);
  }

  @Delete('mutes/:userId')
  @RequireAdmin()
  @HttpCode(HttpStatus.NO_CONTENT)
  async unmute(
    @Param('userId', uuidParam) userId: string,
    @CurrentUserId() adminId: string,
  ): Promise<void> {
    await this.moderation.unmute(userId, adminId);
  }

  @Get('sections')
  @RequireAdmin()
  async sections(): Promise<ForumSectionView[]> {
    return this.moderation.sections();
  }

  @Post('sections')
  @RequireAdmin()
  async createSection(
    @Body(new ZodValidationPipe(forumSectionInputSchema)) body: ForumSectionInput,
  ): Promise<ForumSectionView> {
    return this.moderation.createSection(body);
  }

  @Patch('sections/:id')
  @RequireAdmin()
  async updateSection(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(updateForumSectionSchema)) body: UpdateForumSectionInput,
  ): Promise<ForumSectionView> {
    return this.moderation.updateSection(id, body);
  }
}
