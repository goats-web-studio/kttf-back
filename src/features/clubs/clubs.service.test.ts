import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { ClubsService } from './clubs.service.js';

const club = {
  id: 'club-1',
  name: 'Ракетка',
  shortName: null,
  city: 'Алматы',
  address: null,
  lat: null,
  lng: null,
  tableCount: 6,
  phone: null,
  whatsapp: null,
  instagram: null,
  logoUrl: null,
  description: null,
  createdAt: new Date('2026-08-29T00:00:00.000Z'),
};

function makePrisma() {
  const prisma = {
    club: {
      findMany: vi.fn().mockResolvedValue([club]),
      count: vi.fn().mockResolvedValue(1),
      findUnique: vi.fn().mockResolvedValue(club),
      create: vi.fn().mockResolvedValue(club),
      update: vi.fn().mockResolvedValue(club),
    },
    clubMember: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(1),
      create: vi.fn().mockResolvedValue({}),
      upsert: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    user: { findUnique: vi.fn().mockResolvedValue({ id: 'user-1' }) },
    $transaction: vi.fn(),
  };

  prisma.$transaction.mockImplementation((run: (tx: typeof prisma) => unknown) => run(prisma));

  return prisma;
}

let prisma: ReturnType<typeof makePrisma>;
let service: ClubsService;

beforeEach(() => {
  prisma = makePrisma();
  service = new ClubsService(prisma as unknown as PrismaService);
});

describe('список клубов', () => {
  it('отдаёт страницу с общим числом', async () => {
    const page = await service.list({ page: 1, limit: 20 });

    expect(page).toMatchObject({ total: 1, page: 1, limit: 20 });
    expect(page.items).toHaveLength(1);
  });

  it('пропускает записи предыдущих страниц', async () => {
    await service.list({ page: 3, limit: 20 });

    expect(prisma.club.findMany.mock.calls[0]?.[0]).toMatchObject({ skip: 40, take: 20 });
  });

  it('поиск по названию не зависит от регистра', async () => {
    await service.list({ page: 1, limit: 20, search: 'ракет' });

    const query = prisma.club.findMany.mock.calls[0]?.[0] as {
      where: { name?: { contains: string; mode: string } };
    };
    expect(query.where.name).toEqual({ contains: 'ракет', mode: 'insensitive' });
  });

  it('без фильтров условие пустое, а не с undefined внутри', async () => {
    // Prisma трактует undefined как «не фильтровать», но пустой объект
    // читается однозначно и не зависит от этой трактовки.
    await service.list({ page: 1, limit: 20 });

    expect((prisma.club.findMany.mock.calls[0]?.[0] as { where: object }).where).toEqual({});
  });

  it('баланс и тариф в карточку не попадают', async () => {
    // Финансы клуба — отдельный эндпоинт с отдельными правами.
    const page = await service.list({ page: 1, limit: 20 });

    expect(page.items[0]).not.toHaveProperty('balance');
    expect(page.items[0]).not.toHaveProperty('tariffId');
  });
});

describe('создание клуба', () => {
  it('создатель сразу становится владельцем', async () => {
    // Иначе клуб появляется без человека, который может им управлять.
    await service.create({ name: 'Ракетка', city: 'Алматы' }, 'user-1');

    expect(prisma.clubMember.create).toHaveBeenCalledWith({
      data: { clubId: 'club-1', userId: 'user-1', role: 'OWNER' },
    });
  });

  it('клуб и владелец создаются одной транзакцией', async () => {
    await service.create({ name: 'Ракетка', city: 'Алматы' }, 'user-1');

    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });

  it('незаданные поля не уезжают в базу как undefined', async () => {
    await service.create({ name: 'Ракетка', city: 'Алматы' }, 'user-1');

    const data = (prisma.club.create.mock.calls[0]?.[0] as { data: object }).data;
    expect(Object.keys(data).sort()).toEqual(['city', 'name']);
  });
});

describe('изменение клуба', () => {
  it('несуществующий клуб — NOT_FOUND, а не отказ базы', async () => {
    prisma.club.findUnique.mockResolvedValue(null);

    await expect(service.update('нет', { name: 'Другое' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(prisma.club.update).not.toHaveBeenCalled();
  });

  it('переданные поля меняются, остальные не трогаются', async () => {
    await service.update('club-1', { name: 'Другое' });

    expect((prisma.club.update.mock.calls[0]?.[0] as { data: object }).data).toEqual({
      name: 'Другое',
    });
  });
});

describe('состав клуба', () => {
  it('имя пустое, пока профиль игрока не заполнен', async () => {
    prisma.clubMember.findMany.mockResolvedValue([
      { userId: 'user-1', role: 'OWNER', user: { player: null } },
    ]);

    const members = await service.listMembers('club-1');

    expect(members[0]).toMatchObject({ userId: 'user-1', role: 'OWNER', name: null });
  });

  it('имя собирается из фамилии и имени', async () => {
    prisma.clubMember.findMany.mockResolvedValue([
      {
        userId: 'user-1',
        role: 'ORGANIZER',
        user: { player: { id: 'p-1', lastName: 'Ким', firstName: 'Сергей' } },
      },
    ]);

    expect((await service.listMembers('club-1'))[0]?.name).toBe('Ким Сергей');
  });

  it('добавление несуществующего пользователя — NOT_FOUND', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.addMember('club-1', {
        userId: '00000000-0000-4000-8000-000000000000',
        role: 'REFEREE',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('повторное добавление меняет роль, а не отваливается', async () => {
    prisma.clubMember.findMany.mockResolvedValue([
      { userId: 'user-1', role: 'ORGANIZER', user: { player: null } },
    ]);

    await service.addMember('club-1', { userId: 'user-1', role: 'ORGANIZER' });

    expect(prisma.clubMember.upsert).toHaveBeenCalledOnce();
  });
});

describe('исключение из состава', () => {
  it('последнего владельца исключить нельзя', async () => {
    // Клуб остался бы без человека, который может назначить нового, и
    // починить это можно было бы только руками в базе.
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'OWNER' });
    prisma.clubMember.count.mockResolvedValue(1);

    await expect(service.removeMember('club-1', 'user-1')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(prisma.clubMember.delete).not.toHaveBeenCalled();
  });

  it('одного из двух владельцев — можно', async () => {
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'OWNER' });
    prisma.clubMember.count.mockResolvedValue(2);

    await service.removeMember('club-1', 'user-1');

    expect(prisma.clubMember.delete).toHaveBeenCalledOnce();
  });

  it('организатора — можно всегда', async () => {
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'ORGANIZER' });

    await service.removeMember('club-1', 'user-1');

    expect(prisma.clubMember.delete).toHaveBeenCalledOnce();
  });

  it('того, кого нет в составе, — NOT_FOUND', async () => {
    prisma.clubMember.findUnique.mockResolvedValue(null);

    await expect(service.removeMember('club-1', 'user-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
