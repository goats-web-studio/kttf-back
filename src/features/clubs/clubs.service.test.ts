import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { PlacesService } from '../places/places.service.js';
import { ClubsService } from './clubs.service.js';

const club = {
  id: 'club-1',
  name: 'Ракетка',
  shortName: null,
  city: { id: 'city-1', name: 'Алматы', nameKk: null },
  address: null,
  lat: null,
  lng: null,
  tableCount: 6,
  phone: null,
  whatsapp: null,
  instagram: null,
  logoUrl: null,
  description: null,
  coverUrl: null,
  website: null,
  telegram: null,
  twoGisUrl: null,
  amenities: [],
  tableBrand: null,
  floorType: null,
  ceilingHeightCm: null,
  hoursNote: null,
  primaryContact: null,
  profileReviewedAt: null,
  hiddenAt: null,
  hours: [],
  prices: [],
  tables: [],
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
    tournament: { groupBy: vi.fn().mockResolvedValue([]) },
    clubCoach: { groupBy: vi.fn().mockResolvedValue([]) },
    training: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findUnique: vi.fn().mockResolvedValue({ id: 'user-1' }) },
    city: { findFirst: vi.fn().mockResolvedValue({ id: 'city-1' }) },
    $transaction: vi.fn(),
  };

  prisma.$transaction.mockImplementation((run: (tx: typeof prisma) => unknown) => run(prisma));

  return prisma;
}

let prisma: ReturnType<typeof makePrisma>;
let service: ClubsService;

beforeEach(() => {
  prisma = makePrisma();
  const db = prisma as unknown as PrismaService;
  service = new ClubsService(db, new PlacesService(db));
});

