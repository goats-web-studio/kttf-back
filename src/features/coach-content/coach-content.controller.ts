import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  CLUB_IMAGE_MAX_BYTES,
  addCoachVideoSchema,
  coachContentFeedSchema,
  createCoachPostSchema,
  hideCoachContentSchema,
  listCoachPostsSchema,
  rejectPhoto,
  reorderCoachMediaSchema,
  updateCoachMediaSchema,
  updateCoachPostSchema,
  type AddCoachVideoInput,
  type CoachContentItem,
  type CoachMediaView,
  type CoachPostView,
  type CreateCoachPostInput,
  type HideCoachContentInput,
  type ListCoachPostsQuery,
  type Page,
  type PageQuery,
  type ReorderCoachMediaInput,
  type UpdateCoachMediaInput,
  type UpdateCoachPostInput,
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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RequireAdmin } from '../auth/admin.guard.js';
import { CurrentUserId } from '../auth/jwt-auth.guard.js';
import { OptionalJwtGuard, OptionalUserId } from '../auth/optional-jwt.guard.js';
import { RequireCoachOwner } from '../coaches/coach-owner.guard.js';
import { CoachContentAdminService } from './coach-content-admin.service.js';
import { CoachMediaService } from './coach-media.service.js';
import { CoachPostsService } from './coach-posts.service.js';

const uuidParam = new ZodValidationPipe(z.uuid());

/** Подпись к фото приходит полем формы рядом с файлом. */
const captionField = new ZodValidationPipe(
  z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((value) => (value === undefined || value === '' ? null : value)),
);

interface IncomingFile {
  readonly buffer: Buffer;
  readonly mimetype: string;
  readonly size: number;
}

/**
 * Новости, акции, фото и видео тренера — T2.2 (ADR-059), маршруты клуба
 * под `/coaches/:id`. Чтение — у опубликованной страницы; правит владелец
 * страницы или администратор.
 */
@Controller('coaches/:id')
export class CoachContentController {
  constructor(
    private readonly posts: CoachPostsService,
    private readonly media: CoachMediaService,
  ) {}

  @Get('posts')
  @UseGuards(OptionalJwtGuard)
  async listPosts(
    @Param('id', uuidParam) id: string,
    @Query(new ZodValidationPipe(listCoachPostsSchema)) query: ListCoachPostsQuery,
    @OptionalUserId() viewerId: string | undefined,
  ): Promise<Page<CoachPostView>> {
    return this.posts.list(id, query, viewerId);
  }

  /** Все записи со скрытыми и прошедшими — кабинет тренера. */
  @Get('posts/all')
  @RequireCoachOwner()
  async listAllPosts(
    @Param('id', uuidParam) id: string,
    @Query(new ZodValidationPipe(listCoachPostsSchema)) query: ListCoachPostsQuery,
  ): Promise<Page<CoachPostView>> {
    return this.posts.listForOwner(id, query);
  }

  @Post('posts')
  @RequireCoachOwner()
  async createPost(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(createCoachPostSchema)) body: CreateCoachPostInput,
    @CurrentUserId() userId: string,
  ): Promise<CoachPostView> {
    return this.posts.create(id, body, userId);
  }

  @Patch('posts/:postId')
  @RequireCoachOwner()
  async updatePost(
    @Param('id', uuidParam) id: string,
    @Param('postId', uuidParam) postId: string,
    @Body(new ZodValidationPipe(updateCoachPostSchema)) body: UpdateCoachPostInput,
  ): Promise<CoachPostView> {
    return this.posts.update(id, postId, body);
  }

  @Delete('posts/:postId')
  @RequireCoachOwner()
  @HttpCode(HttpStatus.NO_CONTENT)
  async removePost(
    @Param('id', uuidParam) id: string,
    @Param('postId', uuidParam) postId: string,
  ): Promise<void> {
    await this.posts.remove(id, postId);
  }

  @Get('media')
  @UseGuards(OptionalJwtGuard)
  async listMedia(
    @Param('id', uuidParam) id: string,
    @OptionalUserId() viewerId: string | undefined,
  ): Promise<readonly CoachMediaView[]> {
    return this.media.list(id, viewerId);
  }

  /** Со скрытыми администратором — кабинет тренера. */
  @Get('media/all')
  @RequireCoachOwner()
  async listAllMedia(@Param('id', uuidParam) id: string): Promise<readonly CoachMediaView[]> {
    return this.media.listForOwner(id);
  }

  @Post('media/photos')
  @RequireCoachOwner()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: CLUB_IMAGE_MAX_BYTES } }))
  async addPhoto(
    @Param('id', uuidParam) id: string,
    @Body('caption', captionField) caption: string | null,
    @CurrentUserId() userId: string,
    @UploadedFile() file?: IncomingFile,
  ): Promise<CoachMediaView> {
    if (file === undefined) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'File is missing', { field: 'file' });
    }

    const rejection = rejectPhoto({ type: file.mimetype, size: file.size }, CLUB_IMAGE_MAX_BYTES);

    if (rejection !== null) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'File is not accepted', {
        field: 'file',
        reason: rejection,
      });
    }

    return this.media.addPhoto(id, file.buffer, caption, userId);
  }

  @Post('media/videos')
  @RequireCoachOwner()
  async addVideo(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(addCoachVideoSchema)) body: AddCoachVideoInput,
    @CurrentUserId() userId: string,
  ): Promise<CoachMediaView> {
    return this.media.addVideo(id, body, userId);
  }

  @Put('media/order')
  @RequireCoachOwner()
  async reorderMedia(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(reorderCoachMediaSchema)) body: ReorderCoachMediaInput,
  ): Promise<readonly CoachMediaView[]> {
    return this.media.reorder(id, body);
  }

  @Patch('media/:mediaId')
  @RequireCoachOwner()
  async updateMedia(
    @Param('id', uuidParam) id: string,
    @Param('mediaId', uuidParam) mediaId: string,
    @Body(new ZodValidationPipe(updateCoachMediaSchema)) body: UpdateCoachMediaInput,
  ): Promise<CoachMediaView> {
    return this.media.update(id, mediaId, body);
  }

  @Delete('media/:mediaId')
  @RequireCoachOwner()
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeMedia(
    @Param('id', uuidParam) id: string,
    @Param('mediaId', uuidParam) mediaId: string,
  ): Promise<void> {
    await this.media.remove(id, mediaId);
  }
}

/** Модерация контента тренеров — администратор платформы (постмодерация). */
@Controller('admin/coach-content')
@RequireAdmin()
export class CoachContentAdminController {
  constructor(private readonly admin: CoachContentAdminService) {}

  @Get()
  async feed(
    @Query(new ZodValidationPipe(coachContentFeedSchema)) query: PageQuery,
  ): Promise<Page<CoachContentItem>> {
    return this.admin.feed(query);
  }

  @Patch('posts/:postId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async hidePost(
    @Param('postId', uuidParam) postId: string,
    @Body(new ZodValidationPipe(hideCoachContentSchema)) body: HideCoachContentInput,
  ): Promise<void> {
    await this.admin.hidePost(postId, body);
  }

  @Patch('media/:mediaId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async hideMedia(
    @Param('mediaId', uuidParam) mediaId: string,
    @Body(new ZodValidationPipe(hideCoachContentSchema)) body: HideCoachContentInput,
  ): Promise<void> {
    await this.admin.hideMedia(mediaId, body);
  }
}
