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
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'kttf-media',
  S3_REGION: 'us-east-1',
};

const CLUB_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const TOURNAMENT_ID = '33333333-3333-4333-8333-333333333333';
const PLAYER_ID = '44444444-4444-4444-8444-444444444444';
const REGISTRATION_ID = '55555555-5555-4555-8555-555555555555';
const STAGE_ID = '66666666-6666-4666-8666-666666666666';
const GROUP_ID = '77777777-7777-4777-8777-777777777777';

const FAR_FUTURE = new Date('2030-01-01T10:00:00.000Z');

const player = {
  id: PLAYER_ID,
  userId: USER_ID,
  lastName: 'Ким',
  firstName: 'Сергей',
  middleName: null,
  birthYear: 1998,
  gender: 'MALE',
  city: { id: '55555555-5555-4555-8555-555555555555', name: 'Алматы', nameKk: null },
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
    reviewOutOfRating: false,
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
    ratedAt: null,
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
  coachPlayerId: null,
  coachName: null,
  coachPlayer: null,
};

function makePrisma() {
  const prisma = {
    tournament: {
      findMany: vi.fn().mockResolvedValue([makeTournament()]),
      count: vi.fn().mockResolvedValue(1),
      findUnique: vi.fn().mockResolvedValue(makeTournament()),
      findUniqueOrThrow: vi.fn().mockResolvedValue(makeTournament({ status: 'RATED' })),
      create: vi.fn().mockResolvedValue(makeTournament()),
      update: vi.fn().mockResolvedValue(makeTournament()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
    player: {
      findUnique: vi.fn().mockResolvedValue(player),
      update: vi.fn().mockResolvedValue(player),
    },
    ratingEvent: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    stage: {
      deleteMany: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({ id: STAGE_ID }),
      count: vi.fn().mockResolvedValue(1),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    group: {
      create: vi.fn().mockResolvedValue({ id: GROUP_ID }),
      findUnique: vi.fn().mockResolvedValue({
        id: GROUP_ID,
        stage: { tournamentId: TOURNAMENT_ID },
      }),
    },
    tieDecision: { create: vi.fn().mockResolvedValue({}) },
    match: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    clubMember: {
      findUnique: vi.fn().mockResolvedValue({ role: 'OWNER' }),
      findMany: vi.fn().mockResolvedValue([{ clubId: CLUB_ID }]),
    },
    $transaction: vi.fn(),
  };

  // Обе формы транзакции: функцией (рейтинг) и списком запросов (места).
  prisma.$transaction.mockImplementation((run: unknown) =>
    Array.isArray(run) ? Promise.all(run) : (run as (tx: typeof prisma) => unknown)(prisma),
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

  it('«Мои турниры» — только где заявка игрока жива (ADR-048)', async () => {
    const result = await call('GET', `/tournaments?playerId=${PLAYER_ID}`);

    expect(result.status).toBe(200);
    expect(JSON.stringify(prisma.tournament.findMany.mock.calls[0]?.[0])).toContain(
      JSON.stringify({
        registrations: {
          some: {
            playerId: PLAYER_ID,
            status: { in: ['REGISTERED', 'PENDING', 'WAITLIST', 'CONFIRMED', 'PLAYING'] },
          },
        },
      }),
    );
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

describe('заявки вне рейтинга — ADR-044', () => {
  /** Статус, с которым запись правится. Читается из аргумента вместо матчера. */
  function updatedStatus(): unknown {
    const call = prisma.registration.update.mock.calls[0]?.[0] as
      { data?: { status?: unknown } } | undefined;

    return call?.data?.status;
  }

  function pendingApplication(status = 'PENDING') {
    prisma.registration.findUnique.mockResolvedValue({
      id: REGISTRATION_ID,
      status,
      playerId: PLAYER_ID,
      tournamentId: TOURNAMENT_ID,
    });
  }

  it('с галочкой игрок вне планки подаёт заявку, а не получает отказ', async () => {
    prisma.tournament.findUnique.mockResolvedValue(
      makeTournament({ ratingCapMax: 200, reviewOutOfRating: true }),
    );

    const result = await call('POST', `/tournaments/${TOURNAMENT_ID}/registrations`, {
      auth: true,
      body: {},
    });

    expect(result.status).toBe(201);
    expect(createdStatus()).toBe('PENDING');
  });

  it('возраст и пол галочкой не переступить', async () => {
    prisma.tournament.findUnique.mockResolvedValue(
      makeTournament({ ratingCapMax: 200, genderLimit: 'FEMALE', reviewOutOfRating: true }),
    );

    const result = await call('POST', `/tournaments/${TOURNAMENT_ID}/registrations`, {
      auth: true,
      body: {},
    });

    expect(result.status).toBe(400);
    expect(prisma.registration.create).not.toHaveBeenCalled();
  });

  it('организатор, записывающий игрока вне планки, решение уже принял', async () => {
    prisma.tournament.findUnique.mockResolvedValue(
      makeTournament({ ratingCapMax: 200, reviewOutOfRating: true }),
    );
    prisma.player.findUnique.mockResolvedValue({ ...player, userId: null });

    const result = await call('POST', `/tournaments/${TOURNAMENT_ID}/registrations`, {
      auth: true,
      body: { playerId: PLAYER_ID },
    });

    expect(result.status).toBe(201);
    expect(createdStatus()).toBe('CONFIRMED');
  });

  it('принятая заявка становится участником', async () => {
    pendingApplication();

    const result = await call(
      'PATCH',
      `/tournaments/${TOURNAMENT_ID}/registrations/${REGISTRATION_ID}`,
      { auth: true, body: { status: 'CONFIRMED' } },
    );

    expect(result.status).toBe(200);
    expect(updatedStatus()).toBe('CONFIRMED');
  });

  it('принятая при полном составе встаёт в лист ожидания, а не отвергается', async () => {
    prisma.tournament.findUnique.mockResolvedValue(makeTournament({ maxParticipants: 8 }));
    prisma.registration.count.mockResolvedValue(8);
    pendingApplication();

    await call('PATCH', `/tournaments/${TOURNAMENT_ID}/registrations/${REGISTRATION_ID}`, {
      auth: true,
      body: { status: 'CONFIRMED' },
    });

    expect(updatedStatus()).toBe('WAITLIST');
  });

  it('отклоняют только заявку: участника снимают, а не отклоняют', async () => {
    pendingApplication('CONFIRMED');

    const result = await call(
      'PATCH',
      `/tournaments/${TOURNAMENT_ID}/registrations/${REGISTRATION_ID}`,
      { auth: true, body: { status: 'REJECTED' } },
    );

    expect(result.status).toBe(400);
    expect(prisma.registration.update).not.toHaveBeenCalled();
  });

  it('после старта заявку не принять: в сетке ей места нет', async () => {
    prisma.tournament.findUnique.mockResolvedValue(
      makeTournament({ status: 'RUNNING', startedAt: new Date('2026-08-30T10:00:00.000Z') }),
    );
    pendingApplication();

    const result = await call(
      'PATCH',
      `/tournaments/${TOURNAMENT_ID}/registrations/${REGISTRATION_ID}`,
      { auth: true, body: { status: 'CONFIRMED' } },
    );

    expect(result.status).toBe(400);
  });
});

describe('правка турнира до старта — ADR-044', () => {
  function updateData(): Record<string, unknown> | undefined {
    const call = prisma.tournament.update.mock.calls[0]?.[0] as
      { data?: Record<string, unknown> } | undefined;

    return call?.data;
  }

  it('стёртая планка уходит в базу пустой', async () => {
    prisma.tournament.findUnique.mockResolvedValue(makeTournament({ ratingCapMax: 400 }));

    const result = await call('PATCH', `/tournaments/${TOURNAMENT_ID}`, {
      auth: true,
      body: { ratingCapMax: null, registrationEndsAt: null },
    });

    expect(result.status).toBe(200);
    expect(updateData()).toMatchObject({ ratingCapMax: null, registrationEndsAt: null });
  });

  it('смена схемы сбрасывает жеребьёвку: сетка по старой схеме не годится', async () => {
    prisma.tournament.findUnique.mockResolvedValue(makeTournament({ status: 'REG_CLOSED' }));

    await call('PATCH', `/tournaments/${TOURNAMENT_ID}`, {
      auth: true,
      body: { formatConfig: { type: 'ROUND_ROBIN', rounds: 2, setsToWin: 3 } },
    });

    expect(prisma.stage.deleteMany).toHaveBeenCalledOnce();
  });

  it('правка названия жеребьёвку не трогает', async () => {
    await call('PATCH', `/tournaments/${TOURNAMENT_ID}`, {
      auth: true,
      body: { name: 'Кубок осени' },
    });

    expect(prisma.stage.deleteMany).not.toHaveBeenCalled();
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

describe('снятие по ходу турнира — ADR-061', () => {
  const running = (): ReturnType<typeof makeTournament> =>
    makeTournament({
      status: 'RUNNING',
      startedAt: new Date('2026-08-30T10:00:00.000Z'),
      maxParticipants: 8,
    });

  function entry(status: string) {
    return { id: REGISTRATION_ID, tournamentId: TOURNAMENT_ID, status, playerId: PLAYER_ID };
  }

  it('снятие после старта не поднимает игрока из листа ожидания', async () => {
    // Раньше поднимало: посреди турнира появлялся «подтверждённый» участник,
    // которого нет ни в одной встрече.
    prisma.tournament.findUnique.mockResolvedValue(running());
    prisma.registration.findUnique.mockResolvedValue(entry('PLAYING'));
    prisma.registration.count.mockResolvedValue(7);
    prisma.registration.findFirst.mockResolvedValue({ id: 'next-in-line' });

    const result = await call(
      'PATCH',
      `/tournaments/${TOURNAMENT_ID}/registrations/${REGISTRATION_ID}`,
      { auth: true, body: { status: 'WITHDRAWN' } },
    );

    expect(result.status).toBe(200);
    expect(prisma.registration.findFirst).not.toHaveBeenCalled();
    expect(prisma.registration.update).toHaveBeenCalledTimes(1);
    expect(prisma.registration.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'WITHDRAWN' } }),
    );
  });

  it('до старта снятие по-прежнему отдаёт место первому в очереди', async () => {
    prisma.tournament.findUnique.mockResolvedValue(makeTournament({ maxParticipants: 8 }));
    prisma.registration.findUnique.mockResolvedValue(entry('CONFIRMED'));
    prisma.registration.count.mockResolvedValue(7);
    prisma.registration.findFirst.mockResolvedValue({ id: 'next-in-line' });

    await call('PATCH', `/tournaments/${TOURNAMENT_ID}/registrations/${REGISTRATION_ID}`, {
      auth: true,
      body: { status: 'WITHDRAWN' },
    });

    expect(prisma.registration.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'next-in-line' }, data: { status: 'CONFIRMED' } }),
    );
  });

  it('снятого по ошибке возвращают в игру, если он в расстановке', async () => {
    prisma.tournament.findUnique.mockResolvedValue(running());
    prisma.registration.findUnique.mockResolvedValue(entry('NO_SHOW'));
    prisma.match.count.mockResolvedValue(3);
    // Полный состав мешать не должен: место за ним в сетке и так есть.
    prisma.registration.count.mockResolvedValue(8);

    const result = await call(
      'PATCH',
      `/tournaments/${TOURNAMENT_ID}/registrations/${REGISTRATION_ID}`,
      { auth: true, body: { status: 'CONFIRMED' } },
    );

    expect(result.status).toBe(200);
    expect(prisma.registration.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PLAYING' }) as unknown }),
    );
  });

  it('после старта из листа ожидания в игру не взять: в сетке ему места нет', async () => {
    prisma.tournament.findUnique.mockResolvedValue(running());
    prisma.registration.findUnique.mockResolvedValue(entry('WAITLIST'));
    prisma.match.count.mockResolvedValue(0);

    const result = await call(
      'PATCH',
      `/tournaments/${TOURNAMENT_ID}/registrations/${REGISTRATION_ID}`,
      { auth: true, body: { status: 'CONFIRMED' } },
    );

    expect(result.status).toBe(400);
    expect(prisma.registration.update).not.toHaveBeenCalled();
  });

  it('снятие достраивает плей-офф, если доиграть группы было некому', async () => {
    prisma.tournament.findUnique.mockResolvedValue(running());
    prisma.registration.findUnique.mockResolvedValue(entry('PLAYING'));

    await call('PATCH', `/tournaments/${TOURNAMENT_ID}/registrations/${REGISTRATION_ID}`, {
      auth: true,
      body: { status: 'WITHDRAWN' },
    });

    // Достройка читает схему турнира в транзакции снятия — ADR-020, ADR-061.
    expect(prisma.tournament.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ select: { formatConfig: true } }),
    );
  });
});

describe('правка по ходу турнира — ADR-061', () => {
  const KNOCKOUT_FORMAT = {
    type: 'KNOCKOUT',
    setsToWin: 3,
    thirdPlace: false,
    consolation: false,
  };

  function runningKnockout() {
    return makeTournament({
      status: 'RUNNING',
      startedAt: new Date('2026-08-30T10:00:00.000Z'),
      formatConfig: KNOCKOUT_FORMAT,
    });
  }

  function knockoutStage(finalStatus: string) {
    const match = (id: string, round: number, status: string) => ({
      id,
      stageId: STAGE_ID,
      groupId: null,
      playerAId: null,
      playerBId: null,
      sourceA: null,
      sourceB: null,
      status,
      tableNumber: null,
      setsA: status === 'FINISHED' ? 3 : null,
      setsB: status === 'FINISHED' ? 0 : null,
      setScores: null,
      resultType: null,
      bracketRound: round,
      bracketSlot: 0,
      startedAt: null,
      finishedAt: null,
    });

    return {
      id: STAGE_ID,
      order: 0,
      type: 'KNOCKOUT',
      name: 'Сетка',
      config: { setsToWin: 3, bracketSize: 4 },
      groups: [],
      matches: [match('semi', 1, 'FINISHED'), match('final', 2, finalStatus)],
    };
  }

  it('число столов меняется после старта, жеребьёвка остаётся', async () => {
    prisma.tournament.findUnique.mockResolvedValue(runningKnockout());

    const result = await call('PATCH', `/tournaments/${TOURNAMENT_ID}`, {
      auth: true,
      body: { tableCount: 8 },
    });

    expect(result.status).toBe(200);
    expect(prisma.tournament.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tableCount: 8 }) as unknown }),
    );
    expect(prisma.stage.deleteMany).not.toHaveBeenCalled();
  });

  it('стол, за которым ещё играют, не убрать', async () => {
    prisma.tournament.findUnique.mockResolvedValue(runningKnockout());
    prisma.match.findFirst.mockResolvedValue({ id: 'playing', tableNumber: 6 });

    const result = await call('PATCH', `/tournaments/${TOURNAMENT_ID}`, {
      auth: true,
      body: { tableCount: 4 },
    });

    expect(result.status).toBe(409);
    expect((result.body?.error as { code: string }).code).toBe('TABLE_BUSY');
    expect(prisma.tournament.update).not.toHaveBeenCalled();
  });

  it('финал до четырёх побед, пока финал не начат', async () => {
    prisma.tournament.findUnique.mockResolvedValue(runningKnockout());
    prisma.stage.findMany.mockResolvedValue([knockoutStage('PENDING')]);

    const result = await call('PATCH', `/tournaments/${TOURNAMENT_ID}`, {
      auth: true,
      body: { formatConfig: { ...KNOCKOUT_FORMAT, playoffSetsToWin: { final: 4 } } },
    });

    expect(result.status).toBe(200);
    // Сервер берёт длину из этапа (ADR-044): правка обязана доехать и туда.
    expect(prisma.stage.update).toHaveBeenCalledWith({
      where: { id: STAGE_ID },
      data: { config: { setsToWin: 3, bracketSize: 4, playoffSetsToWin: { final: 4 } } },
    });
  });

  it('длину начатой встречи не сменить', async () => {
    prisma.tournament.findUnique.mockResolvedValue(runningKnockout());
    prisma.stage.findMany.mockResolvedValue([knockoutStage('PLAYING')]);

    const result = await call('PATCH', `/tournaments/${TOURNAMENT_ID}`, {
      auth: true,
      body: { formatConfig: { ...KNOCKOUT_FORMAT, playoffSetsToWin: { final: 4 } } },
    });

    expect(result.status).toBe(409);
    expect(result.body?.error).toMatchObject({
      code: 'MATCH_LENGTH_LOCKED',
      details: { matchIds: ['final'] },
    });
  });

  it('сыгранный круг длину не держит, если её не меняют', async () => {
    // Полуфинал сыгран до трёх, правка трогает только финал.
    prisma.tournament.findUnique.mockResolvedValue(runningKnockout());
    prisma.stage.findMany.mockResolvedValue([knockoutStage('PENDING')]);

    const result = await call('PATCH', `/tournaments/${TOURNAMENT_ID}`, {
      auth: true,
      body: { formatConfig: { ...KNOCKOUT_FORMAT, playoffSetsToWin: { semifinal: 3, final: 4 } } },
    });

    expect(result.status).toBe(200);
  });

  it('схему после старта не сменить: только длины', async () => {
    prisma.tournament.findUnique.mockResolvedValue(runningKnockout());

    const result = await call('PATCH', `/tournaments/${TOURNAMENT_ID}`, {
      auth: true,
      body: { formatConfig: { ...KNOCKOUT_FORMAT, thirdPlace: true } },
    });

    expect(result.status).toBe(403);
    expect(prisma.tournament.update).not.toHaveBeenCalled();
  });

  it('завершённый турнир не правится вовсе', async () => {
    prisma.tournament.findUnique.mockResolvedValue(
      makeTournament({ status: 'FINISHED', startedAt: new Date('2026-08-30T10:00:00.000Z') }),
    );

    const result = await call('PATCH', `/tournaments/${TOURNAMENT_ID}`, {
      auth: true,
      body: { tableCount: 8 },
    });

    expect(result.status).toBe(403);
  });
});

