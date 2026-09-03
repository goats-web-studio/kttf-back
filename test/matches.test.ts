import { type INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { AuthModule } from '../src/features/auth/auth.module.js';
import { MatchesModule } from '../src/features/matches/matches.module.js';
import { ConfigModule } from '../src/infra/config/config.module.js';
import { ENV, type Env } from '../src/infra/config/env.js';
import { PrismaModule } from '../src/infra/prisma/prisma.module.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';

/**
 * Ввод результата встречи через настоящее приложение — ТС 7.6.
 *
 * Продвижение по сетке и проверка счёта проверены в общем коде на чистых
 * функциях. Здесь проверяется, что правила вообще применяются: право вести
 * консоль, состояние турнира и то, что победитель доезжает до следующего
 * круга не в теории, а на пути через контроллер и базу.
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
const STAGE_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_STAGE_ID = '55555555-5555-4555-8555-555555555555';

const M1 = '00000000-0000-4000-8000-000000000001';
const M2 = '00000000-0000-4000-8000-000000000002';
const FINAL = '00000000-0000-4000-8000-000000000003';
const P1 = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000a2';
const P3 = '00000000-0000-4000-8000-0000000000a3';
const P4 = '00000000-0000-4000-8000-0000000000a4';

const KNOCKOUT = { type: 'KNOCKOUT', setsToWin: 3, thirdPlace: false, consolation: false };

interface MatchRow {
  id: string;
  tournamentId: string;
  stageId: string;
  groupId: string | null;
  playerAId: string | null;
  playerBId: string | null;
  sourceA: unknown;
  sourceB: unknown;
  status: string;
  tableNumber: number | null;
  setsA: number | null;
  setsB: number | null;
  setScores: unknown;
  resultType: string | null;
  bracketRound: number | null;
  bracketSlot: number | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

function makeMatch(over: Partial<MatchRow> & { id: string }): MatchRow {
  return {
    tournamentId: TOURNAMENT_ID,
    stageId: STAGE_ID,
    groupId: null,
    playerAId: null,
    playerBId: null,
    sourceA: null,
    sourceB: null,
    status: 'PENDING',
    tableNumber: null,
    setsA: null,
    setsB: null,
    setScores: null,
    resultType: null,
    bracketRound: 1,
    bracketSlot: 0,
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

/** Сетка на четверых: два полуфинала и финал из их победителей. */
function knockoutMatches(): MatchRow[] {
  return [
    makeMatch({ id: M1, playerAId: P1, playerBId: P4, bracketRound: 1, bracketSlot: 0 }),
    makeMatch({ id: M2, playerAId: P2, playerBId: P3, bracketRound: 1, bracketSlot: 1 }),
    makeMatch({
      id: FINAL,
      sourceA: { kind: 'WINNER', matchId: M1 },
      sourceB: { kind: 'WINNER', matchId: M2 },
      bracketRound: 2,
      bracketSlot: 0,
    }),
  ];
}

interface Db {
  matches: MatchRow[];
  stages: { id: string; order: number; type: string; name: string; config: unknown }[];
  groups: { id: string; stageId: string; label: string; order: number }[];
  tieDecisions: { groupId: string; orderedIds: string[] }[];
  withdrawn: string[];
  formatConfig: unknown;
  status: string;
  role: string | null;
  /** Версия турнира: растёт на каждое изменение — ТС 6.3. */
  version: number;
}

function makeDb(over: Partial<Db> = {}): Db {
  return {
    matches: knockoutMatches(),
    stages: [{ id: STAGE_ID, order: 0, type: 'KNOCKOUT', name: 'Сетка', config: { setsToWin: 3 } }],
    groups: [],
    tieDecisions: [],
    withdrawn: [],
    formatConfig: KNOCKOUT,
    status: 'RUNNING',
    role: 'OWNER',
    version: 0,
    ...over,
  };
}

/**
 * Мок базы, отвечающий на те запросы, которые делает сервис.
 *
 * Встречи держатся в массиве и правда меняются: без этого не проверить, что
 * победитель уехал в следующий круг, — а ровно это и проверяется.
 */
function makePrisma(db: Db) {
  const stageOf = (id: string) => db.stages.find((stage) => stage.id === id);

  const withGroups = (stage: (typeof db.stages)[number]) => ({
    ...stage,
    groups: db.groups
      .filter((group) => group.stageId === stage.id)
      .map((group) => ({
        ...group,
        tieDecisions: db.tieDecisions
          .filter((decision) => decision.groupId === group.id)
          .map((decision) => ({ orderedIds: decision.orderedIds })),
      })),
    matches: db.matches.filter((match) => match.stageId === stage.id),
  });

  const prisma = {
    match: {
      findUnique: vi.fn(({ where }: { where: { id: string } }) => {
        const match = db.matches.find((row) => row.id === where.id);
        if (match === undefined) return Promise.resolve(null);

        return Promise.resolve({
          ...match,
          stage: stageOf(match.stageId),
          tournament: { id: TOURNAMENT_ID, clubId: CLUB_ID, status: db.status },
        });
      }),
      findMany: vi.fn(({ where }: { where: Record<string, unknown> }) => {
        let rows = db.matches.filter((match) => match.stageId === where.stageId);

        const not = where.id as { not?: string } | undefined;
        if (not?.not !== undefined) rows = rows.filter((match) => match.id !== not.not);
        if (where.NOT !== undefined) rows = rows.filter((match) => match.setsA !== null);

        return Promise.resolve(rows);
      }),
      update: vi.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const match = db.matches.find((row) => row.id === where.id);
        /* v8 ignore next */
        if (match === undefined) throw new Error(`нет встречи ${where.id}`);

        for (const [key, value] of Object.entries(data)) {
          Object.assign(match, { [key]: isDbNull(value) ? null : value });
        }

        return Promise.resolve({ ...match });
      }),
      createMany: vi.fn(({ data }: { data: Record<string, unknown>[] }) => {
        for (const row of data) {
          db.matches.push(makeMatch(normalize(row) as Partial<MatchRow> & { id: string }));
        }
        return Promise.resolve({ count: data.length });
      }),
    },
    stage: {
      findMany: vi.fn(({ where }: { where: Record<string, unknown> }) => {
        const order = where.order as { gt?: number } | undefined;

        if (order?.gt !== undefined) {
          return Promise.resolve(
            db.stages
              .filter((stage) => stage.order > (order.gt ?? 0))
              .map((stage) => ({
                id: stage.id,
                matches: db.matches.filter(
                  (match) => match.stageId === stage.id && match.setsA !== null,
                ),
              })),
          );
        }

        return Promise.resolve([...db.stages].sort((a, b) => a.order - b.order).map(withGroups));
      }),
      findUnique: vi.fn(({ where }: { where: { id: string } }) => {
        const stage = stageOf(where.id);
        return Promise.resolve(stage === undefined ? null : withGroups(stage));
      }),
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        db.stages.push({
          id: OTHER_STAGE_ID,
          order: data.order as number,
          type: data.type as string,
          name: data.name as string,
          config: data.config,
        });
        return Promise.resolve({ id: OTHER_STAGE_ID });
      }),
      deleteMany: vi.fn(({ where }: { where: { id: { in: string[] } } }) => {
        db.stages = db.stages.filter((stage) => !where.id.in.includes(stage.id));
        db.matches = db.matches.filter((match) => !where.id.in.includes(match.stageId));
        return Promise.resolve({ count: 0 });
      }),
    },
    group: {
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        const id = `group-${String(db.groups.length)}`;
        db.groups.push({
          id,
          stageId: data.stageId as string,
          label: data.label as string,
          order: data.order as number,
        });
        return Promise.resolve({ id });
      }),
    },
    tournament: {
      findUnique: vi.fn(() => Promise.resolve({ formatConfig: db.formatConfig })),
      // Счётчик версии для офлайн-синхронизации — ТС 6.3. Считается по-настоящему:
      // консоль по нему узнаёт, что снимок устарел.
      update: vi.fn(() => {
        db.version += 1;
        return Promise.resolve({ id: TOURNAMENT_ID });
      }),
    },
    registration: {
      findMany: vi.fn(() => Promise.resolve(db.withdrawn.map((playerId) => ({ playerId })))),
    },
    clubMember: {
      findUnique: vi.fn(() => Promise.resolve(db.role === null ? null : { role: db.role })),
    },
    auditLog: {
      create: vi.fn((args: { data: Record<string, unknown> }) => Promise.resolve(args.data)),
    },
    $transaction: vi.fn(),
  };

  prisma.$transaction.mockImplementation((run: (tx: typeof prisma) => unknown) => run(prisma));

  return prisma;
}

