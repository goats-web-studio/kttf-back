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
    ratingEvent: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    stage: {
      deleteMany: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({ id: STAGE_ID }),
      count: vi.fn().mockResolvedValue(1),
      findMany: vi.fn().mockResolvedValue([]),
    },
    group: {
      create: vi.fn().mockResolvedValue({ id: GROUP_ID }),
      findUnique: vi.fn().mockResolvedValue({
        id: GROUP_ID,
        stage: { tournamentId: TOURNAMENT_ID },
      }),
    },
    tieDecision: { create: vi.fn().mockResolvedValue({}) },
    match: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
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
  });

  it('из «Завершён» доводит до обсчёта, не закрывая турнир заново', async () => {
    // Упавший расчёт оставляет турнир в «Завершён» — повторный вызов
    // обязан дочитать его до конца, а не отказать.
    prisma.tournament.findUnique.mockResolvedValue(makeTournament({ status: 'FINISHED' }));

    const result = await call('POST', `/tournaments/${TOURNAMENT_ID}/finish`, { auth: true });

    expect(result.status).toBe(201);
    expect(prisma.tournament.update).not.toHaveBeenCalled();
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
