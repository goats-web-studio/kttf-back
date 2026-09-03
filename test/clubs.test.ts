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

const club = {
  id: CLUB_ID,
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
        city: 'Алматы',
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
        bio: null,
        coachPlayerId: null,
        coachName: null,
        coach: null,
        birthYearOnly: true,
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    user: { findUnique: vi.fn().mockResolvedValue({ id: USER_ID }) },
    $transaction: vi.fn(),
  };

  prisma.$transaction.mockImplementation((run: (tx: typeof prisma) => unknown) => run(prisma));

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
});

describe('состав организаторов ведёт владелец — ТЗ 1', () => {
  it('организатор состав не меняет', async () => {
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'ORGANIZER' });

    const result = await call('POST', `/clubs/${CLUB_ID}/members`, {
      body: { userId: OTHER_ID, role: 'REFEREE' },
      auth: true,
    });

    expect(result.status).toBe(403);
    expect(prisma.clubMember.upsert).not.toHaveBeenCalled();
  });

  it('владелец добавляет', async () => {
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'OWNER' });
    prisma.clubMember.findMany.mockResolvedValue([
      { userId: OTHER_ID, role: 'REFEREE', user: { player: null } },
    ]);

    const result = await call('POST', `/clubs/${CLUB_ID}/members`, {
      body: { userId: OTHER_ID, role: 'REFEREE' },
      auth: true,
    });

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ userId: OTHER_ID, role: 'REFEREE' });
  });

  it('неизвестная роль отвергается схемой', async () => {
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'OWNER' });

    const result = await call('POST', `/clubs/${CLUB_ID}/members`, {
      body: { userId: OTHER_ID, role: 'ADMIN' },
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
      (await call('POST', '/clubs', { body: { name: 'Ракетка', city: 'Алматы' } })).status,
    ).toBe(401);
  });

  it('с токеном — создаётся, вызывающий становится владельцем', async () => {
    const result = await call('POST', '/clubs', {
      body: { name: 'Ракетка', city: 'Алматы' },
      auth: true,
    });

    expect(result.status).toBe(201);
    expect(prisma.clubMember.create).toHaveBeenCalledWith({
      data: { clubId: CLUB_ID, userId: USER_ID, role: 'OWNER' },
    });
  });

  it('без обязательных полей — 400', async () => {
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
        city: 'Алматы',
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
        city: 'Алматы',
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
        city: 'Алматы',
      },
      auth: true,
    });

    expect(result.status).toBe(400);
  });

  it('отчество не обязательно — бриф, запрет №6', async () => {
    const result = await call('POST', '/players', {
      body: {
        lastName: 'Ким',
        firstName: 'Сергей',
        birthYear: 1998,
        gender: 'MALE',
        city: 'Алматы',
      },
      auth: true,
    });

    expect(result.status).toBe(201);
  });
});