describe('жеребьёвка — ТЗ 5.3', () => {
  /** Четверо участников: меньше двух движок не примет. */
  function fourPlayers() {
    return [0, 1, 2, 3].map((index) => ({
      seed: null,
      player: {
        id: `${String(index)}0000000-0000-4000-8000-000000000000`,
        rating: { toString: () => '250.00' },
        clubId: null,
      },
    }));
  }

  it('до закрытия регистрации не проводится', async () => {
    const result = await call('POST', `/tournaments/${TOURNAMENT_ID}/draw`, { auth: true });

    expect(result.status).toBe(400);
    expect(prisma.match.createMany).not.toHaveBeenCalled();
  });

  it('после закрытия раскладывает участников по встречам', async () => {
    prisma.tournament.findUnique.mockResolvedValue(makeTournament({ status: 'REG_CLOSED' }));
    prisma.registration.findMany.mockResolvedValue(fourPlayers());

    const result = await call('POST', `/tournaments/${TOURNAMENT_ID}/draw`, { auth: true });

    expect(result.status).toBe(201);
    expect(prisma.match.createMany).toHaveBeenCalledOnce();
    // Несведённые одноклубники возвращаются всегда, даже пустым списком.
    expect(result.body).toMatchObject({ clubCollisions: [] });
  });

  it('повторная жеребьёвка стирает предыдущую целиком', async () => {
    // ТЗ 5.3 требует пересчёта при снятии участника: частичная правка
    // оставила бы встречи, которых в новой расстановке не существует.
    prisma.tournament.findUnique.mockResolvedValue(makeTournament({ status: 'REG_CLOSED' }));
    prisma.registration.findMany.mockResolvedValue(fourPlayers());

    await call('POST', `/tournaments/${TOURNAMENT_ID}/draw`, { auth: true });

    expect(prisma.stage.deleteMany).toHaveBeenCalledOnce();
  });

  it('посторонний жеребьёвку не проводит', async () => {
    prisma.tournament.findUnique.mockResolvedValue(makeTournament({ status: 'REG_CLOSED' }));
    prisma.clubMember.findUnique.mockResolvedValue(null);

    expect((await call('POST', `/tournaments/${TOURNAMENT_ID}/draw`, { auth: true })).status).toBe(
      403,
    );
  });
});

