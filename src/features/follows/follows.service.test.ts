import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { FollowsService } from './follows.service.js';

const ID = '00000000-0000-4000-8000-000000000001';

function makePrisma() {
  return {
    follow: {
      count: vi.fn().mockResolvedValue(3),
      findUnique: vi.fn().mockResolvedValue({ userId: 'user-1' }),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    club: {
      findFirst: vi.fn().mockResolvedValue({ id: ID }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    coach: {
      findFirst: vi.fn().mockResolvedValue({ id: ID }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    player: {
      findFirst: vi.fn().mockResolvedValue({ id: ID, userId: 'user-2' }),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
}

let prisma: ReturnType<typeof makePrisma>;
let service: FollowsService;

beforeEach(() => {
  prisma = makePrisma();
  service = new FollowsService(prisma as unknown as PrismaService);
});

describe('подписки — ADR-073', () => {
  it('подписка повторяемая: upsert, а ответ — счётчик и отметка', async () => {
    await expect(service.follow('CLUB', ID, 'user-1')).resolves.toEqual({
      followers: 3,
      following: true,
    });
    expect(prisma.follow.upsert).toHaveBeenCalledOnce();
  });

  it('на скрытый клуб не подписаться', async () => {
    prisma.club.findFirst.mockResolvedValue(null);

    await expect(service.follow('CLUB', ID, 'user-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(prisma.follow.upsert).not.toHaveBeenCalled();
  });

  it('на себя не подписаться', async () => {
    prisma.player.findFirst.mockResolvedValue({ id: ID, userId: 'user-1' });

    await expect(service.follow('PLAYER', ID, 'user-1')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('на игрока — только на игровой профиль (ADR-072)', async () => {
    await service.follow('PLAYER', ID, 'user-1');

    expect(prisma.player.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ID, confirmedAt: { not: null } } }),
    );
  });

  it('гостю — счётчик без отметки', async () => {
    await expect(service.state('COACH', ID)).resolves.toEqual({ followers: 3, following: false });
    expect(prisma.follow.findUnique).not.toHaveBeenCalled();
  });

  it('гостю рекомендуют популярное', async () => {
    prisma.club.findMany.mockResolvedValue([{ id: ID }]);
    prisma.club.findMany
      .mockResolvedValueOnce([{ id: ID }])
      .mockResolvedValueOnce([
        { id: ID, name: 'KTTF Тест', logoUrl: null, city: { name: 'Алматы' } },
      ]);

    const list = await service.suggestions(undefined, 5);

    expect(list).toEqual([
      expect.objectContaining({ type: 'CLUB', id: ID, reason: 'POPULAR', city: 'Алматы' }),
    ]);
  });
});
