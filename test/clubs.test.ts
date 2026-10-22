import { type INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { AuthModule } from '../src/features/auth/auth.module.js';
import { ClubsModule } from '../src/features/clubs/clubs.module.js';
import { PlayersModule } from '../src/features/players/players.module.js';
import { ConfigModule } from '../src/infra/config/config.module.js';
import { ENV, type Env } from '../src/infra/config/env.js';
import { PrismaModule } from '../src/infra/prisma/prisma.module.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';

/**
 * Права доступа к клубам и игрокам через настоящее приложение.
 *
 * Юнит-тесты сервисов проверяют само правило. Здесь проверяется, что правило
 * вообще применяется: забытый декоратор на маршруте молча открывает его всем,
 * и ни один тест сервиса этого не увидит.
 */
const env: Env = {
  NODE_ENV: 'test',
  PORT: 0,
  DATABASE_URL: 'postgresql://x',
  JWT_SECRET: 'test_secret_at_least_32_characters_long',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'kttf-media',
  S3_REGION: 'us-east-1',
};

const CLUB_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';
const CITY_ID = '55555555-5555-4555-8555-555555555555';
const TABLE_ID = '66666666-6666-4666-8666-666666666666';

const club = {
  id: CLUB_ID,
  name: 'Ракетка',
  shortName: null,
  city: { id: CITY_ID, name: 'Алматы', nameKk: null },
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
    tournament: { groupBy: vi.fn().mockResolvedValue([]) },
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
      count: vi.fn().mockResolvedValue(2),
      create: vi.fn().mockResolvedValue({}),
      upsert: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    player: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        id: '44444444-4444-4444-8444-444444444444',
        userId: USER_ID,
        lastName: 'Ким',
        firstName: 'Сергей',
        middleName: null,
        birthYear: 1998,
        gender: 'MALE',
        city: { id: CITY_ID, name: 'Алматы', nameKk: null },
        photoUrl: null,
        clubId: null,
        rating: { toString: () => '250.00' },
        ratedMatches: 0,
        isProvisional: true,
        createdAt: new Date('2026-08-29T00:00:00.000Z'),
        // Анкета ТЗ 2.2: выборка полного профиля отдаёт её всегда.
        birthDate: null,
        playingHand: null,
        grip: null,
        blade: null,
        rubberForehand: null,
        rubberBackhand: null,
        bladeProduct: null,
        rubberForehandProduct: null,
        rubberBackhandProduct: null,
        bio: null,
        coachPlayerId: null,
        coachName: null,
        coach: null,
        birthYearOnly: true,
        coachTenures: [],
        // Своя страница тренера — профиль v3 (ADR-060). Без неё выборка не
        // та, что у сервиса, и создание падало с 500.
        coachPage: null,
      }),
      update: vi.fn().mockResolvedValue({}),
      // Профиль после записи перечитывается целиком — тот же, что заведён.
      findUniqueOrThrow: vi.fn(),
    },
    coachTenure: { create: vi.fn(), updateMany: vi.fn() },
    ratingEvent: { create: vi.fn().mockResolvedValue({}) },
    clubCoach: { groupBy: vi.fn().mockResolvedValue([]) },
    training: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findUnique: vi.fn().mockResolvedValue({ id: USER_ID }) },
    city: { findFirst: vi.fn().mockResolvedValue({ id: CITY_ID }) },
    product: { findMany: vi.fn().mockResolvedValue([{ id: TABLE_ID }]) },
    clubTable: { deleteMany: vi.fn(), createMany: vi.fn() },
    $transaction: vi.fn(),
  };

  prisma.$transaction.mockImplementation((run: (tx: typeof prisma) => unknown) => run(prisma));
  prisma.player.findUniqueOrThrow.mockImplementation(
    () => prisma.player.create.mock.results.at(-1)?.value as unknown,
  );

  return prisma;
}

let app: INestApplication | undefined;
let prisma: ReturnType<typeof makePrisma>;
let root: string;
let token: string;