/** Очистку колонки `Json` Prisma принимает маркером, а в мок нужен `null`. */
function isDbNull(value: unknown): boolean {
  return value === Prisma.DbNull;
}

function normalize(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    result[key] = isDbNull(value) ? null : value;
  }

  return result;
}

let app: INestApplication | undefined;
let prisma: ReturnType<typeof makePrisma>;
let db: Db;
let root: string;
let token: string;

async function boot(seed: Partial<Db> = {}): Promise<void> {
  db = makeDb(seed);
  prisma = makePrisma(db);

  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule, PrismaModule, AuthModule, MatchesModule],
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
}

beforeEach(async () => {
  await boot();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
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
    body: (await response.json()) as Record<string, unknown>,
  };
}

function matchById(id: string): MatchRow {
  const match = db.matches.find((row) => row.id === id);
  /* v8 ignore next */
  if (match === undefined) throw new Error(`нет встречи ${id}`);
  return match;
}

function codeOf(body: Record<string, unknown>): unknown {
  return (body.error as { code?: unknown } | undefined)?.code;
}

describe('чтение встречи', () => {
  it('открыто без токена: встречу видно на публичной странице результатов', async () => {
    const result = await call('GET', `/matches/${M1}`);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ id: M1, tournamentId: TOURNAMENT_ID });
  });

  it('несуществующая встреча — 404', async () => {
    const result = await call('GET', `/matches/${'0'.repeat(8)}-0000-4000-8000-000000000999`);

    expect(result.status).toBe(404);
  });
});

