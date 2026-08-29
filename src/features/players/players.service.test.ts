import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { PlayersService } from './players.service.js';

const player = {
  id: 'player-1',
  userId: null,
  lastName: 'Ким',
  firstName: 'Сергей',
  middleName: null,
  birthYear: 1998,
  gender: 'MALE',
  city: 'Алматы',
  photoUrl: null,
  clubId: 'club-1',
  // Prisma отдаёт Decimal — объект, а не число.
  rating: { toString: () => '250.00' },
  ratedMatches: 0,
  isProvisional: true,
  createdAt: new Date('2026-08-29T00:00:00.000Z'),
};

const newcomer = {
  lastName: 'Ким',
  firstName: 'Сергей',
  birthYear: 1998,
  gender: 'MALE' as const,
  city: 'Алматы',
};

function makePrisma() {
  return {
    player: {
      findMany: vi.fn().mockResolvedValue([player]),
      count: vi.fn().mockResolvedValue(1),
      findUnique: vi.fn().mockResolvedValue(player),
      create: vi.fn().mockResolvedValue(player),
      update: vi.fn().mockResolvedValue(player),
    },
    club: { findUnique: vi.fn().mockResolvedValue({ id: 'club-1' }) },
    clubMember: { findUnique: vi.fn().mockResolvedValue(null) },
  };
}

let prisma: ReturnType<typeof makePrisma>;
let service: PlayersService;

beforeEach(() => {
  prisma = makePrisma();
  service = new PlayersService(prisma as unknown as PrismaService);
});

describe('представление игрока', () => {
  it('рейтинг отдаётся строкой, а не числом', async () => {
    // Decimal(8,2) через number теряет точность, а корректность рейтинга —
    // приоритет №1 брифа.
    const view = await service.findById('player-1');

    expect(view.rating).toBe('250.00');
    expect(typeof view.rating).toBe('string');
  });

  it('провизорность и число рейтинговых встреч видны', async () => {
    const view = await service.findById('player-1');

    expect(view).toMatchObject({ isProvisional: true, ratedMatches: 0 });
  });

  it('несуществующий игрок — NOT_FOUND', async () => {
    prisma.player.findUnique.mockResolvedValue(null);

    await expect(service.findById('нет')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('список игроков', () => {
  it('поиск идёт и по фамилии, и по имени', async () => {
    await service.list({ page: 1, limit: 20, search: 'ким' });

    const where = (prisma.player.findMany.mock.calls[0]?.[0] as { where: { OR?: unknown[] } })
      .where;
    expect(where.OR).toHaveLength(2);
  });

  it('сортировка по рейтингу вниз', async () => {
    await service.list({ page: 1, limit: 20 });

    expect((prisma.player.findMany.mock.calls[0]?.[0] as { orderBy: unknown[] }).orderBy).toEqual([
      { rating: 'desc' },
      { lastName: 'asc' },
    ]);
  });

  it('фильтр по клубу доходит до запроса', async () => {
    await service.list({ page: 1, limit: 20, clubId: 'club-1' });

    expect((prisma.player.findMany.mock.calls[0]?.[0] as { where: object }).where).toMatchObject({
      clubId: 'club-1',
    });
  });
});

describe('создание игрока', () => {
  it('первый профиль привязывается к вошедшему — регистрация по ТЗ 2.2', async () => {
    prisma.player.findUnique.mockResolvedValue(null);

    await service.create(newcomer, 'user-1');

    expect(
      (prisma.player.create.mock.calls[0]?.[0] as { data: { userId?: string } }).data.userId,
    ).toBe('user-1');
  });

  it('рейтинг при создании не задаётся: он проекция журнала', async () => {
    // ОВ-2 о стартовом значении открыт, до его решения работает умолчание схемы.
    prisma.player.findUnique.mockResolvedValue(null);

    await service.create(newcomer, 'user-1');

    expect((prisma.player.create.mock.calls[0]?.[0] as { data: object }).data).not.toHaveProperty(
      'rating',
    );
  });

  it('у кого профиль уже есть — заводит чужого, но только в своём клубе', async () => {
    prisma.player.findUnique.mockResolvedValue({ id: 'player-1' });
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'ORGANIZER' });

    await service.create({ ...newcomer, clubId: 'club-1' }, 'user-1');

    const data = (prisma.player.create.mock.calls[0]?.[0] as { data: { userId?: string } }).data;
    expect(data.userId).toBeUndefined();
  });

  it('чужого игрока без клуба завести нельзя', async () => {
    prisma.player.findUnique.mockResolvedValue({ id: 'player-1' });

    await expect(service.create(newcomer, 'user-1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('посторонний в чужом клубе игрока не заводит', async () => {
    prisma.player.findUnique.mockResolvedValue({ id: 'player-1' });
    prisma.clubMember.findUnique.mockResolvedValue(null);

    await expect(service.create({ ...newcomer, clubId: 'club-1' }, 'user-1')).rejects.toMatchObject(
      {
        code: 'FORBIDDEN',
      },
    );
  });

  it('судья клуба игроков не заводит — ТЗ 1 даёт ему только турнир', async () => {
    prisma.player.findUnique.mockResolvedValue({ id: 'player-1' });
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'REFEREE' });

    await expect(service.create({ ...newcomer, clubId: 'club-1' }, 'user-1')).rejects.toMatchObject(
      {
        code: 'FORBIDDEN',
      },
    );
  });

  it('несуществующий клуб — NOT_FOUND, а не отказ внешнего ключа', async () => {
    prisma.club.findUnique.mockResolvedValue(null);

    await expect(service.create({ ...newcomer, clubId: 'club-9' }, 'user-1')).rejects.toMatchObject(
      {
        code: 'NOT_FOUND',
      },
    );
    expect(prisma.player.create).not.toHaveBeenCalled();
  });
});

describe('право править профиль', () => {
  it('свой профиль — можно', async () => {
    prisma.player.findUnique.mockResolvedValue({ userId: 'user-1', clubId: null });

    await expect(service.assertCanEdit('player-1', 'user-1')).resolves.toBeUndefined();
  });

  it('организатор клуба игрока — можно', async () => {
    prisma.player.findUnique.mockResolvedValue({ userId: null, clubId: 'club-1' });
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'ORGANIZER' });

    await expect(service.assertCanEdit('player-1', 'user-2')).resolves.toBeUndefined();
  });

  it('судья того же клуба — нельзя', async () => {
    prisma.player.findUnique.mockResolvedValue({ userId: null, clubId: 'club-1' });
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'REFEREE' });

    await expect(service.assertCanEdit('player-1', 'user-2')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('посторонний — нельзя', async () => {
    prisma.player.findUnique.mockResolvedValue({ userId: 'user-9', clubId: 'club-1' });
    prisma.clubMember.findUnique.mockResolvedValue(null);

    await expect(service.assertCanEdit('player-1', 'user-2')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('игрок без клуба правится только своим владельцем аккаунта', async () => {
    prisma.player.findUnique.mockResolvedValue({ userId: null, clubId: null });

    await expect(service.assertCanEdit('player-1', 'user-2')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
