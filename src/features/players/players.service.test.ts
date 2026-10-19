import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { PlacesService } from '../places/places.service.js';
import { isOnline, PlayersService } from './players.service.js';

const player = {
  id: 'player-1',
  userId: null,
  lastName: 'Ким',
  firstName: 'Сергей',
  middleName: null,
  birthYear: 1998,
  gender: 'MALE',
  city: { id: 'city-1', name: 'Алматы', nameKk: null },
  photoUrl: null,
  clubId: 'club-1',
  // Prisma отдаёт Decimal — объект, а не число.
  rating: { toString: () => '250.00' },
  ratedMatches: 0,
  isProvisional: true,
  createdAt: new Date('2026-08-29T00:00:00.000Z'),
  // Анкета ТЗ 2.2 — то, что отдаёт выборка полного профиля.
  birthDate: null,
  playingHand: null,
  grip: null,
  blade: null,
  rubberForehand: null,
  rubberBackhand: null,
  bio: null,
  coachPlayerId: null,
  coachName: null,
  coach: null,
  birthYearOnly: true,
  // Игрок без аккаунта: посещения нет.
  user: null,
};

const newcomer = {
  lastName: 'Ким',
  firstName: 'Сергей',
  birthYear: 1998,
  gender: 'MALE' as const,
  cityId: 'city-1',
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
    city: { findFirst: vi.fn().mockResolvedValue({ id: 'city-1' }) },
    ratingEvent: { groupBy: vi.fn().mockResolvedValue([]) },
  };
}

let prisma: ReturnType<typeof makePrisma>;
let service: PlayersService;

