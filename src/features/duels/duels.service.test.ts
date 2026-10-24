import { isAppError } from '@kttf/shared/errors';
import { applyDelta, calculateMatch } from '@kttf/shared/rating';
import { duelViewSchema, type CreateDuelInput } from '@kttf/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { DuelRatingService } from './duel-rating.service.js';
import { DuelsAdminService } from './duels-admin.service.js';
import { DuelsService } from './duels.service.js';

/**
 * Дуэли — ADR-065, `docs/13`. Правила состояний, пределы, рейтинг и
 * уведомления на поддельной базе: проверяется, что сервис решает и что
 * пишет, а не как Postgres исполняет запросы.
 */

const DUEL_ID = '10000000-0000-4000-8000-000000000001';
const SLOT_ID = '10000000-0000-4000-8000-000000000002';
const AUTHOR = '20000000-0000-4000-8000-000000000001';
const OPPONENT = '20000000-0000-4000-8000-000000000002';
const STRANGER = '20000000-0000-4000-8000-000000000003';
const RESPONSE_ID = '30000000-0000-4000-8000-000000000001';
const OTHER_RESPONSE_ID = '30000000-0000-4000-8000-000000000002';
const CITY = '40000000-0000-4000-8000-000000000001';
const CLUB_ID = '40000000-0000-4000-8000-000000000002';
const city = { id: CITY, name: 'Алматы', nameKk: null };

const USER = {
  [AUTHOR]: '50000000-0000-4000-8000-000000000001',
  [OPPONENT]: '50000000-0000-4000-8000-000000000002',
  [STRANGER]: '50000000-0000-4000-8000-000000000003',
} as const;
const ADMIN_USER = '50000000-0000-4000-8000-000000000009';
const NO_PROFILE_USER = '50000000-0000-4000-8000-000000000008';

