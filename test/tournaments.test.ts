import { type INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { AuthModule } from '../src/features/auth/auth.module.js';
import { TournamentsModule } from '../src/features/tournaments/tournaments.module.js';
import { ConfigModule } from '../src/infra/config/config.module.js';
import { ENV, type Env } from '../src/infra/config/env.js';
import { PrismaModule } from '../src/infra/prisma/prisma.module.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';

/**
 * Турниры через настоящее приложение — ТС 7.5.
 *
 * Юнит-тесты проверяют переходы и допуск сами по себе. Здесь проверяется, что
 * правила вообще применяются: забытый декоратор на маршруте молча открывает
 * его всем, и ни один тест сервиса этого не заметит.
 */
const env: Env = {
  NODE_ENV: 'test',
  PORT: 0,
  DATABASE_URL: 'postgresql://x',
  JWT_SECRET: 'test_secret_at_least_32_characters_long',
  AUTH_CODE_SECRET: 'code_secret_at_least_32_characters!!',
};

const CLUB_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const TOURNAMENT_ID = '33333333-3333-4333-8333-333333333333';
const PLAYER_ID = '44444444-4444-4444-8444-444444444444';
const REGISTRATION_ID = '55555555-5555-4555-8555-555555555555';

const FAR_FUTURE = new Date('2030-01-01T10:00:00.000Z');

const player = {
  id: PLAYER_ID,
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
};

function makeTournament(overrides: Record<string, unknown> = {}) {
  return {
    id: TOURNAMENT_ID,
    clubId: CLUB_ID,
    name: 'Кубок клуба',
    startsAt: FAR_FUTURE,
    registrationEndsAt: null,
    status: 'REG_OPEN',
    entryFee: 2000,
    maxParticipants: null,
    ratingCapMax: null,
    ratingCapMin: null,
    birthYearFrom: null,
    birthYearTo: null,
    genderLimit: null,
    level: 'CLUB',
    tableCount: 6,
    formatConfig: { type: 'ROUND_ROBIN', rounds: 1, setsToWin: 3 },
    seedingConfig: null,
    description: null,
    prizeInfo: null,
    publicToken: 'token'.padEnd(32, 'x'),
    createdAt: new Date('2026-08-29T00:00:00.000Z'),
    startedAt: null,
    finishedAt: null,
    _count: { registrations: 0 },
    ...overrides,
  };
}

const registration = {
  id: REGISTRATION_ID,
  tournamentId: TOURNAMENT_ID,
  status: 'CONFIRMED',
  isRated: true,
  seed: null,
  ratingAtStart: null,
  matchesAtStart: null,
  createdAt: new Date('2026-08-29T00:00:00.000Z'),
  player,
};

function makePrisma() {
  const prisma = {
    tournament: {
      findMany: vi.fn().mockResolvedValue([makeTournament()]),
      count: vi.fn().mockResolvedValue(1),
      findUnique: vi.fn().mockResolvedValue(makeTournament()),
      create: vi.fn().mockResolvedValue(makeTournament()),
      update: vi.fn().mockResolvedValue(makeTournament()),
      delete: vi.fn().mockResolvedValue({}),
    },
    registration: {
      findMany: vi.fn().mockResolvedValue([registration]),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue(registration),
      update: vi.fn().mockResolvedValue(registration),
      delete: vi.fn().mockResolvedValue({}),
    },
    player: { findUnique: vi.fn().mockResolvedValue(player) },
    clubMember: {
      findUnique: vi.fn().mockResolvedValue({ role: 'OWNER' }),
      findMany: vi.fn().mockResolvedValue([{ clubId: CLUB_ID }]),
    },
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
    imports: [ConfigModule, PrismaModule, AuthModule, TournamentsModule],
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
    body: response.status === 204 ? null : ((await response.json()) as Record<string, unknown>),
  };
}

/** Статус, с которым создана запись. Читается из аргумента вместо матчера. */
function createdStatus(): unknown {
  const call = prisma.registration.create.mock.calls[0]?.[0] as
    { data?: { status?: unknown } } | undefined;

  return call?.data?.status;
}

describe('календарь — ТЗ 9.2', () => {
  it('список открыт без токена', async () => {
    const result = await call('GET', '/tournaments');

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ total: 1, page: 1, limit: 20 });
  });

  it('карточка открыта без токена', async () => {
    expect((await call('GET', `/tournaments/${TOURNAMENT_ID}`)).status).toBe(200);
  });

  it('состав участников открыт без токена', async () => {
    expect((await call('GET', `/tournaments/${TOURNAMENT_ID}/registrations`)).status).toBe(200);
  });

  it('черновик анонимному не показывается', async () => {
    // И тем же отказом, что несуществующий: иначе перебором идентификаторов
    // узнаётся, какие черновики существуют.
    prisma.tournament.findUnique.mockResolvedValue(makeTournament({ status: 'DRAFT' }));

    const result = await call('GET', `/tournaments/${TOURNAMENT_ID}`);

    expect(result.status).toBe(404);
  });

  it('черновик виден тому, кто управляет клубом', async () => {
    prisma.tournament.findUnique.mockResolvedValue(makeTournament({ status: 'DRAFT' }));

    expect((await call('GET', `/tournaments/${TOURNAMENT_ID}`, { auth: true })).status).toBe(200);
  });
});