beforeEach(() => {
  prisma = makePrisma();
  const db = prisma as unknown as PrismaService;
  service = new PlayersService(db, new PlacesService(db));
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

describe('в сети и последнее посещение', () => {
  const MINUTE = 60_000;

  it('у игрока без аккаунта статуса нет', async () => {
    await expect(service.findById('player-1')).resolves.toMatchObject({
      lastSeenAt: null,
      online: false,
    });
  });

  it('заходил минуту назад — в сети, отметка отдаётся как есть', async () => {
    const seen = new Date(Date.now() - MINUTE);
    prisma.player.findUnique.mockResolvedValue({
      ...player,
      userId: 'user-1',
      user: { lastSeenAt: seen },
    });

    await expect(service.findById('player-1')).resolves.toMatchObject({
      lastSeenAt: seen.toISOString(),
      online: true,
    });
  });

  it('заходил десять минут назад — не в сети, но дата видна', async () => {
    const seen = new Date(Date.now() - 10 * MINUTE);
    prisma.player.findUnique.mockResolvedValue({
      ...player,
      userId: 'user-1',
      user: { lastSeenAt: seen },
    });

    await expect(service.findById('player-1')).resolves.toMatchObject({
      lastSeenAt: seen.toISOString(),
      online: false,
    });
  });

  it('окно — пять минут, граница уже не в сети', () => {
    const now = new Date('2026-10-19T12:00:00.000Z');
    const ago = (ms: number) => new Date(now.getTime() - ms);

    expect(isOnline(ago(5 * MINUTE - 1), now)).toBe(true);
    expect(isOnline(ago(5 * MINUTE), now)).toBe(false);
    expect(isOnline(null, now)).toBe(false);
    // Часы базы убежали вперёд — человек всё равно только что был.
    expect(isOnline(ago(-MINUTE), now)).toBe(true);
  });
});

describe('список игроков', () => {
  function listWhere(): Record<string, unknown> {
    return (prisma.player.findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;
  }

  it('поиск идёт по фамилии, имени и отчеству', async () => {
    await service.list({ page: 1, limit: 20, search: 'ким' });

    const words = listWhere().AND as { OR: unknown[] }[];
    expect(words).toHaveLength(1);
    expect(words[0]?.OR).toHaveLength(3);
  });

  it('поиск словами в любом порядке: «Ким Артём» — два условия сразу (ADR-054)', async () => {
    await service.list({ page: 1, limit: 20, search: '  Артём   Ким ' });

    const words = listWhere().AND as { OR: { lastName: { contains: string } }[] }[];
    expect(words.map((word) => word.OR[0]?.lastName.contains)).toEqual(['Артём', 'Ким']);
  });

  it('рейтинг «от» и «до» — по числу на экране, со сдвигом на половину (ADR-054)', async () => {
    await service.list({ page: 1, limit: 20, ratingFrom: 300, ratingTo: 384 });

    // «до 384» находит 384.10, «от 300» — 299.50: на экране оба целые.
    expect(listWhere().rating).toEqual({ gte: 299.5, lt: 384.5 });
  });

  it('одна граница рейтинга — без второй', async () => {
    await service.list({ page: 1, limit: 20, ratingTo: 1000 });

    expect(listWhere().rating).toEqual({ lt: 1000.5 });
  });

  it('несколько городов, пол и рука доходят до запроса', async () => {
    await service.list({
      page: 1,
      limit: 20,
      cityId: ['city-1', 'city-2'],
      gender: 'FEMALE',
      playingHand: 'LEFT',
    });

    expect(listWhere()).toMatchObject({
      cityId: { in: ['city-1', 'city-2'] },
      gender: 'FEMALE',
      playingHand: 'LEFT',
    });
  });

  it('без фильтров в запросе нет лишних условий', async () => {
    await service.list({ page: 1, limit: 20 });

    expect(listWhere()).toEqual({});
  });

  it('порядок по рейтингу вверх — по запросу', async () => {
    await service.list({ page: 1, limit: 20, order: 'asc' });

    expect((prisma.player.findMany.mock.calls[0]?.[0] as { orderBy: unknown[] }).orderBy).toEqual([
      { rating: 'asc' },
      { lastName: 'asc' },
    ]);
  });

  it('«обновлён» — последнее событие журнала, одним запросом на страницу', async () => {
    prisma.ratingEvent.groupBy.mockResolvedValue([
      { playerId: 'player-1', _max: { createdAt: new Date('2026-10-19T10:00:00.000Z') } },
    ]);

    const page = await service.list({ page: 1, limit: 20 });

    expect(prisma.ratingEvent.groupBy).toHaveBeenCalledWith({
      by: ['playerId'],
      where: { playerId: { in: ['player-1'] } },
      _max: { createdAt: true },
    });
    expect(page.items[0]?.ratingUpdatedAt).toBe('2026-10-19T10:00:00.000Z');
  });

  it('без событий рейтинга «обновлён» пуст', async () => {
    const page = await service.list({ page: 1, limit: 20 });

    expect(page.items[0]?.ratingUpdatedAt).toBeNull();
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

/**
 * Анкета ТЗ 2.2 — ADR-035.
 *
 * Проверяется то, чего не проверит схема общего кода: связь с тренером
 * и превращение даты в колонку `DATE`.
 */
describe('анкета игрока', () => {
  it('сам себе тренером быть не может', async () => {
    // Ссылка на себя — замкнутая ветка: список учеников включает самого
    // игрока, и всякий обход дерева по нему зациклится.
    await expect(service.update('player-1', { coachPlayerId: 'player-1' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('несуществующий тренер отвергается до записи', async () => {
    prisma.player.findUnique.mockImplementation((args: { where: { id: string } }) =>
      args.where.id === 'player-1' ? player : null,
    );

    await expect(service.update('player-1', { coachPlayerId: 'нет-такого' })).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
    expect(prisma.player.update).not.toHaveBeenCalled();
  });

  it('дата рождения ложится в базу полночью по UTC', async () => {
    // new Date('2001-04-12') в поясе Алматы легла бы одиннадцатым апреля.
    await service.update('player-1', { birthYear: 2001, birthDate: '2001-04-12' });

    const data = (prisma.player.update.mock.calls[0]?.[0] as { data: { birthDate: Date } }).data;

    expect(data.birthDate.toISOString()).toBe('2001-04-12T00:00:00.000Z');
  });

  it('null очищает дату, а не отменяет правку', async () => {
    await service.update('player-1', { birthDate: null });

    const data = (prisma.player.update.mock.calls[0]?.[0] as { data: { birthDate: null } }).data;

    expect(data.birthDate).toBeNull();
  });

  it('имя выбранного тренера подставляется по связи', async () => {
    // Экрану нужно одно поле для показа, а не развилка в каждом месте.
    prisma.player.findUnique.mockResolvedValue({
      ...player,
      coachPlayerId: 'player-9',
      coachName: null,
      coach: { lastName: 'Сериков', firstName: 'Тимур' },
    });

    const view = await service.findById('player-1');

    expect(view.coachName).toBe('Сериков Тимур');
    expect(view.coachPlayerId).toBe('player-9');
  });

  it('вписанный руками тренер отдаётся как есть', async () => {
    prisma.player.findUnique.mockResolvedValue({
      ...player,
      coachPlayerId: null,
      coachName: 'Кто-то со стороны',
      coach: null,
    });

    const view = await service.findById('player-1');

    expect(view.coachName).toBe('Кто-то со стороны');
    expect(view.coachPlayerId).toBeNull();
  });

  it('список тренеров — те, на кого уже сослались', async () => {
    // Роли тренера в продукте ещё нет: список берётся из самих данных.
    await service.list({ page: 1, limit: 20, coachesOnly: true });

    const where = (prisma.player.findMany.mock.calls[0]?.[0] as { where: { students: unknown } })
      .where;

    expect(where.students).toEqual({ some: {} });
  });

  it('анкета не уезжает в списки', async () => {
    // Краткий вид попадает в офлайн-снимок консоли (ТС 6).
    const page = await service.list({ page: 1, limit: 20 });

    expect(page.items[0]).not.toHaveProperty('bio');
    expect(page.items[0]).not.toHaveProperty('blade');
  });
});

/**
 * Приватность даты рождения — ADR-037.
 *
 * Прячет сервер, а не экран: спрятанное только в интерфейсе поле видно
 * всякому, кто открыл сетевую вкладку.
 */
describe('дата рождения посторонним', () => {
  const born = { ...player, birthDate: new Date('2001-04-12T00:00:00.000Z') };

  it('при включённой галочке постороннему даты не видно', async () => {
    prisma.player.findUnique.mockResolvedValue({ ...born, birthYearOnly: true, userId: 'user-1' });

    const view = await service.findById('player-1', 'кто-то-другой');

    expect(view.birthDate).toBeNull();
    // Год остаётся: по нему считаются возрастные категории, и он публичен.
    expect(view.birthYear).toBe(1998);
  });

  it('анониму тоже не видно', async () => {
    prisma.player.findUnique.mockResolvedValue({ ...born, birthYearOnly: true, userId: 'user-1' });

    await expect(service.findById('player-1')).resolves.toMatchObject({ birthDate: null });
  });

  it('сам игрок свою дату видит — иначе правка стёрла бы её', async () => {
    prisma.player.findUnique.mockResolvedValue({ ...born, birthYearOnly: true, userId: 'user-1' });

    await expect(service.findById('player-1', 'user-1')).resolves.toMatchObject({
      birthDate: '2001-04-12',
    });
  });

  it('организатор клуба видит: он же её и вписывал', async () => {
    prisma.player.findUnique.mockResolvedValue({
      ...born,
      birthYearOnly: true,
      userId: null,
      clubId: 'club-1',
    });
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'ORGANIZER' });

    await expect(service.findById('player-1', 'user-2')).resolves.toMatchObject({
      birthDate: '2001-04-12',
    });
  });

  it('при снятой галочке дату видно всем', async () => {
    prisma.player.findUnique.mockResolvedValue({ ...born, birthYearOnly: false, userId: 'user-1' });

    await expect(service.findById('player-1')).resolves.toMatchObject({
      birthDate: '2001-04-12',
    });
  });

  it('скрытая и незаполненная дата выглядят одинаково', async () => {
    // Иначе ответ сообщает постороннему, что дата есть, хотя её прячут.
    prisma.player.findUnique.mockResolvedValue({ ...player, birthYearOnly: true });

    const hidden = await service.findById('player-1');

    prisma.player.findUnique.mockResolvedValue({ ...born, birthYearOnly: true });

    const empty = await service.findById('player-1');

    expect(hidden.birthDate).toBe(empty.birthDate);
  });
});