describe('право вести консоль', () => {
  it('без токена счёт не принимается', async () => {
    const result = await call('POST', `/matches/${M1}/result`, { body: { setsA: 3, setsB: 0 } });

    expect(result.status).toBe(401);
  });

  it('посторонний получает отказ', async () => {
    await app?.close();
    await boot({ role: null });

    const result = await call('POST', `/matches/${M1}/result`, {
      body: { setsA: 3, setsB: 0 },
      auth: true,
    });

    expect(result.status).toBe(403);
  });

  it('судья клуба счёт вводит: консоль турнира — его работа', async () => {
    await app?.close();
    await boot({ role: 'REFEREE' });

    const result = await call('POST', `/matches/${M1}/result`, {
      body: { setsA: 3, setsB: 0 },
      auth: true,
    });

    expect(result.status).toBe(201);
  });

  it('посторонний не узнаёт по коду отказа, введён ли уже счёт', async () => {
    await app?.close();
    await boot({ role: null });
    matchById(M1).setsA = 3;
    matchById(M1).setsB = 0;

    const result = await call('POST', `/matches/${M1}/result`, {
      body: { setsA: 3, setsB: 1 },
      auth: true,
    });

    expect(result.status).toBe(403);
  });
});

describe('ввод счёта — ТЗ 6.3', () => {
  it('быстрая кнопка закрывает встречу одним телом из двух чисел', async () => {
    const result = await call('POST', `/matches/${M1}/result`, {
      body: { setsA: 3, setsB: 0 },
      auth: true,
    });

    expect(result.status).toBe(201);
    expect(matchById(M1)).toMatchObject({ setsA: 3, setsB: 0, status: 'FINISHED' });
  });

  it('победитель уезжает в следующий круг сам — ADR-019', async () => {
    const result = await call('POST', `/matches/${M1}/result`, {
      body: { setsA: 0, setsB: 3 },
      auth: true,
    });

    expect(matchById(FINAL).playerAId).toBe(P4);
    expect(result.body.updated).toMatchObject([{ id: FINAL, playerAId: P4 }]);
  });

  it('версия турнира растёт: снимок офлайн-консоли устарел — ТС 6.3', async () => {
    const before = db.version;

    await call('POST', `/matches/${M1}/result`, { body: { setsA: 3, setsB: 0 }, auth: true });

    // По этому числу консоль, вернувшаяся из офлайна, узнаёт, что за время
    // её отсутствия турнир изменился, и подтягивает снимок заново.
    expect(db.version).toBe(before + 1);
  });

  it('счёт не по схеме отвергается', async () => {
    const result = await call('POST', `/matches/${M1}/result`, {
      body: { setsA: 2, setsB: 1 },
      auth: true,
    });

    expect(result.status).toBe(400);
    expect(codeOf(result.body)).toBe('INVALID_SCORE');
    expect(matchById(M1).setsA).toBeNull();
  });

  it('техническая победа принимается счётом до нуля', async () => {
    const result = await call('POST', `/matches/${M1}/result`, {
      body: { setsA: 3, setsB: 0, resultType: 'WALKOVER' },
      auth: true,
    });

    expect(result.status).toBe(201);
    expect(matchById(M1).resultType).toBe('WALKOVER');
  });

  it('повторный ввод отклоняется: для правки есть отдельный маршрут', async () => {
    await call('POST', `/matches/${M1}/result`, { body: { setsA: 3, setsB: 0 }, auth: true });

    const again = await call('POST', `/matches/${M1}/result`, {
      body: { setsA: 3, setsB: 1 },
      auth: true,
    });

    expect(again.status).toBe(409);
    expect(codeOf(again.body)).toBe('MATCH_ALREADY_FINISHED');
  });

  it('встреча без участников счёта не принимает', async () => {
    const result = await call('POST', `/matches/${FINAL}/result`, {
      body: { setsA: 3, setsB: 0 },
      auth: true,
    });

    expect(result.status).toBe(409);
    expect(codeOf(result.body)).toBe('MATCH_NOT_READY');
  });

  it('в неидущем турнире счёта не бывает', async () => {
    await app?.close();
    await boot({ status: 'REG_CLOSED' });

    const result = await call('POST', `/matches/${M1}/result`, {
      body: { setsA: 3, setsB: 0 },
      auth: true,
    });

    expect(result.status).toBe(409);
    expect(codeOf(result.body)).toBe('TOURNAMENT_NOT_RUNNING');
  });
});