describe('права — продолжение ADR-014', () => {
  it('без токена турнир не создать', async () => {
    expect((await call('POST', '/tournaments', { body: {} })).status).toBe(401);
  });

  it('посторонний не создаёт турнир в чужом клубе', async () => {
    prisma.clubMember.findUnique.mockResolvedValue(null);

    const result = await call('POST', '/tournaments', {
      auth: true,
      body: {
        clubId: CLUB_ID,
        name: 'Кубок',
        startsAt: FAR_FUTURE.toISOString(),
        entryFee: 0,
        level: 'CLUB',
        tableCount: 4,
        formatConfig: { type: 'ROUND_ROBIN', rounds: 1, setsToWin: 3 },
      },
    });

    expect(result.status).toBe(403);
  });

  it('судья турниром не управляет', async () => {
    // По ТЗ 1 его доступ — консоль конкретного турнира, а не управление.
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'REFEREE' });

    expect(
      (await call('POST', `/tournaments/${TOURNAMENT_ID}/publish`, { auth: true })).status,
    ).toBe(403);
  });

  it('организатор клуба публикует турнир', async () => {
    prisma.tournament.findUnique.mockResolvedValue(makeTournament({ status: 'DRAFT' }));
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'ORGANIZER' });

    expect(
      (await call('POST', `/tournaments/${TOURNAMENT_ID}/publish`, { auth: true })).status,
    ).toBe(201);
  });
});

