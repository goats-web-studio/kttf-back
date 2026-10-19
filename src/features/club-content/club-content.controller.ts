import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  CLUB_IMAGE_MAX_BYTES,
  addClubVideoSchema,
  clubContentFeedSchema,
  createClubPostSchema,
  hideClubContentSchema,
  listClubPostsSchema,
  rejectPhoto,
  reorderClubMediaSchema,
  updateClubMediaSchema,
  updateClubPostSchema,
  type AddClubVideoInput,
  type ClubContentItem,
  type ClubMediaView,
  type ClubPostView,
  type CreateClubPostInput,
  type HideClubContentInput,
  type ListClubPostsQuery,
  type Page,
  type PageQuery,
  type ReorderClubMediaInput,
  type UpdateClubMediaInput,
  type UpdateClubPostInput,
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
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RequireAdmin } from '../auth/admin.guard.js';
import { CurrentUserId } from '../auth/jwt-auth.guard.js';
import { RequireClubRole } from '../clubs/club-role.guard.js';
import { ClubContentAdminService } from './club-content-admin.service.js';
import { ClubMediaService } from './club-media.service.js';
import { ClubPostsService } from './club-posts.service.js';

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
 * Новости, акции, фото и видео клуба — ADR-055, `docs/09` 3.2.
 *
 * Чтение публично, как и сама страница клуба. Правит состав клуба — владелец
 * и организаторы (ADR-043).
 */
@Controller('clubs/:id')
export class ClubContentController {
  constructor(
    private readonly posts: ClubPostsService,
    private readonly media: ClubMediaService,
  ) {}

  @Get('posts')
  async listPosts(
    @Param('id', uuidParam) id: string,
    @Query(new ZodValidationPipe(listClubPostsSchema)) query: ListClubPostsQuery,
  ): Promise<Page<ClubPostView>> {
    return this.posts.list(id, query);
  }

  /** Все записи со скрытыми и прошедшими — кабинет клуба. */
  @Get('posts/all')
  @RequireClubRole('OWNER', 'ORGANIZER')
  async listAllPosts(
    @Param('id', uuidParam) id: string,
    @Query(new ZodValidationPipe(listClubPostsSchema)) query: ListClubPostsQuery,
  ): Promise<Page<ClubPostView>> {
    return this.posts.listForStaff(id, query);
  }

  @Post('posts')
  @RequireClubRole('OWNER', 'ORGANIZER')
  async createPost(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(createClubPostSchema)) body: CreateClubPostInput,
    @CurrentUserId() userId: string,
  ): Promise<ClubPostView> {
    return this.posts.create(id, body, userId);
  }

  @Patch('posts/:postId')
  @RequireClubRole('OWNER', 'ORGANIZER')
  async updatePost(
    @Param('id', uuidParam) id: string,
    @Param('postId', uuidParam) postId: string,
    @Body(new ZodValidationPipe(updateClubPostSchema)) body: UpdateClubPostInput,
  ): Promise<ClubPostView> {
    return this.posts.update(id, postId, body);
  }

  @Delete('posts/:postId')
  @RequireClubRole('OWNER', 'ORGANIZER')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removePost(
    @Param('id', uuidParam) id: string,
    @Param('postId', uuidParam) postId: string,
  ): Promise<void> {
    await this.posts.remove(id, postId);
  }

  @Get('media')
  async listMedia(@Param('id', uuidParam) id: string): Promise<readonly ClubMediaView[]> {
    return this.media.list(id);
  }

  /** Со скрытыми администратором — кабинет клуба. */
  @Get('media/all')
  @RequireClubRole('OWNER', 'ORGANIZER')
  async listAllMedia(@Param('id', uuidParam) id: string): Promise<readonly ClubMediaView[]> {
    return this.media.list(id, true);
  }

  @Post('media/photos')
  @RequireClubRole('OWNER', 'ORGANIZER')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: CLUB_IMAGE_MAX_BYTES } }))
  async addPhoto(
    @Param('id', uuidParam) id: string,
    @Body('caption', captionField) caption: string | null,
    @CurrentUserId() userId: string,
    @UploadedFile() file?: IncomingFile,
  ): Promise<ClubMediaView> {
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
  @RequireClubRole('OWNER', 'ORGANIZER')
  async addVideo(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(addClubVideoSchema)) body: AddClubVideoInput,
    @CurrentUserId() userId: string,
  ): Promise<ClubMediaView> {
    return this.media.addVideo(id, body, userId);
  }

  @Put('media/order')
  @RequireClubRole('OWNER', 'ORGANIZER')
  async reorderMedia(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(reorderClubMediaSchema)) body: ReorderClubMediaInput,
  ): Promise<readonly ClubMediaView[]> {
    return this.media.reorder(id, body);
  }

  @Patch('media/:mediaId')
  @RequireClubRole('OWNER', 'ORGANIZER')
  async updateMedia(
    @Param('id', uuidParam) id: string,
    @Param('mediaId', uuidParam) mediaId: string,
    @Body(new ZodValidationPipe(updateClubMediaSchema)) body: UpdateClubMediaInput,
  ): Promise<ClubMediaView> {
    return this.media.update(id, mediaId, body);
  }

  @Delete('media/:mediaId')
  @RequireClubRole('OWNER', 'ORGANIZER')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeMedia(
    @Param('id', uuidParam) id: string,
    @Param('mediaId', uuidParam) mediaId: string,
  ): Promise<void> {
    await this.media.remove(id, mediaId);
  }
}

/** Модерация — администратор платформы (ADR-055, постмодерация). */
@Controller('admin/club-content')
@RequireAdmin()
export class ClubContentAdminController {
  constructor(private readonly admin: ClubContentAdminService) {}

  @Get()
  async feed(
    @Query(new ZodValidationPipe(clubContentFeedSchema)) query: PageQuery,
  ): Promise<Page<ClubContentItem>> {
    return this.admin.feed(query);
  }

  @Patch('posts/:postId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async hidePost(
    @Param('postId', uuidParam) postId: string,
    @Body(new ZodValidationPipe(hideClubContentSchema)) body: HideClubContentInput,
  ): Promise<void> {
    await this.admin.hidePost(postId, body);
  }

  @Patch('media/:mediaId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async hideMedia(
    @Param('mediaId', uuidParam) mediaId: string,
    @Body(new ZodValidationPipe(hideClubContentSchema)) body: HideClubContentInput,
  ): Promise<void> {
    await this.admin.hideMedia(mediaId, body);
  }
}