describe('назначение на стол — ТЗ 6.2', () => {
  it('встреча уезжает в зону «Играется»', async () => {
    const result = await call('POST', `/matches/${M1}/assign`, {
      body: { tableNumber: 3 },
      auth: true,
    });

    expect(result.status).toBe(201);
    expect(matchById(M1)).toMatchObject({ tableNumber: 3, status: 'PLAYING' });
  });

  it('отдаёт время выхода на стол и время закрытия', async () => {
    // Очередь консоли сортируется по тому, кто дольше не играл (ТЗ 6.1).
    // Колонки в базе были и раньше, наружу они не выходили.
    const assigned = await call('POST', `/matches/${M1}/assign`, {
      body: { tableNumber: 3 },
      auth: true,
    });

    expect(assigned.body).toMatchObject({ finishedAt: null });
    expect(typeof (assigned.body as { startedAt: unknown }).startedAt).toBe('string');

    const played = await call('POST', `/matches/${M1}/result`, {
      body: { setsA: 3, setsB: 0 },
      auth: true,
    });

    expect(typeof (played.body as { match: { finishedAt: unknown } }).match.finishedAt).toBe(
      'string',
    );
  });

  it('сыгранную встречу на стол не ставят', async () => {
    await call('POST', `/matches/${M1}/result`, { body: { setsA: 3, setsB: 0 }, auth: true });

    const result = await call('POST', `/matches/${M1}/assign`, {
      body: { tableNumber: 3 },
      auth: true,
    });

    expect(result.status).toBe(409);
  });
});