describe('старт — ТС 5.4', () => {
  it('без жеребьёвки турнир не начинается', async () => {
    // ТЗ 4.1: в «Идёт» переводит не только нажатие, но и сформированные группы.
    prisma.tournament.findUnique.mockResolvedValue(makeTournament({ status: 'REG_CLOSED' }));
    prisma.stage.count.mockResolvedValue(0);

    const result = await call('POST', `/tournaments/${TOURNAMENT_ID}/start`, { auth: true });

    expect(result.status).toBe(400);
    expect(prisma.tournament.update).not.toHaveBeenCalled();
  });

  it('фиксирует рейтинги участников на момент старта', async () => {
    // Без снимка расчёт зависит от порядка обработки встреч, и локальный
    // расчёт консоли расходится с серверным (ТС 5.4).
    prisma.tournament.findUnique.mockResolvedValue(makeTournament({ status: 'REG_CLOSED' }));
    prisma.registration.findMany.mockResolvedValue([
      { id: REGISTRATION_ID, player: { rating: '250.00', ratedMatches: 12 } },
    ]);

    const result = await call('POST', `/tournaments/${TOURNAMENT_ID}/start`, { auth: true });

    expect(result.status).toBe(201);

    const update = prisma.registration.update.mock.calls[0]?.[0] as
      { data?: Record<string, unknown> } | undefined;

    expect(update?.data).toMatchObject({
      status: 'PLAYING',
      ratingAtStart: '250.00',
      matchesAtStart: 12,
    });
  });

  it('из открытой регистрации не стартует', async () => {
    const result = await call('POST', `/tournaments/${TOURNAMENT_ID}/start`, { auth: true });

    expect(result.status).toBe(400);
  });
});