const NOW = new Date('2026-10-24T10:00:00.000Z');
const SLOT_START = new Date('2026-10-26T15:00:00.000Z');
const SLOT_END = new Date('2026-10-26T17:00:00.000Z');
/** Игра началась — можно вносить счёт. */
const PLAYED = new Date('2026-10-26T16:30:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

const NAMES = {
  [AUTHOR]: ['Петров', 'Олег'],
  [OPPONENT]: ['Иванов', 'Пётр'],
  [STRANGER]: ['Сидоров', 'Ким'],
} as const;

function side(id: keyof typeof NAMES, over: Record<string, unknown> = {}) {
  return {
    id,
    userId: USER[id],
    lastName: NAMES[id][0],
    firstName: NAMES[id][1],
    photoUrl: null,
    rating: new Prisma.Decimal('300'),
    ratedMatches: 25,
    isProvisional: false,
    city,
    ...over,
  };
}

function makeDuel(over: Record<string, unknown> = {}) {
  return {
    id: DUEL_ID,
    kind: 'DUEL',
    rated: true,
    bestOf: 5,
    status: 'OPEN',
    authorId: AUTHOR,
    challenge: false,
    opponentId: null,
    venueName: 'Школа №5',
    venueAddress: 'Абая 1',
    note: null,
    slotsFrom: SLOT_START,
    slotsUntil: SLOT_END,
    startsAt: null,
    endsAt: null,
    winnerId: null,
    winnerSets: null,
    loserSets: null,
    reportedById: null,
    reportedAt: null,
    confirmedAt: null,
    disputeComment: null,
    resolutionComment: null,
    ratingSkipped: null,
    provisional: null,
    annulledAt: null,
    annulReason: null,
    createdAt: NOW,
    author: side(AUTHOR),
    opponent: null,
    club: null,
    city,
    slots: [{ id: SLOT_ID, startsAt: SLOT_START, endsAt: SLOT_END }],
    _count: { responses: 0 },
    ...over,
  };
}

/** Назначенная рейтинговая дуэль Петров — Иванов. */
const scheduled = (over: Record<string, unknown> = {}) =>
  makeDuel({
    status: 'SCHEDULED',
    opponentId: OPPONENT,
    opponent: side(OPPONENT),
    startsAt: SLOT_START,
    endsAt: SLOT_END,
    ...over,
  });

/** Счёт 3:1 в пользу автора внёс автор. */
const reported = (over: Record<string, unknown> = {}) =>
  scheduled({
    status: 'REPORTED',
    winnerId: AUTHOR,
    winnerSets: 3,
    loserSets: 1,
    reportedById: AUTHOR,
    reportedAt: PLAYED,
    ...over,
  });

function makeResponse(over: Record<string, unknown> = {}) {
  return {
    id: RESPONSE_ID,
    duelId: DUEL_ID,
    playerId: OPPONENT,
    slotId: SLOT_ID,
    proposedStartsAt: null,
    proposedEndsAt: null,
    message: 'Давай',
    status: 'NEW',
    createdAt: NOW,
    slot: { startsAt: SLOT_START, endsAt: SLOT_END },
    player: side(OPPONENT),
    ...over,
  };
}

type Row = Record<string, unknown>;

/** Мок метода Prisma: ответ — обещание, как у настоящего клиента. */
function returns<A extends unknown[], R>(run: (...args: A) => R) {
  // Лишние аргументы не мешают: проверки читают `mock.calls` как есть.
  return vi.fn((...args: [...A, ...unknown[]]) => Promise.resolve(run(...(args as unknown as A))));
}

/** Событие MATCH дуэли — и для отмены начисления, и для страницы. */
function change(playerId: string, before: string, delta: string): Row {
  const from = new Prisma.Decimal(before);

  return {
    playerId,
    ratingBefore: from,
    delta: new Prisma.Decimal(delta),
    ratingAfter: from.plus(delta),
  };
}

function makePrisma() {
  const state = {
    duel: makeDuel() as Row,
    responses: [] as Row[],
    events: [] as Row[],
  };
  const users: Record<string, Row | null> = {
    [USER[AUTHOR]]: { player: { id: AUTHOR, lastName: 'Петров', firstName: 'Олег' } },
    [USER[OPPONENT]]: { player: { id: OPPONENT, lastName: 'Иванов', firstName: 'Пётр' } },
    [USER[STRANGER]]: { player: { id: STRANGER, lastName: 'Сидоров', firstName: 'Ким' } },
    [ADMIN_USER]: { player: null },
    [NO_PROFILE_USER]: { player: null },
  };
  const matches = (row: Row, where: Row): boolean =>
    (where.status === undefined || row.status === where.status) &&
    (where.playerId === undefined || row.playerId === where.playerId) &&
    ((where.id as { not?: string } | undefined)?.not === undefined ||
      row.id !== (where.id as { not: string }).not);

  const prisma = {
    user: {
      findUnique: returns(({ where }: { where: { id: string } }) => users[where.id] ?? null),
    },
    player: {
      findUnique: returns(({ where }: { where: { id: string } }) =>
        where.id in USER ? { id: where.id, userId: USER[where.id as keyof typeof USER] } : null,
      ),
      findMany: returns(() => [
        { id: AUTHOR, rating: new Prisma.Decimal('300'), ratedMatches: 25 },
        { id: OPPONENT, rating: new Prisma.Decimal('300'), ratedMatches: 25 },
      ]),
      update: returns(() => ({})),
    },
    club: { findUnique: returns(() => ({ cityId: CITY, hiddenAt: null })) },
    city: { findFirst: returns(() => ({ id: CITY })) },
    duel: {
      findUnique: returns(() => state.duel),
      findMany: returns((): Row[] => []),
      count: returns(() => 0),
      create: returns(() => ({ id: DUEL_ID })),
      updateMany: returns(() => ({ count: 1 })),
      update: returns(() => ({})),
    },
    duelResponse: {
      findUnique: returns(() => state.responses[0] ?? null),
      findFirst: returns(
        ({ where }: { where: Row }) => state.responses.find((row) => matches(row, where)) ?? null,
      ),
      findMany: returns(({ where }: { where: Row }) =>
        state.responses.filter((row) => matches(row, where)),
      ),
      count: returns(() => 0),
      create: returns(() => ({ id: RESPONSE_ID })),
      updateMany: returns(() => ({ count: 1 })),
    },
    ratingEvent: {
      findMany: returns(() => state.events),
      createMany: returns(() => ({ count: 2 })),
      create: returns(() => ({})),
    },
    notification: {
      createMany: returns(() => ({ count: 1 })),
      updateMany: returns(() => ({ count: 0 })),
    },
    auditLog: { create: returns(() => ({})) },
    $executeRaw: returns(() => 1),
    $queryRaw: returns(() => []),
    $transaction: vi.fn(),
  };

  prisma.$transaction.mockImplementation((run: (tx: typeof prisma) => unknown) => run(prisma));

  return { prisma, state };
}

let prisma: ReturnType<typeof makePrisma>['prisma'];
let state: ReturnType<typeof makePrisma>['state'];
let service: DuelsService;
let admin: DuelsAdminService;

beforeEach(() => {
  ({ prisma, state } = makePrisma());
  const db = prisma as unknown as PrismaService;
  const notifications = new NotificationsService(db);
  const rating = new DuelRatingService();

  service = new DuelsService(db, notifications, rating);
  admin = new DuelsAdminService(db, notifications, rating, service);
});

async function failure(run: Promise<unknown>): Promise<{ code: string; details: unknown }> {
  try {
    await run;
  } catch (error) {
    if (isAppError(error)) return { code: error.code, details: error.details };
    throw error;
  }

  throw new Error('ожидался отказ');
}

/** Все уведомления, записанные за тест: кому, что, с какими данными. */
function notified() {
  return prisma.notification.createMany.mock.calls.flatMap(
    (call: unknown[]) => (call[0] as { data: Row[] }).data,
  );
}

/** Данные условных переходов (`claimDuel`) — ленивые сроки сюда не входят. */
function transitions() {
  return prisma.duel.updateMany.mock.calls
    .map((call: unknown[]) => call[0] as { where: Row; data: Row })
    .filter((call) => call.where.id === DUEL_ID);
}

const input: CreateDuelInput = {
  kind: 'DUEL',
  rated: true,
  bestOf: 5,
  venueName: 'Школа №5',
  venueAddress: 'Абая 1',
  cityId: CITY,
  slots: [{ startsAt: SLOT_START.toISOString(), endsAt: SLOT_END.toISOString() }],
};

describe('предложение', () => {
  it('без профиля игрока — DUEL_PROFILE_REQUIRED', async () => {
    expect(await failure(service.create(NO_PROFILE_USER, input, NOW))).toMatchObject({
      code: 'DUEL_PROFILE_REQUIRED',
    });
  });

  it('вызвать себя нельзя, игрока без аккаунта — тоже', async () => {
    expect(
      await failure(service.create(USER[AUTHOR], { ...input, opponentId: AUTHOR }, NOW)),
    ).toEqual({ code: 'DUEL_OPPONENT_INVALID', details: { reason: 'SELF' } });

    prisma.player.findUnique.mockResolvedValueOnce({ id: STRANGER, userId: null } as never);

    expect(
      await failure(service.create(USER[AUTHOR], { ...input, opponentId: STRANGER }, NOW)),
    ).toEqual({ code: 'DUEL_OPPONENT_INVALID', details: { reason: 'NO_ACCOUNT' } });
  });

  it('время в прошлом или дальше 60 дней — DUEL_TIME_INVALID', async () => {
    const past = { startsAt: '2026-10-23T10:00:00.000Z', endsAt: '2026-10-23T12:00:00.000Z' };
    const far = { startsAt: '2027-01-01T10:00:00.000Z', endsAt: '2027-01-01T12:00:00.000Z' };

    for (const slot of [past, far]) {
      expect(
        await failure(service.create(USER[AUTHOR], { ...input, slots: [slot] }, NOW)),
      ).toMatchObject({ code: 'DUEL_TIME_INVALID' });
    }
    expect(prisma.duel.create).not.toHaveBeenCalled();
  });

  it('открытых публикаций не больше трёх', async () => {
    prisma.duel.count.mockResolvedValue(3);

    expect(await failure(service.create(USER[AUTHOR], input, NOW))).toEqual({
      code: 'DUEL_LIMIT',
      details: { kind: 'OPEN', limit: 3 },
    });
    expect(prisma.duel.count).toHaveBeenCalledWith({
      where: { authorId: AUTHOR, challenge: false, status: 'OPEN' },
    });
  });

  it('вызовов не больше десяти за сутки', async () => {
    prisma.duel.count.mockResolvedValue(10);

    expect(
      await failure(service.create(USER[AUTHOR], { ...input, opponentId: OPPONENT }, NOW)),
    ).toEqual({ code: 'DUEL_LIMIT', details: { kind: 'CHALLENGES', limit: 10 } });
  });

  it('вызов в клубе: город — клуба, вызванному уведомление', async () => {
    state.duel = makeDuel({
      status: 'CHALLENGE',
      challenge: true,
      opponentId: OPPONENT,
      opponent: side(OPPONENT),
    });

    const view = await service.create(
      USER[AUTHOR],
      {
        kind: 'DUEL',
        rated: true,
        bestOf: 5,
        clubId: CLUB_ID,
        opponentId: OPPONENT,
        slots: input.slots,
      },
      NOW,
    );

    expect(prisma.duel.create.mock.calls[0]?.[0]).toMatchObject({
      data: {
        status: 'CHALLENGE',
        challenge: true,
        authorId: AUTHOR,
        opponentId: OPPONENT,
        clubId: CLUB_ID,
        cityId: CITY,
        bestOf: 5,
        slotsFrom: SLOT_START,
        slotsUntil: SLOT_END,
        playAt: SLOT_START,
        slots: { create: [{ startsAt: SLOT_START, endsAt: SLOT_END }] },
      },
    });
    expect(notified()).toEqual([
      {
        userId: USER[OPPONENT],
        type: 'DUEL_CHALLENGE',
        data: { duelId: DUEL_ID, kind: 'DUEL', playerName: 'Петров Олег', rated: true },
      },
    ]);
    expect(duelViewSchema.parse(view).status).toBe('CHALLENGE');
  });
});

describe('ответ на вызов', () => {
  beforeEach(() => {
    state.duel = makeDuel({
      status: 'CHALLENGE',
      challenge: true,
      opponentId: OPPONENT,
      opponent: side(OPPONENT),
    });
  });

  it('вызванный выбрал вариант автора — дуэль назначена сразу', async () => {
    await service.respond(DUEL_ID, USER[OPPONENT], { slotId: SLOT_ID }, NOW);

    expect(transitions()).toEqual([
      {
        where: { id: DUEL_ID, status: { in: ['CHALLENGE'] } },
        data: {
          status: 'SCHEDULED',
          startsAt: SLOT_START,
          endsAt: SLOT_END,
          playAt: SLOT_START,
        },
      },
    ]);
    expect(prisma.duelResponse.create.mock.calls[0]?.[0]).toMatchObject({
      data: { playerId: OPPONENT, slotId: SLOT_ID, status: 'ACCEPTED', answeredAt: NOW },
    });
    expect(notified()).toEqual([
      {
        userId: USER[AUTHOR],
        type: 'DUEL_SCHEDULED',
        data: {
          duelId: DUEL_ID,
          kind: 'DUEL',
          playerName: 'Иванов Пётр',
          startsAt: SLOT_START.toISOString(),
        },
      },
    ]);
  });

  it('своё время — новый отклик, решает автор', async () => {
    await service.respond(
      DUEL_ID,
      USER[OPPONENT],
      { proposed: { startsAt: '2026-10-27T15:00:00.000Z', endsAt: '2026-10-27T17:00:00.000Z' } },
      NOW,
    );

    expect(transitions()).toEqual([]);
    expect(prisma.duelResponse.create.mock.calls[0]?.[0]).toMatchObject({
      data: { slotId: null, status: 'NEW' },
    });
    expect(notified()[0]).toMatchObject({
      userId: USER[AUTHOR],
      type: 'DUEL_RESPONSE',
      data: { responseId: RESPONSE_ID },
    });
  });

  it('предел частоты — DUEL_RATING_LIMIT, дуэль не назначается', async () => {
    // У пары уже есть рейтинговая встреча за три дня до этой.
    prisma.duel.findMany.mockResolvedValue([
      {
        authorId: OPPONENT,
        opponentId: AUTHOR,
        startsAt: new Date(SLOT_START.getTime() - 72 * HOUR_MS),
      },
    ]);

    expect(
      await failure(service.respond(DUEL_ID, USER[OPPONENT], { slotId: SLOT_ID }, NOW)),
    ).toEqual({ code: 'DUEL_RATING_LIMIT', details: { kind: 'PAIR', playerId: null } });
    expect(transitions()).toEqual([]);
    expect(prisma.duelResponse.create).not.toHaveBeenCalled();
    // Строки обоих под замком: две одновременные проверки не проскочат вдвоём.
    expect(prisma.$queryRaw).toHaveBeenCalled();
  });

  it('отвечает только вызванный; автор себе — тоже нет', async () => {
    expect(
      await failure(service.respond(DUEL_ID, USER[STRANGER], { slotId: SLOT_ID }, NOW)),
    ).toMatchObject({ code: 'FORBIDDEN' });
    expect(
      await failure(service.respond(DUEL_ID, USER[AUTHOR], { slotId: SLOT_ID }, NOW)),
    ).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('отказ вызванного — DECLINED, автору уведомление', async () => {
    await service.decline(DUEL_ID, USER[OPPONENT], { reason: 'Уезжаю' }, NOW);

    expect(transitions()[0]?.data).toEqual({
      status: 'DECLINED',
      closeReason: 'Уезжаю',
      closedAt: NOW,
    });
    expect(notified()).toEqual([
      {
        userId: USER[AUTHOR],
        type: 'DUEL_DECLINED',
        data: { duelId: DUEL_ID, kind: 'DUEL', playerName: 'Иванов Пётр', reason: 'DECLINED' },
      },
    ]);
  });
});

describe('отклики на публикацию', () => {
  it('второй открытый отклик — DUEL_RESPONSE_EXISTS', async () => {
    state.responses = [makeResponse({ playerId: STRANGER, player: side(STRANGER) })];

    expect(
      await failure(service.respond(DUEL_ID, USER[STRANGER], { slotId: SLOT_ID }, NOW)),
    ).toEqual({ code: 'DUEL_RESPONSE_EXISTS', details: { id: RESPONSE_ID } });
  });

  it('откликов не больше двадцати за сутки', async () => {
    prisma.duelResponse.count.mockResolvedValue(20);

    expect(
      await failure(service.respond(DUEL_ID, USER[STRANGER], { slotId: SLOT_ID }, NOW)),
    ).toEqual({ code: 'DUEL_LIMIT', details: { kind: 'RESPONSES', limit: 20 } });
  });

  it('автор принял один — дуэль назначена, остальным «соперник найден»', async () => {
    state.responses = [
      makeResponse(),
      makeResponse({ id: OTHER_RESPONSE_ID, playerId: STRANGER, player: side(STRANGER) }),
    ];

    await service.accept(RESPONSE_ID, USER[AUTHOR], NOW);

    expect(transitions()[0]).toEqual({
      where: { id: DUEL_ID, status: { in: ['OPEN', 'CHALLENGE'] } },
      data: {
        status: 'SCHEDULED',
        opponentId: OPPONENT,
        startsAt: SLOT_START,
        endsAt: SLOT_END,
        playAt: SLOT_START,
      },
    });
    expect(prisma.duelResponse.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [OTHER_RESPONSE_ID] }, status: 'NEW' },
      data: { status: 'DECLINED', answeredAt: NOW },
    });
    expect(notified()).toEqual([
      {
        userId: USER[STRANGER],
        type: 'DUEL_DECLINED',
        data: { duelId: DUEL_ID, kind: 'DUEL', playerName: 'Петров Олег', reason: 'TAKEN' },
      },
      {
        userId: USER[OPPONENT],
        type: 'DUEL_SCHEDULED',
        data: {
          duelId: DUEL_ID,
          kind: 'DUEL',
          playerName: 'Петров Олег',
          startsAt: SLOT_START.toISOString(),
        },
      },
    ]);
  });

  it('принимать — только автору', async () => {
    state.responses = [makeResponse()];

    expect(await failure(service.accept(RESPONSE_ID, USER[STRANGER], NOW))).toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('страница и доступные действия', () => {
  beforeEach(() => {
    state.responses = [
      makeResponse(),
      makeResponse({ id: OTHER_RESPONSE_ID, playerId: STRANGER, player: side(STRANGER) }),
    ];
    state.duel = makeDuel({ _count: { responses: 2 } });
  });

  it('автор видит все отклики и их число', async () => {
    const view = duelViewSchema.parse(await service.view(DUEL_ID, USER[AUTHOR], NOW));

    expect(view.responses.map((response) => response.id)).toEqual([RESPONSE_ID, OTHER_RESPONSE_ID]);
    expect(view.responsesNew).toBe(2);
    expect(view.can).toMatchObject({ respond: false, cancel: true, withdraw: false });
  });

  it('откликнувшийся — только свой, может отозвать', async () => {
    const view = duelViewSchema.parse(await service.view(DUEL_ID, USER[STRANGER], NOW));

    expect(view.responses.map((response) => response.id)).toEqual([OTHER_RESPONSE_ID]);
    expect(view.responsesNew).toBeNull();
    expect(view.can).toMatchObject({ respond: false, withdraw: true, cancel: false });
  });

  it('аноним — ни откликов, ни действий', async () => {
    const view = duelViewSchema.parse(await service.view(DUEL_ID, undefined, NOW));

    expect(view.responses).toEqual([]);
    expect(Object.values(view.can).every((value) => !value)).toBe(true);
  });
});

describe('счёт', () => {
  it('раньше начала — DUEL_TIME_INVALID', async () => {
    state.duel = scheduled();

    expect(
      await failure(
        service.report(
          DUEL_ID,
          USER[AUTHOR],
          { winnerId: AUTHOR, winnerSets: 3, loserSets: 1 },
          NOW,
        ),
      ),
    ).toMatchObject({ code: 'DUEL_TIME_INVALID' });
  });

  it('не по формату — DUEL_SCORE_INVALID с числом нужных побед', async () => {
    state.duel = scheduled();

    expect(
      await failure(
        service.report(
          DUEL_ID,
          USER[AUTHOR],
          { winnerId: AUTHOR, winnerSets: 2, loserSets: 1 },
          PLAYED,
        ),
      ),
    ).toEqual({ code: 'DUEL_SCORE_INVALID', details: { setsToWin: 3 } });
  });

  it('у нерейтингового спарринга счёта нет', async () => {
    state.duel = scheduled({ kind: 'SPARRING', rated: false, bestOf: null });

    expect(
      await failure(
        service.report(
          DUEL_ID,
          USER[AUTHOR],
          { winnerId: AUTHOR, winnerSets: 3, loserSets: 1 },
          PLAYED,
        ),
      ),
    ).toMatchObject({ code: 'DUEL_INVALID_STATE', details: { status: 'SCHEDULED' } });
  });

  it('внесён — REPORTED, второму «подтвердите» его партиями первыми', async () => {
    state.duel = scheduled();

    await service.report(
      DUEL_ID,
      USER[AUTHOR],
      { winnerId: AUTHOR, winnerSets: 3, loserSets: 1 },
      PLAYED,
    );

    expect(transitions()[0]?.data).toEqual({
      status: 'REPORTED',
      winnerId: AUTHOR,
      winnerSets: 3,
      loserSets: 1,
      reportedById: AUTHOR,
      reportedAt: PLAYED,
    });
    expect(notified()).toEqual([
      {
        userId: USER[OPPONENT],
        type: 'DUEL_RESULT',
        data: {
          duelId: DUEL_ID,
          kind: 'DUEL',
          playerName: 'Петров Олег',
          setsFor: 1,
          setsAgainst: 3,
          confirmBy: new Date(PLAYED.getTime() + 48 * HOUR_MS).toISOString(),
        },
      },
    ]);
  });

  it('подтверждение — рейтинг с T = 0.5, события со ссылкой на дуэль, проекция', async () => {
    state.duel = reported();
    const later = new Date(PLAYED.getTime() + HOUR_MS);

    await service.confirm(DUEL_ID, USER[OPPONENT], later);

    const expected = calculateMatch({
      winner: { rating: 300, ratedMatches: 25 },
      loser: { rating: 300, ratedMatches: 25 },
      winnerSets: 3,
      loserSets: 1,
      level: 'DUEL',
      resultType: 'NORMAL',
    });
    const events = (prisma.ratingEvent.createMany.mock.calls[0]?.[0] as { data: Row[] }).data;

    expect(expected.factors.levelFactor).toBe(0.5);
    expect(events).toEqual([
      expect.objectContaining({
        playerId: AUTHOR,
        duelId: DUEL_ID,
        type: 'MATCH',
        ratingBefore: 300,
        delta: expected.winnerDelta,
        tFactor: 0.5,
        createdBy: USER[OPPONENT],
      }),
      expect.objectContaining({
        playerId: OPPONENT,
        duelId: DUEL_ID,
        type: 'MATCH',
        delta: expected.loserDelta,
        tFactor: 0.5,
      }),
    ]);
    expect(events.every((event) => !('matchId' in event) && !('tournamentId' in event))).toBe(true);
    expect(prisma.player.update).toHaveBeenCalledWith({
      where: { id: AUTHOR },
      data: {
        rating: applyDelta(300, expected.winnerDelta).rating,
        ratedMatches: 26,
        isProvisional: false,
      },
      select: { id: true },
    });
    expect(transitions()[0]).toEqual({
      where: {
        reportedAt: { gt: new Date(later.getTime() - 48 * HOUR_MS) },
        id: DUEL_ID,
        status: { in: ['REPORTED'] },
      },
      data: { status: 'COMPLETED', confirmedAt: later },
    });
    expect(notified()).toEqual([
      {
        userId: USER[AUTHOR],
        type: 'DUEL_COMPLETED',
        data: {
          duelId: DUEL_ID,
          kind: 'DUEL',
          playerName: 'Иванов Пётр',
          delta: new Prisma.Decimal(expected.winnerDelta).toString(),
        },
      },
    ]);
  });

  it('предел частоты при начислении — сыграно без рейтинга', async () => {
    state.duel = reported();
    prisma.duel.findMany.mockResolvedValue([
      {
        authorId: AUTHOR,
        opponentId: OPPONENT,
        startsAt: new Date(SLOT_START.getTime() - HOUR_MS * 24),
      },
    ]);

    await service.confirm(DUEL_ID, USER[OPPONENT], PLAYED);

    expect(prisma.ratingEvent.createMany).not.toHaveBeenCalled();
    expect(prisma.duel.update).toHaveBeenCalledWith({
      where: { id: DUEL_ID },
      data: { ratingSkipped: 'PAIR' },
      select: { id: true },
    });
    expect(notified()[0]).toMatchObject({ type: 'DUEL_COMPLETED', data: { delta: null } });
  });

  it('внёсший сам не подтверждает', async () => {
    state.duel = reported();

    expect(await failure(service.confirm(DUEL_ID, USER[AUTHOR], PLAYED))).toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('48 часов прошло — счёт лениво становится UNCONFIRMED', async () => {
    const late = new Date(PLAYED.getTime() + 49 * HOUR_MS);

    await service.view(DUEL_ID, undefined, late);

    expect(prisma.duel.updateMany).toHaveBeenCalledWith({
      where: { status: 'REPORTED', reportedAt: { lte: new Date(late.getTime() - 48 * HOUR_MS) } },
      data: { status: 'UNCONFIRMED', closedAt: late },
    });
  });

  it('подтверждение после срока — DUEL_INVALID_STATE, рейтинг не трогается', async () => {
    state.duel = reported();
    // Условный переход не нашёл дуэль в REPORTED со свежим счётом.
    prisma.duel.updateMany.mockImplementation((({ where }: { where: Row }) =>
      Promise.resolve({ count: where.id === DUEL_ID ? 0 : 1 })) as never);
    prisma.duel.findUnique.mockResolvedValueOnce(state.duel);
    prisma.duel.findUnique.mockResolvedValueOnce({ status: 'UNCONFIRMED' });

    expect(await failure(service.confirm(DUEL_ID, USER[OPPONENT], PLAYED))).toEqual({
      code: 'DUEL_INVALID_STATE',
      details: { status: 'UNCONFIRMED' },
    });
    expect(prisma.ratingEvent.createMany).not.toHaveBeenCalled();
  });
});

describe('спор и администратор', () => {
  it('оспорил — DISPUTED, внёсшему уведомление', async () => {
    state.duel = reported();

    await service.dispute(DUEL_ID, USER[OPPONENT], { comment: 'Было 3:2 мне' }, PLAYED);

    expect(transitions()[0]?.data).toEqual({
      status: 'DISPUTED',
      disputeComment: 'Было 3:2 мне',
      disputedAt: PLAYED,
    });
    expect(notified()).toEqual([
      {
        userId: USER[AUTHOR],
        type: 'DUEL_DISPUTED',
        data: { duelId: DUEL_ID, kind: 'DUEL', playerName: 'Иванов Пётр' },
      },
    ]);
  });

  it('решение со счётом — обсчитано как подтверждённое, обоим уведомление', async () => {
    state.duel = reported({ status: 'DISPUTED', disputeComment: 'Было 3:2 мне' });

    await admin.resolve(
      DUEL_ID,
      ADMIN_USER,
      { result: { winnerId: OPPONENT, winnerSets: 3, loserSets: 2 }, comment: 'По видео' },
      PLAYED,
    );

    expect(transitions()[0]?.data).toMatchObject({
      status: 'COMPLETED',
      winnerId: OPPONENT,
      winnerSets: 3,
      loserSets: 2,
      resolutionComment: 'По видео',
      resolvedById: ADMIN_USER,
    });

    const events = (prisma.ratingEvent.createMany.mock.calls[0]?.[0] as { data: Row[] }).data;

    expect(events[0]).toMatchObject({ playerId: OPPONENT, duelId: DUEL_ID, createdBy: ADMIN_USER });
    expect(notified().map((row) => [row.userId, row.type])).toEqual([
      [USER[AUTHOR], 'DUEL_COMPLETED'],
      [USER[OPPONENT], 'DUEL_COMPLETED'],
    ]);
    expect(notified()[1]).toMatchObject({ data: { playerName: 'Петров Олег' } });
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  it('решение без счёта — CANCELLED, рейтинг не меняется', async () => {
    state.duel = reported({ status: 'DISPUTED' });

    await admin.resolve(DUEL_ID, ADMIN_USER, { comment: 'Не играли' }, PLAYED);

    expect(transitions()[0]?.data).toMatchObject({ status: 'CANCELLED' });
    expect(prisma.ratingEvent.createMany).not.toHaveBeenCalled();
    expect(notified().every((row) => (row.data as Row).delta === null)).toBe(true);
  });

  it('решать можно только спор', async () => {
    state.duel = reported();

    expect(await failure(admin.resolve(DUEL_ID, ADMIN_USER, { comment: 'x' }, PLAYED))).toEqual({
      code: 'DUEL_INVALID_STATE',
      details: { status: 'REPORTED' },
    });
  });

  it('отмена начисления — обратные события MANUAL_ADJUST обоим со ссылкой и причиной', async () => {
    state.duel = reported({ status: 'COMPLETED', confirmedAt: PLAYED });
    state.events = [change(AUTHOR, '305.75', '4.5'), change(OPPONENT, '6.5', '-4.5')];
    prisma.player.findMany.mockResolvedValue([
      { id: AUTHOR, rating: new Prisma.Decimal('310.25'), ratedMatches: 26 },
      // Проигравший опустился к самому низу: возврат применяется как есть.
      { id: OPPONENT, rating: new Prisma.Decimal('2'), ratedMatches: 26 },
    ]);

    await admin.annul(DUEL_ID, ADMIN_USER, { reason: 'Договорная' }, PLAYED);

    expect(transitions()[0]).toEqual({
      where: { annulledAt: null, id: DUEL_ID, status: { in: ['COMPLETED'] } },
      data: { annulledAt: PLAYED, annulReason: 'Договорная', annulledById: ADMIN_USER },
    });
    expect(
      prisma.ratingEvent.create.mock.calls.map(
        (call: unknown[]) => (call[0] as { data: Row }).data,
      ),
    ).toEqual([
      {
        playerId: AUTHOR,
        duelId: DUEL_ID,
        type: 'MANUAL_ADJUST',
        ratingBefore: 310.25,
        delta: -4.5,
        ratingAfter: 305.75,
        clamped: false,
        reason: 'Договорная',
        createdBy: ADMIN_USER,
      },
      {
        playerId: OPPONENT,
        duelId: DUEL_ID,
        type: 'MANUAL_ADJUST',
        ratingBefore: 2,
        delta: 4.5,
        ratingAfter: 6.5,
        clamped: false,
        reason: 'Договорная',
        createdBy: ADMIN_USER,
      },
    ]);
    expect(prisma.player.update).toHaveBeenCalledWith({
      where: { id: AUTHOR },
      data: { rating: 305.75 },
      select: { id: true },
    });
  });

  it('обратная дельта упирается в MIN_RATING — снимается сколько есть', async () => {
    state.duel = reported({ status: 'COMPLETED' });
    state.events = [change(AUTHOR, '5', '10')];
    prisma.player.findMany.mockResolvedValue([
      { id: AUTHOR, rating: new Prisma.Decimal('5'), ratedMatches: 26 },
    ]);

    await admin.annul(DUEL_ID, ADMIN_USER, { reason: 'Договорная' }, PLAYED);

    expect(prisma.ratingEvent.create.mock.calls[0]?.[0]).toMatchObject({
      data: { ratingBefore: 5, delta: -4, ratingAfter: 1, clamped: true },
    });
  });

  it('второй раз не отменяется', async () => {
    state.duel = reported({ status: 'COMPLETED', annulledAt: PLAYED });

    expect(await failure(admin.annul(DUEL_ID, ADMIN_USER, { reason: 'x' }, PLAYED))).toMatchObject({
      code: 'DUEL_INVALID_STATE',
    });
  });

  it('очередь: пометки и счёт пары за 30 дней', async () => {
    state.duel = reported({ status: 'COMPLETED', provisional: true });
    prisma.duel.findMany.mockImplementation((({ where }: { where: Row }) =>
      Promise.resolve(
        where.rated === true &&
          'status' in where &&
          !('id' in where) &&
          where.startsAt === undefined
          ? [state.duel]
          : [
              {
                id: 'p1',
                authorId: OPPONENT,
                opponentId: AUTHOR,
                startsAt: new Date(SLOT_START.getTime() - 7 * 24 * HOUR_MS),
                winnerId: AUTHOR,
              },
              {
                id: 'p2',
                authorId: AUTHOR,
                opponentId: OPPONENT,
                startsAt: new Date(SLOT_START.getTime() - 14 * 24 * HOUR_MS),
                winnerId: AUTHOR,
              },
            ],
      )) as never);
    prisma.duel.count.mockResolvedValue(1);

    const page = await admin.list({ page: 1, limit: 20, status: 'COMPLETED' }, PLAYED);

    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      id: DUEL_ID,
      flags: ['PAIR_FREQUENT', 'ONE_SIDED', 'PROVISIONAL'],
      pairCount30d: 3,
      responsesNew: null,
    });
  });
});