describe('правка результата — ТЗ 6.3', () => {
  it('меняет победителя и переписывает следующий круг', async () => {
    await call('POST', `/matches/${M1}/result`, { body: { setsA: 3, setsB: 0 }, auth: true });
    expect(matchById(FINAL).playerAId).toBe(P1);

    const result = await call('PATCH', `/matches/${M1}`, {
      body: { setsA: 0, setsB: 3 },
      auth: true,
    });

    expect(result.status).toBe(200);
    expect(matchById(FINAL).playerAId).toBe(P4);
  });

  it('фиксируется в журнале', async () => {
    await call('POST', `/matches/${M1}/result`, { body: { setsA: 3, setsB: 0 }, auth: true });
    await call('PATCH', `/matches/${M1}`, { body: { setsA: 3, setsB: 2 }, auth: true });

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create.mock.calls[0]?.[0].data).toMatchObject({
      action: 'match.result.updated',
      entityId: M1,
      before: { setsA: 3, setsB: 0 },
      after: { setsA: 3, setsB: 2 },
    });
  });

  it('первый ввод в журнал не пишется: менять было нечего', async () => {
    await call('POST', `/matches/${M1}/result`, { body: { setsA: 3, setsB: 0 }, auth: true });

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('без результата править нечего', async () => {
    const result = await call('PATCH', `/matches/${M1}`, {
      body: { setsA: 3, setsB: 0 },
      auth: true,
    });

    expect(result.status).toBe(409);
    expect(codeOf(result.body)).toBe('MATCH_HAS_NO_RESULT');
  });

  it('отклоняется, когда следующая встреча уже сыграна', async () => {
    await call('POST', `/matches/${M1}/result`, { body: { setsA: 3, setsB: 0 }, auth: true });
    await call('POST', `/matches/${M2}/result`, { body: { setsA: 3, setsB: 0 }, auth: true });
    await call('POST', `/matches/${FINAL}/result`, { body: { setsA: 3, setsB: 0 }, auth: true });

    const result = await call('PATCH', `/matches/${M1}`, {
      body: { setsA: 0, setsB: 3 },
      auth: true,
    });

    expect(result.status).toBe(409);
    expect(codeOf(result.body)).toBe('DOWNSTREAM_MATCH_PLAYED');
    // Сыгранный финал остался нетронутым.
    expect(matchById(FINAL).setsA).toBe(3);
  });
});

describe('отмена встречи с возвратом в очередь — ТЗ 6.3', () => {
  it('снимает результат и стол, встреча ждёт снова', async () => {
    await call('POST', `/matches/${M1}/assign`, { body: { tableNumber: 2 }, auth: true });
    await call('POST', `/matches/${M1}/result`, { body: { setsA: 3, setsB: 0 }, auth: true });

    const result = await call('POST', `/matches/${M1}/cancel`, { auth: true });

    expect(result.status).toBe(201);
    expect(matchById(M1)).toMatchObject({
      setsA: null,
      setsB: null,
      resultType: null,
      tableNumber: null,
      status: 'PENDING',
    });
  });

  it('уводит из следующего круга того, кто туда попал', async () => {
    await call('POST', `/matches/${M1}/result`, { body: { setsA: 3, setsB: 0 }, auth: true });
    expect(matchById(FINAL).playerAId).toBe(P1);

    await call('POST', `/matches/${M1}/cancel`, { auth: true });

    expect(matchById(FINAL).playerAId).toBeNull();
  });
});

const GA1 = '00000000-0000-4000-8000-0000000000b1';
const GA2 = '00000000-0000-4000-8000-0000000000b2';
const GA3 = '00000000-0000-4000-8000-0000000000b3';
const GB1 = '00000000-0000-4000-8000-0000000000b4';

const PA = '00000000-0000-4000-8000-0000000000c1';
const PB = '00000000-0000-4000-8000-0000000000c2';

const GROUPS_FORMAT = {
  type: 'GROUPS_KNOCKOUT',
  groupCount: 2,
  advancePerGroup: 1,
  groupSetsToWin: 3,
  koSetsToWin: 3,
  thirdPlace: false,
};

/**
 * Групповой этап из двух групп.
 *
 * В первой либо двое, либо трое: троих можно свести в круг побед, где правила
 * 1–5 никого не разделяют и решение остаётся за судьёй (ADR-008).
 */
function groupSeed(options: { tie?: boolean } = {}): Partial<Db> {
  const groupA =
    options.tie === true
      ? [
          makeMatch({ id: GA1, groupId: 'group-a', playerAId: P1, playerBId: P2 }),
          makeMatch({ id: GA2, groupId: 'group-a', playerAId: P2, playerBId: P3 }),
          makeMatch({ id: GA3, groupId: 'group-a', playerAId: P3, playerBId: P1 }),
        ]
      : [makeMatch({ id: GA1, groupId: 'group-a', playerAId: P1, playerBId: P2 })];

  return {
    formatConfig: GROUPS_FORMAT,
    stages: [{ id: STAGE_ID, order: 0, type: 'GROUPS', name: 'Группы', config: { setsToWin: 3 } }],
    groups: [
      { id: 'group-a', stageId: STAGE_ID, label: 'гр. 1', order: 0 },
      { id: 'group-b', stageId: STAGE_ID, label: 'гр. 2', order: 1 },
    ],
    matches: [...groupA, makeMatch({ id: GB1, groupId: 'group-b', playerAId: PA, playerBId: PB })],
  };
}

async function play(id: string, setsA: number, setsB: number) {
  return call('POST', `/matches/${id}/result`, { body: { setsA, setsB }, auth: true });
}

describe('достройка плей-офф по итогам групп', () => {
  it('до последнего результата этап не появляется', async () => {
    await app?.close();
    await boot(groupSeed());

    const result = await play(GA1, 3, 0);

    expect(result.body.nextStage).toBeNull();
    expect(db.stages).toHaveLength(1);
  });

  it('последний результат группового этапа достраивает плей-офф', async () => {
    await app?.close();
    await boot(groupSeed());

    await play(GA1, 3, 0);
    const result = await play(GB1, 0, 3);

    expect(db.stages).toHaveLength(2);
    expect(result.body.nextStage).toMatchObject({ order: 1, name: 'Плей-офф' });
  });

  it('в плей-офф едут победители групп, и они известны сразу', async () => {
    await app?.close();
    await boot(groupSeed());

    await play(GA1, 3, 0);
    await play(GB1, 0, 3);

    const playoff = db.matches.filter((match) => match.stageId === OTHER_STAGE_ID);

    expect(playoff).toHaveLength(1);
    expect([playoff[0]?.playerAId, playoff[0]?.playerBId].sort()).toEqual([P1, PB].sort());
  });

  it('повторная запись результата этап не удваивает', async () => {
    await app?.close();
    await boot(groupSeed());

    await play(GA1, 3, 0);
    await play(GB1, 0, 3);
    await call('PATCH', `/matches/${GB1}`, { body: { setsA: 3, setsB: 0 }, auth: true });

    expect(db.stages).toHaveLength(2);
  });

  it('правка группового результата пересобирает несыгранный плей-офф', async () => {
    await app?.close();
    await boot(groupSeed());

    await play(GA1, 3, 0);
    await play(GB1, 0, 3);
    await call('PATCH', `/matches/${GA1}`, { body: { setsA: 0, setsB: 3 }, auth: true });

    const playoff = db.matches.filter((match) => match.stageId === OTHER_STAGE_ID);

    expect([playoff[0]?.playerAId, playoff[0]?.playerBId].sort()).toEqual([P2, PB].sort());
  });

  it('неразрешённое равенство останавливает достройку и называет группу', async () => {
    await app?.close();
    await boot(groupSeed({ tie: true }));

    // Круг побед: каждый выиграл у одного и проиграл другому с тем же счётом.
    // Правила 1–5 ТЗ 6.6 таких не разделяют — решает судья (ADR-008).
    await play(GA1, 3, 0);
    await play(GA2, 3, 0);
    await play(GA3, 3, 0);
    const result = await play(GB1, 3, 0);

    expect(result.body.nextStage).toBeNull();
    expect(result.body.blockedByTies).toEqual(['гр. 1']);
    expect(db.stages).toHaveLength(1);
  });
});
