import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  clubLimits,
  parseYoutubeId,
  type AddClubVideoInput,
  type ClubMediaView,
  type MediaKind,
  type ReorderClubMediaInput,
  type UpdateClubMediaInput,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { storeClubImage } from '../files/club-image.js';
import { ImageService } from '../files/image.service.js';
import { StorageService } from '../files/storage.service.js';
import { mediaFields, toMediaView } from './content-views.js';
import { YoutubeCovers } from './youtube-covers.js';

/**
 * Фото и видео клуба — ADR-055, `docs/09` 3.2.
 *
 * Фото загружается сразу в галерею: сервер пережимает его тем же правилом,
 * что логотип и обложку, и сам знает размеры — клиенту их не доверяют.
 * Видео — ссылкой на YouTube, обложку сервер скачивает к себе.
 */
@Injectable()
export class ClubMediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly images: ImageService,
    private readonly storage: StorageService,
    private readonly covers: YoutubeCovers,
  ) {}

  /** Галерея публично — без скрытых, в порядке, заданном клубом. */
  async list(clubId: string, includeHidden = false): Promise<readonly ClubMediaView[]> {
    const rows = await this.prisma.clubMedia.findMany({
      where: { clubId, ...(includeHidden ? {} : { hiddenAt: null }) },
      select: mediaFields,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    return rows.map(toMediaView);
  }

  async addPhoto(
    clubId: string,
    file: Buffer,
    caption: string | null,
    userId: string,
  ): Promise<ClubMediaView> {
    await this.assertRoom(clubId, 'PHOTO');

    const image = await storeClubImage(this.storage, await this.images.process(file));

    return this.create(clubId, 'PHOTO', image, null, caption, userId);
  }

  async addVideo(clubId: string, input: AddClubVideoInput, userId: string): Promise<ClubMediaView> {
    const youtubeId = parseYoutubeId(input.url);

    if (youtubeId === null) {
      throw new AppError(ERROR_CODES.VIDEO_NOT_FOUND, 'Not a YouTube link', { field: 'url' });
    }

    await this.assertRoom(clubId, 'VIDEO');

    const cover = await this.covers.fetch(youtubeId);
    const image = await storeClubImage(
      this.storage,
      await this.images.processVideoCover(cover.body, cover.letterboxed),
    );

    return this.create(clubId, 'VIDEO', image, youtubeId, input.caption ?? null, userId);
  }

  async update(
    clubId: string,
    mediaId: string,
    input: UpdateClubMediaInput,
  ): Promise<ClubMediaView> {
    await this.assertInClub(clubId, mediaId);

    return toMediaView(
      await this.prisma.clubMedia.update({
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
  async reorder(clubId: string, input: ReorderClubMediaInput): Promise<readonly ClubMediaView[]> {
    const own = await this.prisma.clubMedia.findMany({ where: { clubId }, select: { id: true } });
    const ids = new Set(own.map((media) => media.id));

    if (input.ids.length !== ids.size || input.ids.some((id) => !ids.has(id))) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Order must list every club media once', {
        field: 'ids',
      });
    }

    await this.prisma.$transaction(
      input.ids.map((id, index) =>
        this.prisma.clubMedia.update({
          where: { id },
          data: { sortOrder: index },
          select: { id: true },
        }),
      ),
    );

    return this.list(clubId, true);
  }

  /**
   * Удаление записи. Файлы в хранилище остаются: ключ неизменяем и мог
   * разойтись по кэшам, а уборка осиротевших файлов — отдельная фоновая
   * задача вместе с BullMQ.
   */
  async remove(clubId: string, mediaId: string): Promise<void> {
    await this.assertInClub(clubId, mediaId);
    await this.prisma.clubMedia.delete({ where: { id: mediaId } });
  }

  private async create(
    clubId: string,
    kind: MediaKind,
    image: { url: string; width: number; height: number },
    youtubeId: string | null,
    caption: string | null,
    userId: string,
  ): Promise<ClubMediaView> {
    const last = await this.prisma.clubMedia.aggregate({
      where: { clubId },
      _max: { sortOrder: true },
    });

    return toMediaView(
      await this.prisma.clubMedia.create({
        data: {
          clubId,
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

  /** Предел тарифа — до обработки файла, а не после: незачем жать картинку, которую не сохранить. */
  private async assertRoom(clubId: string, kind: MediaKind): Promise<void> {
    const club = await this.prisma.club.findUnique({
      where: { id: clubId },
      select: { plan: true },
    });

    if (club === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Club not found', { id: clubId });
    }

    const limits = clubLimits(club.plan);
    const max = kind === 'PHOTO' ? limits.photos : limits.videos;
    const count = await this.prisma.clubMedia.count({ where: { clubId, kind } });

    if (count >= max) {
      throw new AppError(ERROR_CODES.CLUB_PLAN_LIMIT, 'Media limit reached', {
        limit: kind === 'PHOTO' ? 'photos' : 'videos',
        max,
      });
    }
  }

  private async assertInClub(clubId: string, mediaId: string): Promise<void> {
    const media = await this.prisma.clubMedia.findFirst({
      where: { id: mediaId, clubId },
      select: { id: true },
    });

    if (media === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Media not found', { id: mediaId });
    }
  }
}