beforeEach(async () => {
  prisma = makePrisma();

  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule, PrismaModule, AuthModule, ClubsModule, PlayersModule],
  })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.listen(0);
  root = `${await app.getUrl()}/api/v1`;
  token = new JwtService({ secret: env.JWT_SECRET }).sign({ sub: USER_ID }, { expiresIn: 600 });
});

afterEach(async () => {
  await app?.close();
  vi.restoreAllMocks();
});

async function call(
  method: string,
  path: string,
  options: { body?: unknown; auth?: boolean } = {},
) {
  const response = await fetch(`${root}${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.auth === true ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
  };
}

describe('публичная часть — ТЗ 3.2', () => {
  it('список клубов доступен без токена', async () => {
    const result = await call('GET', '/clubs');

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ total: 1, page: 1, limit: 20 });
  });

  it('карточка клуба доступна без токена', async () => {
    expect((await call('GET', `/clubs/${CLUB_ID}`)).status).toBe(200);
  });

  it('состав клуба доступен без токена', async () => {
    expect((await call('GET', `/clubs/${CLUB_ID}/members`)).status).toBe(200);
  });

  it('список игроков доступен без токена', async () => {
    expect((await call('GET', '/players')).status).toBe(200);
  });

  it('несуществующий клуб — 404 в формате ТС 7.8', async () => {
    prisma.club.findUnique.mockResolvedValue(null);

    const result = await call('GET', `/clubs/${CLUB_ID}`);

    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('идентификатор не в формате UUID — 400, до базы не доходит', async () => {
    const result = await call('GET', '/clubs/не-uuid');

    expect(result.status).toBe(400);
    expect(prisma.club.findUnique).not.toHaveBeenCalled();
  });

  it('запрос страницы сверх потолка отвергается', async () => {
    // Иначе публичный список — способ положить базу одним запросом.
    expect((await call('GET', '/clubs?limit=100000')).status).toBe(400);
  });
});

describe('изменение клуба', () => {
  it('без токена — 401', async () => {
    const result = await call('PATCH', `/clubs/${CLUB_ID}`, { body: { name: 'Другое' } });

    expect(result.status).toBe(401);
    expect(prisma.club.update).not.toHaveBeenCalled();
  });

  it('с токеном, но без роли в клубе — 403', async () => {
    const result = await call('PATCH', `/clubs/${CLUB_ID}`, {
      body: { name: 'Другое' },
      auth: true,
    });

    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(prisma.club.update).not.toHaveBeenCalled();
  });

  it('судье клуба тоже нельзя — ТЗ 1 не даёт ему управление клубом', async () => {
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'REFEREE' });

    expect(
      (await call('PATCH', `/clubs/${CLUB_ID}`, { body: { name: 'Другое' }, auth: true })).status,
    ).toBe(403);
  });

  it('организатору — можно', async () => {
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'ORGANIZER' });

    expect(
      (await call('PATCH', `/clubs/${CLUB_ID}`, { body: { name: 'Другое' }, auth: true })).status,
    ).toBe(200);
  });

  it('пустое тело отвергается', async () => {
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'OWNER' });

    expect((await call('PATCH', `/clubs/${CLUB_ID}`, { body: {}, auth: true })).status).toBe(400);
  });

  it('null стирает необязательное поле — ADR-043', async () => {
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'OWNER' });

    const result = await call('PATCH', `/clubs/${CLUB_ID}`, {
      body: { phone: null },
      auth: true,
    });

    expect(result.status).toBe(200);
    expect(prisma.club.update.mock.calls[0]?.[0]).toMatchObject({ data: { phone: null } });
  });

  it('название стереть нельзя', async () => {
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'OWNER' });

    expect(
      (await call('PATCH', `/clubs/${CLUB_ID}`, { body: { name: null }, auth: true })).status,
    ).toBe(400);
  });
});

describe('столы клуба — ADR-058', () => {
  const body = { tables: [{ productId: TABLE_ID, count: 8 }] };

  it('без токена — 401, без роли — 403', async () => {
    expect((await call('PUT', `/clubs/${CLUB_ID}/tables`, { body })).status).toBe(401);
    expect((await call('PUT', `/clubs/${CLUB_ID}/tables`, { body, auth: true })).status).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('организатору — можно, список заменяется', async () => {
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'ORGANIZER' });
    prisma.$transaction.mockResolvedValue([{}, {}, club]);

    expect((await call('PUT', `/clubs/${CLUB_ID}/tables`, { body, auth: true })).status).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });

  it('повтор модели и ноль столов отвергаются схемой', async () => {
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'OWNER' });

    const repeated = { tables: [body.tables[0], body.tables[0]] };
    expect(
      (await call('PUT', `/clubs/${CLUB_ID}/tables`, { body: repeated, auth: true })).status,
    ).toBe(400);
    expect(
      (
        await call('PUT', `/clubs/${CLUB_ID}/tables`, {
          body: { tables: [{ productId: TABLE_ID, count: 0 }] },
          auth: true,
        })
      ).status,
    ).toBe(400);
  });

  it('«Где стоит» — фильтр списка клубов', async () => {
    await call('GET', `/clubs?tableProductId=${TABLE_ID}`);

    expect(prisma.club.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { tables: { some: { productId: TABLE_ID } } },
    });
  });
});

describe('состав организаторов ведёт владелец — ТЗ 1', () => {
  it('организатор состав не меняет', async () => {
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'ORGANIZER' });

    const result = await call('POST', `/clubs/${CLUB_ID}/members`, {
      body: { identifier: 'organizer', role: 'REFEREE' },
      auth: true,
    });

    expect(result.status).toBe(403);
    expect(prisma.clubMember.upsert).not.toHaveBeenCalled();
  });

  it('владелец добавляет по логину', async () => {
    // Первый запрос состава — права вызывающего, второй — нынешняя роль
    // добавляемого: в клубе его ещё нет.
    prisma.clubMember.findUnique
      .mockResolvedValueOnce({ role: 'OWNER' })
      .mockResolvedValueOnce(null);
    prisma.user.findUnique.mockResolvedValue({ id: OTHER_ID });
    prisma.clubMember.findMany.mockResolvedValue([
      { userId: OTHER_ID, role: 'REFEREE', user: { player: null } },
    ]);

    const result = await call('POST', `/clubs/${CLUB_ID}/members`, {
      body: { identifier: 'organizer', role: 'REFEREE' },
      auth: true,
    });

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ userId: OTHER_ID, role: 'REFEREE' });
  });

  it('неизвестная роль отвергается схемой', async () => {
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'OWNER' });

    const result = await call('POST', `/clubs/${CLUB_ID}/members`, {
      body: { identifier: 'organizer', role: 'ADMIN' },
      auth: true,
    });

    expect(result.status).toBe(400);
  });

  it('исключение отвечает 204', async () => {
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'OWNER' });

    expect(
      (await call('DELETE', `/clubs/${CLUB_ID}/members/${OTHER_ID}`, { auth: true })).status,
    ).toBe(204);
  });
});

describe('создание клуба', () => {
  it('без токена — 401', async () => {
    expect(
      (await call('POST', '/clubs', { body: { name: 'Ракетка', cityId: CITY_ID } })).status,
    ).toBe(401);
  });

  it('не администратору — 403: клуб заводится по заявке (ADR-049)', async () => {
    const result = await call('POST', '/clubs', {
      body: { name: 'Ракетка', cityId: CITY_ID },
      auth: true,
    });

    expect(result.status).toBe(403);
    expect(prisma.clubMember.create).not.toHaveBeenCalled();
  });

  it('администратору — создаётся, он становится владельцем', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID, isAdmin: true });

    const result = await call('POST', '/clubs', {
      body: { name: 'Ракетка', cityId: CITY_ID },
      auth: true,
    });

    expect(result.status).toBe(201);
    expect(prisma.clubMember.create).toHaveBeenCalledWith({
      data: { clubId: CLUB_ID, userId: USER_ID, role: 'OWNER' },
    });
  });

  it('без обязательных полей — 400', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID, isAdmin: true });

    expect((await call('POST', '/clubs', { body: { name: 'Ракетка' }, auth: true })).status).toBe(
      400,
    );
  });
});

describe('создание игрока', () => {
  it('без токена — 401', async () => {
    const result = await call('POST', '/players', {
      body: {
        lastName: 'Ким',
        firstName: 'Сергей',
        birthYear: 1998,
        gender: 'MALE',
        cityId: CITY_ID,
      },
    });

    expect(result.status).toBe(401);
  });

  it('первый профиль вошедшего создаётся и привязывается к нему', async () => {
    const result = await call('POST', '/players', {
      body: {
        lastName: 'Ким',
        firstName: 'Сергей',
        birthYear: 1998,
        gender: 'MALE',
        cityId: CITY_ID,
      },
      auth: true,
    });

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ userId: USER_ID, rating: '250.00' });
  });

  it('год рождения из будущего отвергается', async () => {
    const result = await call('POST', '/players', {
      body: {
        lastName: 'Ким',
        firstName: 'Сергей',
        birthYear: 3000,
        gender: 'MALE',
        cityId: CITY_ID,
      },
      auth: true,
    });

    expect(result.status).toBe(400);
  });

  describe('стартовый рейтинг от организатора — ADR-062', () => {
    const newcomer = {
      lastName: 'Ахметов',
      firstName: 'Арман',
      birthYear: 1990,
      gender: 'MALE',
      cityId: CITY_ID,
      clubId: CLUB_ID,
      startRating: 400,
    };

    it('ложится в проекцию и в журнал событием INITIAL от 250', async () => {
      prisma.clubMember.findUnique.mockResolvedValue({ role: 'ORGANIZER' });

      const result = await call('POST', '/players', { body: newcomer, auth: true });

      expect(result.status).toBe(201);
      const data = (prisma.player.create.mock.calls[0]?.[0] as { data: Record<string, unknown> })
        .data;
      expect(String(data.rating)).toBe('400');
      expect(data).not.toHaveProperty('startRating');
      expect(data).not.toHaveProperty('userId');
      expect(prisma.ratingEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: 'INITIAL',
          ratingBefore: 250,
          delta: 150,
          ratingAfter: 400,
        }) as unknown,
      });
    });

    it('даже у организатора без своего профиля игрок не становится им самим', async () => {
      // Раньше первый заведённый профиль привязывался к заводящему.
      prisma.clubMember.findUnique.mockResolvedValue({ role: 'OWNER' });
      prisma.player.findUnique.mockResolvedValue(null);

      await call('POST', '/players', { body: newcomer, auth: true });

      const data = (prisma.player.create.mock.calls[0]?.[0] as { data: Record<string, unknown> })
        .data;
      expect(data).not.toHaveProperty('userId');
    });

    it('без клуба или без права в клубе — отказ', async () => {
      const homeless = Object.fromEntries(
        Object.entries(newcomer).filter(([key]) => key !== 'clubId'),
      );

      expect((await call('POST', '/players', { body: homeless, auth: true })).status).toBe(403);
      expect((await call('POST', '/players', { body: newcomer, auth: true })).status).toBe(403);
      expect(prisma.player.create).not.toHaveBeenCalled();
    });

    it('не кратный 25 отвергается схемой', async () => {
      const result = await call('POST', '/players', {
        body: { ...newcomer, startRating: 410 },
        auth: true,
      });

      expect(result.status).toBe(400);
    });
  });

  it('отчество не обязательно — бриф, запрет №6', async () => {
    const result = await call('POST', '/players', {
      body: {
        lastName: 'Ким',
        firstName: 'Сергей',
        birthYear: 1998,
        gender: 'MALE',
        cityId: CITY_ID,
      },
      auth: true,
    });

    expect(result.status).toBe(201);
  });
});