describe('жизненный цикл — ТЗ 4.1', () => {
  it('запрещённый переход отвергается с кодом из общего кода', async () => {
    prisma.tournament.findUnique.mockResolvedValue(makeTournament({ status: 'RATED' }));

    const result = await call('POST', `/tournaments/${TOURNAMENT_ID}/cancel`, { auth: true });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('опубликованный турнир удалить нельзя — только отменить', async () => {
    const result = await call('DELETE', `/tournaments/${TOURNAMENT_ID}`, { auth: true });

    expect(result.status).toBe(403);
    expect(prisma.tournament.delete).not.toHaveBeenCalled();
  });

  it('черновик удаляется', async () => {
    prisma.tournament.findUnique.mockResolvedValue(makeTournament({ status: 'DRAFT' }));

    expect((await call('DELETE', `/tournaments/${TOURNAMENT_ID}`, { auth: true })).status).toBe(
      204,
    );
  });

  it('начатый турнир не правится', async () => {
    prisma.tournament.findUnique.mockResolvedValue(
      makeTournament({ status: 'RUNNING', startedAt: new Date('2026-08-30T10:00:00.000Z') }),
    );

    const result = await call('PATCH', `/tournaments/${TOURNAMENT_ID}`, {
      auth: true,
      body: { name: 'Другое' },
    });

    expect(result.status).toBe(403);
  });
});

describe('регистрация — ТЗ 4.3', () => {
  it('игрок записывает себя без указания игрока', async () => {
    const result = await call('POST', `/tournaments/${TOURNAMENT_ID}/registrations`, {
      auth: true,
      body: {},
    });

    expect(result.status).toBe(201);
    // Взнос ещё не собирается, поэтому из определения ТЗ 4.4 работает только
    // «допущен» — участник сразу подтверждён (ADR-018).
    expect(createdStatus()).toBe('CONFIRMED');
  });

  it('пока регистрация не открыта, записаться нельзя', async () => {
    prisma.tournament.findUnique.mockResolvedValue(makeTournament({ status: 'PUBLISHED' }));

    const result = await call('POST', `/tournaments/${TOURNAMENT_ID}/registrations`, {
      auth: true,
      body: {},
    });

    expect(result.status).toBe(400);
  });

  it('после дедлайна записаться нельзя', async () => {
    prisma.tournament.findUnique.mockResolvedValue(
      makeTournament({ registrationEndsAt: new Date('2020-01-01T00:00:00.000Z') }),
    );

    const result = await call('POST', `/tournaments/${TOURNAMENT_ID}/registrations`, {
      auth: true,
      body: {},
    });

    expect(result.status).toBe(400);
  });

  it('не прошедший по планке получает все причины сразу', async () => {
    prisma.tournament.findUnique.mockResolvedValue(
      makeTournament({ ratingCapMax: 200, genderLimit: 'FEMALE' }),
    );

    const result = await call('POST', `/tournaments/${TOURNAMENT_ID}/registrations`, {
      auth: true,
      body: {},
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: {
        code: 'VALIDATION_FAILED',
        details: { problems: ['RATING_TOO_HIGH', 'GENDER_NOT_ALLOWED'] },
      },
    });
  });

  it('при достигнутом лимите запись уходит в лист ожидания', async () => {
    prisma.tournament.findUnique.mockResolvedValue(makeTournament({ maxParticipants: 8 }));
    prisma.registration.count.mockResolvedValue(8);

    await call('POST', `/tournaments/${TOURNAMENT_ID}/registrations`, { auth: true, body: {} });

    expect(createdStatus()).toBe('WAITLIST');
  });

  it('повторная запись отвергается', async () => {
    prisma.registration.findUnique.mockResolvedValue({ id: REGISTRATION_ID });

    const result = await call('POST', `/tournaments/${TOURNAMENT_ID}/registrations`, {
      auth: true,
      body: {},
    });

    expect(result.status).toBe(400);
  });

  it('чужого игрока записывает только организатор клуба', async () => {
    prisma.player.findUnique.mockResolvedValue({ ...player, userId: null });
    prisma.clubMember.findUnique.mockResolvedValue(null);

    const result = await call('POST', `/tournaments/${TOURNAMENT_ID}/registrations`, {
      auth: true,
      body: { playerId: PLAYER_ID },
    });

    expect(result.status).toBe(403);
  });
});

describe('лист ожидания', () => {
  it('освободившееся место занимает первый в очереди', async () => {
    prisma.tournament.findUnique.mockResolvedValue(makeTournament({ maxParticipants: 8 }));
    prisma.registration.findUnique.mockResolvedValue({
      id: REGISTRATION_ID,
      tournamentId: TOURNAMENT_ID,
      status: 'CONFIRMED',
      playerId: PLAYER_ID,
    });
    prisma.registration.count.mockResolvedValue(7);
    prisma.registration.findFirst.mockResolvedValue({ id: 'next-in-line' });

    const result = await call(
      'DELETE',
      `/tournaments/${TOURNAMENT_ID}/registrations/${REGISTRATION_ID}`,
      { auth: true },
    );

    expect(result.status).toBe(204);
    // Очередь по времени записи: иначе организатору пришлось бы следить за
    // ней руками ровно тогда, когда он занят турниром.
    expect(prisma.registration.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'asc' } }),
    );
    expect(prisma.registration.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'CONFIRMED' } }),
    );
  });

  it('после старта участника снимают, а не удаляют', async () => {
    // Он уже в сетке: исчезновение записи поменяло бы сыгранные встречи.
    prisma.tournament.findUnique.mockResolvedValue(
      makeTournament({ status: 'RUNNING', startedAt: new Date('2026-08-30T10:00:00.000Z') }),
    );
    prisma.registration.findUnique.mockResolvedValue({
      id: REGISTRATION_ID,
      tournamentId: TOURNAMENT_ID,
      status: 'PLAYING',
      playerId: PLAYER_ID,
    });

    const result = await call(
      'DELETE',
      `/tournaments/${TOURNAMENT_ID}/registrations/${REGISTRATION_ID}`,
      { auth: true },
    );

    expect(result.status).toBe(403);
    expect(prisma.registration.delete).not.toHaveBeenCalled();
  });
});
