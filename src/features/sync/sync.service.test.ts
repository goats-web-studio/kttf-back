import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import type { SyncOperation } from '@kttf/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import type { MatchesService } from '../matches/matches.service.js';
import type { TournamentsService } from '../tournaments/tournaments.service.js';

import { SyncService } from './sync.service.js';

/**
 * Синхронизация офлайн-очереди — ТС 6.3, ADR-026.
 *
 * Проверяется поведение приёмника, а не правила турнира: их применяют те же
 * сервисы, что и онлайн-маршруты, и покрыты они там. Здесь важно другое —
 * порядок, идемпотентность и то, что одна отклонённая операция не отменяет
 * остальные три часа работы судьи.
 */

const TOURNAMENT_ID = '00000000-0000-4000-8000-000000000001';
const CLUB_ID = '00000000-0000-4000-8000-000000000002';
const MATCH_ID = '00000000-0000-4000-8000-000000000003';
const OTHER_MATCH = '00000000-0000-4000-8000-000000000004';
const USER_ID = '00000000-0000-4000-8000-000000000005';

function op(seq: number, over: Partial<SyncOperation> = {}): SyncOperation {
  return {
    clientOpId: `00000000-0000-4000-8000-00000000010${String(seq)}`,
    seq,
    createdAt: '2026-09-02T10:00:00.000Z',
    type: 'MATCH_RESULT',
    matchId: MATCH_ID,
    payload: { setsA: 3, setsB: 1, resultType: 'NORMAL' },
    ...over,
  } as SyncOperation;
}

/** Запись турнира в том виде, в каком её читает маппер. */
const tournamentRow = {
  id: TOURNAMENT_ID,
  clubId: CLUB_ID,
  name: 'Кубок клуба',
  startsAt: new Date('2026-09-02T10:00:00.000Z'),
  registrationEndsAt: null,
  status: 'RUNNING',
  entryFee: 0,
  maxParticipants: null,
  ratingCapMax: null,
  ratingCapMin: null,
  birthYearFrom: null,
  birthYearTo: null,
  genderLimit: null,
  level: 'CLUB',
  tableCount: 4,
  formatConfig: { type: 'ROUND_ROBIN', rounds: 1, setsToWin: 3 },
  seedingConfig: null,
  description: null,
  prizeInfo: null,
  publicToken: 'FDgV6mQ1xKq8yZ2pW7nR4tL0sB3cH5jE',
  version: 7,
  createdAt: new Date('2026-09-01T08:00:00.000Z'),
  startedAt: new Date('2026-09-02T10:00:00.000Z'),
  finishedAt: null,
  ratedAt: null,
  _count: { registrations: 0 },
};

/** Тела записей журнала: по ним видно, что и с какой версией снимка записано. */
let written: Record<string, unknown>[];

/** Строки журнала синхронизации: по ним и проверяется идемпотентность. */
let journal: {
  id: string;
  clientOpId: string;
  appliedAt: Date | null;
  rejectedReason: string | null;
}[];

function makePrisma() {
  return {
    tournament: {
      findUnique: vi.fn(() => Promise.resolve(tournamentRow)),
    },
    clubMember: { findUnique: vi.fn(() => Promise.resolve({ role: 'REFEREE' })) },
    match: {
      findUnique: vi.fn((args: { where: { id: string } }) =>
        Promise.resolve(
          args.where.id === MATCH_ID ? { tournamentId: TOURNAMENT_ID } : { tournamentId: 'чужой' },
        ),
      ),
    },
    stage: { findMany: vi.fn(() => Promise.resolve([])) },
    registration: { findMany: vi.fn(() => Promise.resolve([])) },
    syncOperation: {
      findUnique: vi.fn((args: { where: { tournamentId_clientOpId: { clientOpId: string } } }) =>
        Promise.resolve(
          journal.find((row) => row.clientOpId === args.where.tournamentId_clientOpId.clientOpId) ??
            null,
        ),
      ),
      create: vi.fn((args: { data: Record<string, unknown> }) => {
        const row = {
          id: `row-${String(journal.length)}`,
          clientOpId: String(args.data.clientOpId),
          appliedAt: null,
          rejectedReason: null,
        };

        written.push(args.data);
        journal.push(row);

        return Promise.resolve(row);
      }),
      update: vi.fn((args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = journal.find((current) => current.id === args.where.id);

        if (row !== undefined) Object.assign(row, args.data);

        return Promise.resolve(row);
      }),
    },
  };
}