describe('завершение и рейтинг — ТЗ 4.1, ТЗ 7.3', () => {
  const PA = '00000000-0000-4000-8000-0000000000a1';
  const PB = '00000000-0000-4000-8000-0000000000a2';

  /** Круговая на двоих: одна встреча, места определяются без судьи. */
  function stage(setsA: number | null) {
    return [
      {
        id: STAGE_ID,
        order: 0,
        type: 'ROUND_ROBIN',
        name: 'Круговая',
        config: { setsToWin: 3 },
        groups: [{ id: GROUP_ID, label: 'Круговая', order: 0, tieDecisions: [] }],
        matches: [
          {
            id: 'm1',
            stageId: STAGE_ID,
            groupId: GROUP_ID,
            playerAId: PA,
            playerBId: PB,
            sourceA: null,
            sourceB: null,
            status: setsA === null ? 'PENDING' : 'FINISHED',
            tableNumber: null,
            setsA,
            setsB: setsA === null ? null : 1,
            setScores: null,
            resultType: setsA === null ? null : 'NORMAL',
            bracketRound: 1,
            bracketSlot: null,
          },
        ],
      },
    ];
  }

  function played(id: string) {
    return {
      id: `reg-${id}`,
      tournamentId: TOURNAMENT_ID,
      status: 'PLAYING',
      isRated: true,
      seed: null,
      ratingAtStart: '300.00',
      matchesAtStart: 25,
      createdAt: new Date('2026-08-30T00:00:00.000Z'),
      player: { ...player, id, rating: { toString: () => '300.00' }, ratedMatches: 25 },
      coachPlayerId: null,
      coachName: null,
      coachPlayer: null,
    };
  }

  beforeEach(() => {
    prisma.tournament.findUnique.mockResolvedValue(makeTournament({ status: 'RUNNING' }));
    prisma.stage.findMany.mockResolvedValue(stage(3));
    prisma.registration.findMany.mockResolvedValue([played(PA), played(PB)]);
  });

  it('несыгранная встреча держит турнир', async () => {
    prisma.stage.findMany.mockResolvedValue(stage(null));

    const result = await call('POST', `/tournaments/${TOURNAMENT_ID}/finish`, { auth: true });

    expect(result.status).toBe(409);
    expect((result.body?.error as { code?: string } | undefined)?.code).toBe(
      'TOURNAMENT_NOT_COMPLETE',
    );
    expect(prisma.tournament.update).not.toHaveBeenCalled();
    expect(prisma.ratingEvent.createMany).not.toHaveBeenCalled();
  });

  it('неразрешённое равенство держит турнир — ADR-008', async () => {
    // Две встречи с одинаковым счётом в обе стороны правилами 1–5 не
    // разделяются: пока места не определены, завершать нечего.
    const tied = stage(3);
    tied[0]?.matches.push({ ...tied[0].matches[0], id: 'm2', setsA: 1, setsB: 3 } as never);
    prisma.stage.findMany.mockResolvedValue(tied);

    const result = await call('POST', `/tournaments/${TOURNAMENT_ID}/finish`, { auth: true });

    expect(result.status).toBe(409);
    expect((result.body?.error as { code?: string } | undefined)?.code).toBe('TIES_UNRESOLVED');
    expect(prisma.ratingEvent.createMany).not.toHaveBeenCalled();
  });

  it('сыгравший без снимка на старте останавливает обсчёт — ТС 5.4', async () => {
    prisma.registration.findMany.mockResolvedValue([played(PA)]);

    const result = await call('POST', `/tournaments/${TOURNAMENT_ID}/finish`, { auth: true });

    expect(result.status).toBe(409);
    expect((result.body?.error as { code?: string } | undefined)?.code).toBe(
      'RATING_SNAPSHOT_MISSING',
    );
  });

  it('пишет журнал, двигает проекции и переводит в «Обсчитан»', async () => {
    const result = await call('POST', `/tournaments/${TOURNAMENT_ID}/finish`, { auth: true });

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ status: 'RATED' });

    const closed = prisma.tournament.update.mock.calls[0]?.[0] as
      { data?: Record<string, unknown> } | undefined;
    expect(closed?.data).toMatchObject({ status: 'FINISHED' });

    const events = (
      prisma.ratingEvent.createMany.mock.calls[0]?.[0] as
        { data?: Record<string, unknown>[] } | undefined
    )?.data;

    expect(events).toHaveLength(2);
    expect(events?.[0]).toMatchObject({
      playerId: PA,
      matchId: 'm1',
      tournamentId: TOURNAMENT_ID,
      type: 'MATCH',
      ratingBefore: 300,
      createdBy: USER_ID,
    });
    // Оба рейтинговые: система замкнута, очков не прибавилось (ТС 5.5).
    expect(Number(events?.[0]?.delta) + Number(events?.[1]?.delta)).toBe(0);

    expect(prisma.player.update).toHaveBeenCalledTimes(2);
    const projection = prisma.player.update.mock.calls[0]?.[0] as
      { data?: Record<string, unknown> } | undefined;
    expect(projection?.data).toMatchObject({ ratedMatches: 26, isProvisional: false });

    const rated = prisma.tournament.updateMany.mock.calls[0]?.[0] as
      { where?: Record<string, unknown>; data?: Record<string, unknown> } | undefined;
    expect(rated?.where).toMatchObject({ id: TOURNAMENT_ID, status: 'FINISHED' });
    expect(rated?.data).toMatchObject({ status: 'RATED' });

    // Места записаны в заявки и турнир отмечен — профиль игрока читает их
    // оттуда, не пересчитывая турнир (ADR-048).
    expect(
      prisma.tournament.update.mock.calls.some(
        ([args]) => (args as { data?: { placesAt?: unknown } }).data?.placesAt instanceof Date,
      ),
    ).toBe(true);
    expect(prisma.registration.update).toHaveBeenCalled();
  });

  it('из «Завершён» доводит до обсчёта, не закрывая турнир заново', async () => {
    // Упавший расчёт оставляет турнир в «Завершён» — повторный вызов
    // обязан дочитать его до конца, а не отказать.
    prisma.tournament.findUnique.mockResolvedValue(makeTournament({ status: 'FINISHED' }));

    const result = await call('POST', `/tournaments/${TOURNAMENT_ID}/finish`, { auth: true });

    expect(result.status).toBe(201);
    expect(
      prisma.tournament.update.mock.calls.some(
        ([args]) => (args as { data?: { status?: string } }).data?.status === 'FINISHED',
      ),
    ).toBe(false);
    expect(prisma.ratingEvent.createMany).toHaveBeenCalled();
  });

  it('обсчитанный турнир второй раз рейтинг не получает', async () => {
    prisma.tournament.findUnique.mockResolvedValue(makeTournament({ status: 'RATED' }));

    const result = await call('POST', `/tournaments/${TOURNAMENT_ID}/finish`, { auth: true });

    expect(result.status).toBe(400);
    expect(prisma.ratingEvent.createMany).not.toHaveBeenCalled();
  });

  it('гонка двух вызовов начисляет рейтинг один раз', async () => {
    // Замком служит сам переход: он идёт первым и только из «Завершён».
    prisma.tournament.updateMany.mockResolvedValue({ count: 0 });

    const result = await call('POST', `/tournaments/${TOURNAMENT_ID}/finish`, { auth: true });

    expect(result.status).toBe(400);
  });

  it('судье клуба завершение закрыто — ADR-014', async () => {
    prisma.clubMember.findUnique.mockResolvedValue(null);

    expect(
      (await call('POST', `/tournaments/${TOURNAMENT_ID}/finish`, { auth: true })).status,
    ).toBe(403);
  });

  it('без токена не завершается', async () => {
    expect((await call('POST', `/tournaments/${TOURNAMENT_ID}/finish`)).status).toBe(401);
  });
});

