import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import type { StorageService } from '../files/storage.service.js';
import { ClubMediaService } from './club-media.service.js';
import type { YoutubeCovers } from './youtube-covers.js';

const row = {
  id: 'media-1',
  clubId: 'club-1',
  kind: 'VIDEO' as const,
  imageUrl: '/api/v1/files/clubs/x.webp',
  youtubeId: 'dQw4w9WgXcQ',
  width: 1280,
  height: 720,
  caption: null,
  createdAt: new Date('2026-10-20T10:00:00.000Z'),
  hiddenAt: null,
};

const processed = {
  width: 1280,
  height: 720,
  variants: new Map([
    [480, Buffer.from('s')],
    [960, Buffer.from('m')],
    [1600, Buffer.from('l')],
  ]),
};

function makeDeps() {
  const prisma = {
    club: { findUnique: vi.fn().mockResolvedValue({ plan: 'FREE' }) },
    clubMedia: {
      findMany: vi.fn().mockResolvedValue([row]),
      findFirst: vi.fn().mockResolvedValue({ id: 'media-1' }),
      count: vi.fn().mockResolvedValue(0),
      aggregate: vi.fn().mockResolvedValue({ _max: { sortOrder: 4 } }),
      create: vi.fn().mockResolvedValue(row),
      update: vi.fn().mockResolvedValue(row),
      delete: vi.fn().mockResolvedValue(row),
    },
    $transaction: vi.fn().mockResolvedValue([]),
  };
  const images = {
    process: vi.fn().mockResolvedValue(processed),
    processVideoCover: vi.fn().mockResolvedValue(processed),
  };
  const storage = { putAt: vi.fn().mockResolvedValue(undefined) };
  const covers = {
    fetch: vi.fn().mockResolvedValue({ body: Buffer.from('jpg'), letterboxed: true }),
  };

  return { prisma, images, storage, covers };
}

let deps: ReturnType<typeof makeDeps>;
let service: ClubMediaService;

beforeEach(() => {
  deps = makeDeps();
  service = new ClubMediaService(
    deps.prisma as unknown as PrismaService,
    deps.images,
    deps.storage as unknown as StorageService,
    deps.covers as unknown as YoutubeCovers,
  );
});

describe('видео', () => {
  it('ссылка YouTube — обложка скачивается, срезается до 16:9 и хранится у нас', async () => {
    const media = await service.addVideo(
      'club-1',
      { url: 'https://youtu.be/dQw4w9WgXcQ', caption: 'Финал' },
      'user-1',
    );

    expect(deps.covers.fetch).toHaveBeenCalledWith('dQw4w9WgXcQ');
    expect(deps.images.processVideoCover).toHaveBeenCalledWith(Buffer.from('jpg'), true);
    expect(deps.storage.putAt).toHaveBeenCalledTimes(3);
    expect(deps.prisma.clubMedia.create.mock.calls[0]?.[0]).toMatchObject({
      data: { kind: 'VIDEO', youtubeId: 'dQw4w9WgXcQ', caption: 'Финал', sortOrder: 5 },
    });
    expect(media).toMatchObject({ hidden: false, createdAt: '2026-10-20T10:00:00.000Z' });
  });

  it('чужая ссылка — отказ до похода в YouTube', async () => {
    await expect(
      service.addVideo('club-1', { url: 'https://vimeo.com/1' }, 'user-1'),
    ).rejects.toMatchObject({ code: 'VIDEO_NOT_FOUND' });
    expect(deps.covers.fetch).not.toHaveBeenCalled();
  });

  it('предел видео — отказ с названием предела', async () => {
    deps.prisma.clubMedia.count.mockResolvedValue(20);

    await expect(
      service.addVideo('club-1', { url: 'https://youtu.be/dQw4w9WgXcQ' }, 'user-1'),
    ).rejects.toMatchObject({ code: 'CLUB_PLAN_LIMIT', details: { limit: 'videos', max: 20 } });
  });
});

describe('фото', () => {
  it('первое фото галереи — в начало порядка', async () => {
    deps.prisma.clubMedia.aggregate.mockResolvedValue({ _max: { sortOrder: null } });

    await service.addPhoto('club-1', Buffer.from('jpg'), null, 'user-1');

    expect(deps.images.process).toHaveBeenCalled();
    expect(deps.prisma.clubMedia.create.mock.calls[0]?.[0]).toMatchObject({
      data: { kind: 'PHOTO', youtubeId: null, sortOrder: 0, width: 1280, height: 720 },
    });
  });

  it('предел фото проверяется до обработки файла', async () => {
    deps.prisma.clubMedia.count.mockResolvedValue(100);

    await expect(
      service.addPhoto('club-1', Buffer.from('jpg'), null, 'user-1'),
    ).rejects.toMatchObject({ code: 'CLUB_PLAN_LIMIT', details: { limit: 'photos' } });
    expect(deps.images.process).not.toHaveBeenCalled();
  });

  it('несуществующий клуб — NOT_FOUND', async () => {
    deps.prisma.club.findUnique.mockResolvedValue(null);

    await expect(
      service.addPhoto('club-9', Buffer.from('jpg'), null, 'user-1'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('галерея', () => {
  it('публично — без скрытых, кабинету — все', async () => {
    await service.list('club-1');
    await service.list('club-1', true);

    expect(deps.prisma.clubMedia.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { clubId: 'club-1', hiddenAt: null },
    });
    expect(deps.prisma.clubMedia.findMany.mock.calls[1]?.[0]).toMatchObject({
      where: { clubId: 'club-1' },
    });
  });

  it('порядок — только своё и всё сразу', async () => {
    deps.prisma.clubMedia.findMany.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
    await service.reorder('club-1', { ids: ['b', 'a'] });
    expect(deps.prisma.$transaction).toHaveBeenCalledOnce();

    deps.prisma.clubMedia.findMany.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
    await expect(service.reorder('club-1', { ids: ['a', 'x'] })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });

    deps.prisma.clubMedia.findMany.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
    await expect(service.reorder('club-1', { ids: ['a'] })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('подпись и удаление — только своего медиа', async () => {
    await service.update('club-1', 'media-1', { caption: 'Зал' });
    await service.remove('club-1', 'media-1');
    expect(deps.prisma.clubMedia.delete).toHaveBeenCalledWith({ where: { id: 'media-1' } });

    deps.prisma.clubMedia.findFirst.mockResolvedValue(null);
    await expect(service.remove('club-1', 'media-9')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