describe('список клубов', () => {
  it('отдаёт страницу с общим числом', async () => {
    const page = await service.list({ page: 1, limit: 20 });

    expect(page).toMatchObject({ total: 1, page: 1, limit: 20 });
    expect(page.items).toHaveLength(1);
  });

  it('пропускает записи предыдущих страниц', async () => {
    prisma.club.findMany.mockResolvedValueOnce([
      { id: 'a', name: 'А', profileReviewedAt: null },
      { id: 'b', name: 'Б', profileReviewedAt: null },
      { id: 'c', name: 'В', profileReviewedAt: null },
    ]);

    const page = await service.list({ page: 2, limit: 1 });

    expect(page.total).toBe(3);
    expect(prisma.club.findMany.mock.calls[1]?.[0]).toMatchObject({ where: { id: { in: ['b'] } } });
  });

  it('поиск по названию не зависит от регистра', async () => {
    await service.list({ page: 1, limit: 20, search: 'ракет' });

    const query = prisma.club.findMany.mock.calls[0]?.[0] as {
      where: { name?: { contains: string; mode: string } };
    };
    expect(query.where.name).toEqual({ contains: 'ракет', mode: 'insensitive' });
  });

  it('без фильтров — только нескрытые, без undefined внутри', async () => {
    // Prisma трактует undefined как «не фильтровать», но условие без него
    // читается однозначно и не зависит от этой трактовки.
    await service.list({ page: 1, limit: 20 });

    expect((prisma.club.findMany.mock.calls[0]?.[0] as { where: object }).where).toEqual({
      hiddenAt: null,
    });
  });

  it('города и удобства — списком, удобства все сразу', async () => {
    await service.list({ page: 1, limit: 20, cityId: ['c1', 'c2'], amenities: ['SHOP', 'WIFI'] });

    expect((prisma.club.findMany.mock.calls[0]?.[0] as { where: object }).where).toEqual({
      hiddenAt: null,
      cityId: { in: ['c1', 'c2'] },
      amenities: { hasEvery: ['SHOP', 'WIFI'] },
    });
  });

  it('сначала ближайший турнир, затем свежесть страницы, затем название', async () => {
    prisma.club.findMany.mockResolvedValueOnce([
      { id: 'old', name: 'А', profileReviewedAt: new Date('2026-01-01') },
      { id: 'fresh', name: 'Я', profileReviewedAt: new Date('2026-10-01') },
      { id: 'never', name: 'Б', profileReviewedAt: null },
      { id: 'never2', name: 'В', profileReviewedAt: null },
      { id: 'soon', name: 'Ю', profileReviewedAt: null },
      { id: 'later', name: 'Э', profileReviewedAt: null },
    ]);
    prisma.tournament.groupBy.mockResolvedValueOnce([
      { clubId: 'later', _min: { startsAt: new Date('2026-11-01') } },
      { clubId: 'soon', _min: { startsAt: new Date('2026-10-25') } },
    ]);

    await service.list({ page: 1, limit: 20 });

    expect(prisma.club.findMany.mock.calls[1]?.[0]).toMatchObject({
      where: { id: { in: ['soon', 'later', 'fresh', 'old', 'never', 'never2'] } },
    });
  });

  it('«скоро турнир» — только клубы с ближайшим турниром, с его датой в карточке', async () => {
    prisma.club.findMany
      .mockResolvedValueOnce([
        { id: 'club-1', name: 'Ракетка', profileReviewedAt: null },
        { id: 'idle', name: 'Тишина', profileReviewedAt: null },
      ])
      .mockResolvedValueOnce([club]);
    prisma.tournament.groupBy.mockResolvedValueOnce([
      { clubId: 'club-1', _min: { startsAt: new Date('2026-10-25T09:00:00.000Z') } },
    ]);

    const page = await service.list({ page: 1, limit: 20, upcoming: true });

    expect(page.total).toBe(1);
    expect(page.items[0]?.nextTournamentAt).toBe('2026-10-25T09:00:00.000Z');
  });

  it('скрытый признак и даты уходят наружу без лишних полей', async () => {
    prisma.club.findMany
      .mockResolvedValueOnce([{ id: 'club-1', name: 'Ракетка', profileReviewedAt: null }])
      .mockResolvedValueOnce([
        { ...club, hiddenAt: new Date(), profileReviewedAt: new Date('2026-10-01T00:00:00Z') },
      ]);

    const page = await service.list({ page: 1, limit: 20 });

    expect(page.items[0]).toMatchObject({
      hidden: true,
      profileReviewedAt: '2026-10-01T00:00:00.000Z',
      nextTournamentAt: null,
    });
    expect(page.items[0]).not.toHaveProperty('hiddenAt');
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
    await service.create({ name: 'Ракетка', cityId: 'city-1' }, 'user-1');

    expect(prisma.clubMember.create).toHaveBeenCalledWith({
      data: { clubId: 'club-1', userId: 'user-1', role: 'OWNER' },
    });
  });

  it('клуб и владелец создаются одной транзакцией', async () => {
    await service.create({ name: 'Ракетка', cityId: 'city-1' }, 'user-1');

    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });

  it('незаданные поля не уезжают в базу как undefined', async () => {
    await service.create({ name: 'Ракетка', cityId: 'city-1' }, 'user-1');

    const data = (prisma.club.create.mock.calls[0]?.[0] as { data: object }).data;
    expect(Object.keys(data).sort()).toEqual(['cityId', 'name']);
  });

  it('город вне справочника или скрытый — отказ до записи', async () => {
    prisma.city.findFirst.mockResolvedValue(null);

    await expect(
      service.create({ name: 'Ракетка', cityId: 'city-9' }, 'user-1'),
    ).rejects.toMatchObject({ code: 'CITY_UNAVAILABLE' });
    expect(prisma.club.create).not.toHaveBeenCalled();
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

    // Сохранённая страница — свежая: отметка «обновлено» ставится сама (ADR-055).
    expect((prisma.club.update.mock.calls[0]?.[0] as { data: object }).data).toEqual({
      name: 'Другое',
      profileReviewedAt: expect.any(Date) as Date,
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
      service.addMember('club-1', { identifier: 'nobody', role: 'ORGANIZER' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('человек ищется логином или телефоном — тем же правилом, что при входе', async () => {
    prisma.clubMember.findMany.mockResolvedValue([
      { userId: 'user-1', role: 'ORGANIZER', user: { player: null } },
    ]);

    await service.addMember('club-1', { identifier: 'organizer', role: 'ORGANIZER' });
    await service.addMember('club-1', { identifier: '+77011234567', role: 'ORGANIZER' });

    expect(prisma.user.findUnique.mock.calls[0]?.[0]).toMatchObject({
      where: { login: 'organizer' },
    });
    expect(prisma.user.findUnique.mock.calls[1]?.[0]).toMatchObject({
      where: { phone: '+77011234567' },
    });
  });

  it('повторное добавление меняет роль, а не отваливается', async () => {
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'REFEREE' });
    prisma.clubMember.findMany.mockResolvedValue([
      { userId: 'user-1', role: 'ORGANIZER', user: { player: null } },
    ]);

    await service.addMember('club-1', { identifier: 'organizer', role: 'ORGANIZER' });

    expect(prisma.clubMember.upsert).toHaveBeenCalledOnce();
  });

  it('последнего владельца повторным добавлением не понизить', async () => {
    // Владелец, добавивший себя организатором, оставил бы клуб без
    // владельца — то же, что исключить его (ADR-043).
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'OWNER' });
    prisma.clubMember.count.mockResolvedValue(1);

    await expect(
      service.addMember('club-1', { identifier: 'owner', role: 'ORGANIZER' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(prisma.clubMember.upsert).not.toHaveBeenCalled();
  });

  it('одного из двух владельцев понизить можно', async () => {
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'OWNER' });
    prisma.clubMember.count.mockResolvedValue(2);
    prisma.clubMember.findMany.mockResolvedValue([
      { userId: 'user-1', role: 'ORGANIZER', user: { player: null } },
    ]);

    await service.addMember('club-1', { identifier: 'owner', role: 'ORGANIZER' });

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

describe('штаб и детские тренировки в списке (ADR-059, T2)', () => {
  it('число тренеров штаба и метка детских тренировок — по клубу', async () => {
    prisma.clubCoach.groupBy.mockResolvedValue([{ clubId: 'club-1', _count: { _all: 3 } }]);
    prisma.training.findMany.mockResolvedValue([{ clubId: 'club-1' }]);

    const page = await service.list({ page: 1, limit: 20 });

    expect(page.items[0]).toMatchObject({ coachesCount: 3, kidsTrainings: true });
    expect(prisma.clubCoach.groupBy.mock.calls[0]?.[0]).toMatchObject({
      where: { status: 'ACTIVE', coach: { is: { status: 'APPROVED', hiddenAt: null } } },
    });
  });

  it('без штаба и детских — ноль и нет метки', async () => {
    const page = await service.list({ page: 1, limit: 20 });

    expect(page.items[0]).toMatchObject({ coachesCount: 0, kidsTrainings: false });
  });

  it('фильтр kids — клубы с опубликованной тренировкой для детей или подростков', async () => {
    await service.list({ page: 1, limit: 20, kids: true });

    const where = (prisma.club.findMany.mock.calls[0]?.[0] as { where: { trainings: unknown } })
      .where;

    expect(where.trainings).toEqual({
      some: {
        audiences: { hasSome: ['KIDS', 'TEENS'] },
        OR: [
          { author: 'CLUB' },
          {
            author: 'COACH',
            link: 'CONFIRMED',
            coach: { is: { status: 'APPROVED', hiddenAt: null } },
          },
        ],
      },
    });
  });
});

describe('удобства клуба (ADR-059)', () => {
  it('прежняя «Детская секция» в базе наружу не отдаётся', async () => {
    prisma.club.findUnique.mockResolvedValueOnce({ ...club, amenities: ['WIFI', 'KIDS', 'SHOP'] });

    expect((await service.findById('club-1')).amenities).toEqual(['WIFI', 'SHOP']);
  });
});

describe('прайс клуба (ADR-059)', () => {
  it('тренировки и детские группы в прайс не попадают — они отдельной сущностью', async () => {
    await service.findById('club-1');

    const select = (
      prisma.club.findUnique.mock.calls[0]?.[0] as { select: { prices: { where: unknown } } }
    ).select;

    expect(select.prices.where).toEqual({ kind: { notIn: ['TRAINING', 'KIDS'] } });
  });
});