describe('таблицы — ТЗ 6.6', () => {
  it('открыты без токена, как и сам турнир', async () => {
    const result = await call('GET', `/tournaments/${TOURNAMENT_ID}/standings`);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ tournamentId: TOURNAMENT_ID, groups: [] });
  });

  it('черновик таблиц не показывает', async () => {
    prisma.tournament.findUnique.mockResolvedValue(makeTournament({ status: 'DRAFT' }));

    expect((await call('GET', `/tournaments/${TOURNAMENT_ID}/standings`)).status).toBe(404);
  });
});

describe('решение судьи по равенству — ADR-008', () => {
  const PA = '00000000-0000-4000-8000-0000000000c1';
  const PB = '00000000-0000-4000-8000-0000000000c2';
  const PC = '00000000-0000-4000-8000-0000000000c3';

  /**
   * Круг побед на троих: каждый выиграл у одного и проиграл другому с тем же
   * счётом. Правила 1–5 ТЗ 6.6 таких не разделяют, места остаются пустыми.
   */
  function tiedGroup() {
    const match = (id: string, a: string, b: string) => ({
      id,
      stageId: STAGE_ID,
      groupId: GROUP_ID,
      playerAId: a,
      playerBId: b,
      sourceA: null,
      sourceB: null,
      status: 'FINISHED',
      tableNumber: null,
      setsA: 3,
      setsB: 0,
      setScores: null,
      resultType: 'NORMAL',
      bracketRound: 1,
      bracketSlot: null,
    });

    return [
      {
        id: STAGE_ID,
        order: 0,
        type: 'ROUND_ROBIN',
        name: 'Круговая',
        config: { setsToWin: 3 },
        groups: [{ id: GROUP_ID, label: 'Круговая', order: 0, tieDecisions: [] }],
        matches: [match('m1', PA, PB), match('m2', PB, PC), match('m3', PC, PA)],
      },
    ];
  }

  beforeEach(() => {
    prisma.tournament.findUnique.mockResolvedValue(makeTournament({ status: 'RUNNING' }));
    prisma.stage.findMany.mockResolvedValue(tiedGroup());
    prisma.registration.findMany.mockResolvedValue([]);
  });

  it('сохраняет порядок, названный судьёй', async () => {
    const result = await call('POST', `/tournaments/${TOURNAMENT_ID}/tie-decisions`, {
      body: { groupId: GROUP_ID, orderedIds: [PA, PB, PC] },
      auth: true,
    });

    expect(result.status).toBe(201);

    const created = prisma.tieDecision.create.mock.calls[0]?.[0] as
      { data?: Record<string, unknown> } | undefined;

    expect(created?.data).toMatchObject({ groupId: GROUP_ID, decidedBy: USER_ID });
    expect(created?.data?.orderedIds).toEqual([PA, PB, PC]);
  });

  it('порядок, не отвечающий ни одному равенству, отклоняется', async () => {
    // Места — величина расчётная. Судья решает, кто выше внутри равенства,
    // а не переставляет таблицу как хочет.
    const result = await call('POST', `/tournaments/${TOURNAMENT_ID}/tie-decisions`, {
      body: { groupId: GROUP_ID, orderedIds: [PA, PB] },
      auth: true,
    });

    expect(result.status).toBe(400);
    expect((result.body?.error as { code?: string } | undefined)?.code).toBe(
      'TIE_DECISION_INVALID',
    );
    expect(prisma.tieDecision.create).not.toHaveBeenCalled();
  });

  it('в неидущем турнире равенство не разрешают', async () => {
    prisma.tournament.findUnique.mockResolvedValue(makeTournament({ status: 'REG_CLOSED' }));

    const result = await call('POST', `/tournaments/${TOURNAMENT_ID}/tie-decisions`, {
      body: { groupId: GROUP_ID, orderedIds: [PA, PB, PC] },
      auth: true,
    });

    expect(result.status).toBe(409);
  });

  it('группа чужого турнира не находится', async () => {
    prisma.group.findUnique.mockResolvedValue({
      id: GROUP_ID,
      stage: { tournamentId: 'другой' },
    });

    const result = await call('POST', `/tournaments/${TOURNAMENT_ID}/tie-decisions`, {
      body: { groupId: GROUP_ID, orderedIds: [PA, PB, PC] },
      auth: true,
    });

    expect(result.status).toBe(404);
  });

  it('посторонний решения не принимает', async () => {
    prisma.clubMember.findUnique.mockResolvedValue(null);

    const result = await call('POST', `/tournaments/${TOURNAMENT_ID}/tie-decisions`, {
      body: { groupId: GROUP_ID, orderedIds: [PA, PB, PC] },
      auth: true,
    });

    expect(result.status).toBe(403);
  });
});

