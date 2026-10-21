import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  coachLimits,
  parseYoutubeId,
  type AddCoachVideoInput,
  type CoachMediaView,
  type MediaKind,
  type ReorderCoachMediaInput,
  type UpdateCoachMediaInput,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { YoutubeCovers } from '../club-content/youtube-covers.js';
import { storeImage } from '../files/club-image.js';
import { ImageService } from '../files/image.service.js';
import { StorageService } from '../files/storage.service.js';
import { assertCoachVisible, coachPage } from './coach-page.js';
import { mediaFields, toMediaView } from './content-views.js';

/**
 * Фото и видео тренера — T2.2 (ADR-059), механика клуба один в один
 * (`ClubMediaService`, ADR-055).
 *
 * Фото загружается сразу в галерею: сервер пережимает его тем же правилом,
 * что фото и обложку тренера, и сам знает размеры. Видео — ссылкой на
 * YouTube, обложку сервер скачивает к себе. Картинки — в папке тренера.
 */
@Injectable()
export class CoachMediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly images: ImageService,
    private readonly storage: StorageService,
    private readonly covers: YoutubeCovers,
  ) {}

  /** Галерея публично — без скрытых, в порядке, заданном тренером. */
  async list(coachId: string, viewerId: string | undefined): Promise<readonly CoachMediaView[]> {
    await assertCoachVisible(this.prisma, coachId, viewerId);

    return this.rows(coachId, false);
  }

  /** Со скрытыми администратором и причиной — кабинет тренера. */
  async listForOwner(coachId: string): Promise<readonly CoachMediaView[]> {
    return this.rows(coachId, true);
  }

  async addPhoto(
    coachId: string,
    file: Buffer,
    caption: string | null,
    userId: string,
  ): Promise<CoachMediaView> {
    await this.assertRoom(coachId, 'PHOTO');

    const image = await storeImage(this.storage, 'coaches', await this.images.process(file));

    return this.create(coachId, 'PHOTO', image, null, caption, userId);
  }

  async addVideo(
    coachId: string,
    input: AddCoachVideoInput,
    userId: string,
  ): Promise<CoachMediaView> {
    const youtubeId = parseYoutubeId(input.url);

    if (youtubeId === null) {
      throw new AppError(ERROR_CODES.VIDEO_NOT_FOUND, 'Not a YouTube link', { field: 'url' });
    }

    await this.assertRoom(coachId, 'VIDEO');

    const cover = await this.covers.fetch(youtubeId);
    const image = await storeImage(
      this.storage,
      'coaches',
      await this.images.processVideoCover(cover.body, cover.letterboxed),
    );

    return this.create(coachId, 'VIDEO', image, youtubeId, input.caption ?? null, userId);
  }

  async update(
    coachId: string,
    mediaId: string,
    input: UpdateCoachMediaInput,
  ): Promise<CoachMediaView> {
    await this.assertOwn(coachId, mediaId);

    return toMediaView(
      await this.prisma.coachMedia.update({
        where: { id: mediaId },
        data: { caption: input.caption },
        select: mediaFields,
      }),
    );
  }

  /**
   * Порядок галереи целиком. Чужие и неизвестные идентификаторы — отказ:
   * переставить можно только своё, и только всё сразу.
   */
  async reorder(
    coachId: string,
    input: ReorderCoachMediaInput,
  ): Promise<readonly CoachMediaView[]> {
    const own = await this.prisma.coachMedia.findMany({ where: { coachId }, select: { id: true } });
    const ids = new Set(own.map((media) => media.id));

    if (input.ids.length !== ids.size || input.ids.some((id) => !ids.has(id))) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Order must list every coach media once', {
        field: 'ids',
      });
    }

    await this.prisma.$transaction(
      input.ids.map((id, index) =>
        this.prisma.coachMedia.update({
          where: { id },
          data: { sortOrder: index },
          select: { id: true },
        }),
      ),
    );

    return this.rows(coachId, true);
  }

  /**
   * Удаление записи. Файлы в хранилище остаются, как у клуба: ключ
   * неизменяем и мог разойтись по кэшам.
   */
  async remove(coachId: string, mediaId: string): Promise<void> {
    await this.assertOwn(coachId, mediaId);
    await this.prisma.coachMedia.delete({ where: { id: mediaId } });
  }

  private async rows(coachId: string, includeHidden: boolean): Promise<CoachMediaView[]> {
    const rows = await this.prisma.coachMedia.findMany({
      where: { coachId, ...(includeHidden ? {} : { hiddenAt: null }) },
      select: mediaFields,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    return rows.map(toMediaView);
  }

  private async create(
    coachId: string,
    kind: MediaKind,
    image: { url: string; width: number; height: number },
    youtubeId: string | null,
    caption: string | null,
    userId: string,
  ): Promise<CoachMediaView> {
    const last = await this.prisma.coachMedia.aggregate({
      where: { coachId },
      _max: { sortOrder: true },
    });

    return toMediaView(
      await this.prisma.coachMedia.create({
        data: {
          coachId,
          kind,
          imageUrl: image.url,
          width: image.width,
          height: image.height,
          youtubeId,
          caption,
          createdById: userId,
          sortOrder: (last._max.sortOrder ?? -1) + 1,
        },
        select: mediaFields,
      }),
    );
  }

  /** Предел тарифа — до обработки файла: незачем жать картинку, которую не сохранить. */
  private async assertRoom(coachId: string, kind: MediaKind): Promise<void> {
    const limits = coachLimits((await coachPage(this.prisma, coachId)).plan);
    const max = kind === 'PHOTO' ? limits.photos : limits.videos;
    const count = await this.prisma.coachMedia.count({ where: { coachId, kind } });

    if (count >= max) {
      throw new AppError(ERROR_CODES.COACH_PLAN_LIMIT, 'Media limit reached', {
        limit: kind === 'PHOTO' ? 'photos' : 'videos',
        max,
      });
    }
  }

  private async assertOwn(coachId: string, mediaId: string): Promise<void> {
    const media = await this.prisma.coachMedia.findFirst({
      where: { id: mediaId, coachId },
      select: { id: true },
    });

    if (media === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Media not found', { id: mediaId });
    }
  }
}