let prisma: ReturnType<typeof makePrisma>;
let matches: {
  assign: ReturnType<typeof vi.fn>;
  result: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
};
let tournaments: {
  resolveTie: ReturnType<typeof vi.fn>;
  updateRegistration: ReturnType<typeof vi.fn>;
};
let service: SyncService;

beforeEach(() => {
  journal = [];
  written = [];
  prisma = makePrisma();
  matches = {
    assign: vi.fn(() => Promise.resolve({})),
    result: vi.fn(() => Promise.resolve({})),
    update: vi.fn(() => Promise.resolve({})),
    cancel: vi.fn(() => Promise.resolve({})),
  };
  tournaments = {
    resolveTie: vi.fn(() => Promise.resolve({})),
    updateRegistration: vi.fn(() => Promise.resolve({})),
  };
  service = new SyncService(
    prisma as unknown as PrismaService,
    matches as unknown as MatchesService,
    tournaments as unknown as TournamentsService,
  );
});

function sync(operations: readonly SyncOperation[], lastServerVersion = 5) {
  return service.sync(TOURNAMENT_ID, { lastServerVersion, operations: [...operations] }, USER_ID);
}

describe('применение очереди', () => {
  it('операции применяются по seq, а не по порядку в теле запроса', async () => {
    await sync([
      op(3, { type: 'MATCH_CANCEL', matchId: MATCH_ID, payload: undefined }),
      op(1, { type: 'MATCH_ASSIGN', matchId: MATCH_ID, payload: { tableNumber: 2 } }),
      op(2),
    ]);

    // Отправка не гарантирует порядка, а «поставить на стол — записать счёт —
    // отменить» и «отменить — поставить — записать» дают разное состояние.
    expect(matches.assign.mock.invocationCallOrder[0]).toBeLessThan(
      matches.result.mock.invocationCallOrder[0] ?? 0,
    );
    expect(matches.result.mock.invocationCallOrder[0]).toBeLessThan(
      matches.cancel.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('счёт уходит тем же методом, что и онлайн-маршрут', async () => {
    await sync([op(1)]);

    // Второго описания правил ввода счёта в системе нет — запрет №2 брифа.
    expect(matches.result).toHaveBeenCalledWith(
      MATCH_ID,
      { setsA: 3, setsB: 1, resultType: 'NORMAL' },
      USER_ID,
    );
  });

  it('каждый тип операции идёт своим методом', async () => {
    await sync([
      op(1, { type: 'MATCH_ASSIGN', payload: { tableNumber: 1 } }),
      op(2, { type: 'MATCH_EDIT', payload: { setsA: 3, setsB: 2, resultType: 'NORMAL' } }),
      op(3, { type: 'MATCH_CANCEL', payload: undefined }),
      op(4, {
        type: 'TIE_DECISION',
        matchId: undefined,
        payload: { groupId: CLUB_ID, orderedIds: [MATCH_ID, OTHER_MATCH] },
      }),
      op(5, {
        type: 'PLAYER_WITHDRAW',
        matchId: undefined,
        registrationId: OTHER_MATCH,
        payload: { status: 'WITHDRAWN' },
      }),
    ]);

    expect(matches.assign).toHaveBeenCalledTimes(1);
    expect(matches.update).toHaveBeenCalledTimes(1);
    expect(matches.cancel).toHaveBeenCalledTimes(1);
    expect(tournaments.resolveTie).toHaveBeenCalledTimes(1);
    expect(tournaments.updateRegistration).toHaveBeenCalledTimes(1);
  });

  it('пустая пачка приносит снимок и версию', async () => {
    // Синхронизация по таймеру идёт и тогда, когда судья ничего не вводил.
    const result = await sync([]);

    expect(result.serverVersion).toBe(7);
    expect(result.snapshot.version).toBe(7);
    expect(result.applied).toEqual([]);
  });
});

describe('идемпотентность', () => {
  it('повторная отправка применённой операции не применяет её второй раз', async () => {
    const operation = op(1);

    await sync([operation]);
    const again = await sync([operation]);

    // Мигающая сеть — обычное дело в зале: ответ теряется, консоль шлёт
    // очередь заново. Счёт от этого не должен записаться дважды.
    expect(matches.result).toHaveBeenCalledTimes(1);
    expect(again.applied).toEqual([operation.clientOpId]);
  });

  it('повторная отправка отклонённой операции возвращает тот же отказ', async () => {
    matches.result.mockRejectedValue(
      new AppError(ERROR_CODES.MATCH_ALREADY_FINISHED, 'Match already has a result'),
    );

    const operation = op(1);
    await sync([operation]);
    const again = await sync([operation]);

    expect(matches.result).toHaveBeenCalledTimes(1);
    expect(again.rejected).toEqual([
      { clientOpId: operation.clientOpId, reason: 'MATCH_ALREADY_FINISHED' },
    ]);
  });

  it('прерванная попытка применяется заново', async () => {
    // Обрыв между применением и отметкой оставляет запись без исхода. Все типы
    // операций задают состояние, а не приращение, поэтому повтор безопасен.
    journal.push({
      id: 'row-0',
      clientOpId: op(1).clientOpId,
      appliedAt: null,
      rejectedReason: null,
    });

    const result = await sync([op(1)]);

    expect(matches.result).toHaveBeenCalledTimes(1);
    expect(result.applied).toHaveLength(1);
  });
});

describe('отказы', () => {
  it('отклонённая операция не останавливает пачку', async () => {
    matches.assign.mockRejectedValue(
      new AppError(ERROR_CODES.MATCH_NOT_READY, 'Participants are unknown'),
    );

    const result = await sync([
      op(1, { type: 'MATCH_ASSIGN', payload: { tableNumber: 1 } }),
      op(2),
    ]);

    // Судья, у которого одна встреча уехала в отказ, не должен потерять
    // остальное введённое за турнир.
    expect(result.rejected).toHaveLength(1);
    expect(result.applied).toHaveLength(1);
    expect(matches.result).toHaveBeenCalledTimes(1);
  });

  it('неожиданная ошибка наружу уходит внутренней, а не своим текстом', async () => {
    matches.result.mockRejectedValue(new Error('connection string leaked'));

    const result = await sync([op(1)]);

    expect(result.rejected[0]?.reason).toBe('INTERNAL_ERROR');
  });

  it('встреча чужого турнира отклоняется', async () => {
    // Иначе очередь одного турнира стала бы способом править соседний:
    // право проверяется по клубу, а клуб проводит турниры каждую неделю.
    const result = await sync([op(1, { matchId: OTHER_MATCH })]);

    expect(matches.result).not.toHaveBeenCalled();
    expect(result.rejected[0]?.reason).toBe('NOT_FOUND');
  });

  it('без права вести консоль пачка не принимается', async () => {
    prisma.clubMember.findUnique.mockResolvedValue(null);

    await expect(sync([op(1)])).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(matches.result).not.toHaveBeenCalled();
  });

  it('неизвестный турнир — отказ NOT_FOUND', async () => {
    prisma.tournament.findUnique.mockResolvedValue(null);

    await expect(sync([op(1)])).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('журнал синхронизации', () => {
  it('операция записывается до применения, с версией снимка судьи', async () => {
    await sync([op(1)], 42);

    expect(written[0]).toMatchObject({ basedOnVersion: 42, actorId: USER_ID, seq: 1 });
    // Порядок важен: запись после применения потерялась бы при обрыве, и
    // повторная отправка применила бы счёт дважды (ADR-026).
    expect(prisma.syncOperation.create.mock.invocationCallOrder[0]).toBeLessThan(
      matches.result.mock.invocationCallOrder[0] ?? 0,
    );
  });
});