describe('тренер участника — ADR-059, T3', () => {
  const COACH_ID = '99999999-9999-4999-8999-999999999999';
  const path = `/tournaments/${TOURNAMENT_ID}/registrations/${REGISTRATION_ID}/coach`;

  beforeEach(() => {
    prisma.registration.findUnique.mockResolvedValue({
      id: REGISTRATION_ID,
      status: 'CONFIRMED',
      playerId: PLAYER_ID,
      tournamentId: TOURNAMENT_ID,
    });
  });

  function updatedData(): unknown {
    const args = prisma.registration.update.mock.calls[0]?.[0] as { data?: unknown } | undefined;

    return args?.data;
  }

  it('при записи тренер копируется из анкеты', async () => {
    prisma.registration.findUnique.mockResolvedValue(null);
    prisma.player.findUnique.mockResolvedValue({
      ...player,
      coachPlayerId: COACH_ID,
      coachName: null,
    });

    await call('POST', `/tournaments/${TOURNAMENT_ID}/registrations`, { auth: true, body: {} });

    expect(prisma.registration.create.mock.calls[0]?.[0]).toMatchObject({
      data: { coachPlayerId: COACH_ID, coachName: null },
    });
  });

  it('состав отдаёт тренера: имя по связи, ссылка на опубликованную страницу', async () => {
    prisma.registration.findMany.mockResolvedValue([
      {
        ...registration,
        coachPlayerId: COACH_ID,
        coachPlayer: {
          lastName: 'Петров',
          firstName: 'Иван',
          coachPage: { slug: 'ivan-petrov', status: 'APPROVED', hiddenAt: null },
        },
      },
    ]);

    const result = await call('GET', `/tournaments/${TOURNAMENT_ID}/registrations`);

    expect(result.body).toMatchObject([
      { coach: { playerId: COACH_ID, name: 'Петров Иван', slug: 'ivan-petrov' } },
    ]);
  });

  it('игрок правит своего тренера — запись больше не идёт за анкетой', async () => {
    const result = await call('PUT', path, {
      auth: true,
      body: { coachPlayerId: null, coachName: 'Сидоров' },
    });

    expect(result.status).toBe(200);
    expect(updatedData()).toEqual({ coachPlayerId: null, coachName: 'Сидоров', coachManual: true });
  });

  it('организатор правит тренера чужого игрока, тренер из списка обязан существовать', async () => {
    prisma.player.findUnique.mockResolvedValue({ ...player, userId: null });

    const result = await call('PUT', path, {
      auth: true,
      body: { coachPlayerId: COACH_ID, coachName: null },
    });

    expect(result.status).toBe(200);
    expect(updatedData()).toEqual({ coachPlayerId: COACH_ID, coachName: null, coachManual: true });

    prisma.player.findUnique.mockResolvedValueOnce({ userId: null }).mockResolvedValueOnce(null);

    const missing = await call('PUT', path, {
      auth: true,
      body: { coachPlayerId: COACH_ID, coachName: null },
    });

    expect(missing.status).toBe(404);
  });

  it('посторонний тренера не правит', async () => {
    prisma.player.findUnique.mockResolvedValue({ ...player, userId: null });
    prisma.clubMember.findUnique.mockResolvedValue(null);

    const result = await call('PUT', path, {
      auth: true,
      body: { coachPlayerId: null, coachName: null },
    });

    expect(result.status).toBe(403);
    expect(prisma.registration.update).not.toHaveBeenCalled();
  });

  it('после старта тренер не правится — REGISTRATION_COACH_LOCKED', async () => {
    for (const status of ['RUNNING', 'FINISHED', 'RATED', 'CANCELLED']) {
      prisma.tournament.findUnique.mockResolvedValue(makeTournament({ status }));

      const result = await call('PUT', path, {
        auth: true,
        body: { coachPlayerId: null, coachName: null },
      });

      expect(result.status).toBe(409);
      expect(result.body).toMatchObject({ error: { code: 'REGISTRATION_COACH_LOCKED' } });
    }

    expect(prisma.registration.update).not.toHaveBeenCalled();
  });

  it('из списка и строкой разом — отказ схемой; сам себе тренером — тоже', async () => {
    const both = await call('PUT', path, {
      auth: true,
      body: { coachPlayerId: COACH_ID, coachName: 'Сидоров' },
    });

    expect(both.status).toBe(400);

    const self = await call('PUT', path, {
      auth: true,
      body: { coachPlayerId: PLAYER_ID, coachName: null },
    });

    expect(self.status).toBe(400);
    expect(prisma.registration.update).not.toHaveBeenCalled();
  });

  it('без токена не правится', async () => {
    expect(
      (await call('PUT', path, { body: { coachPlayerId: null, coachName: null } })).status,
    ).toBe(401);
  });
});
