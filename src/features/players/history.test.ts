import { describe, expect, it } from 'vitest';

import { Prisma } from '../../generated/prisma/client.js';

import {
  buildRatingPoints,
  chainBounds,
  summarize,
  toPlayerMatch,
  type PlayerMatchRow,
  type RatingEventRow,
} from './history.js';

/**
 * История игрока — ТЗ 9.3.
 *
 * Главное здесь — восстановление порядка событий турнира. Журнал его не
 * хранит: все записи вставляются одним `createMany` и получают одинаковый
 * `createdAt` (ADR-022). Ошибись в восстановлении — и на графике игрока
 * турнир даст неверную дельту.
 */

const TOURNAMENT_ID = '00000000-0000-4000-8000-000000000001';
const PLAYER_ID = '00000000-0000-4000-8000-000000000002';
const OPPONENT_ID = '00000000-0000-4000-8000-000000000003';

/** Все события турнира получают одно время — так их пишет обсчёт. */
const WRITTEN_AT = new Date('2026-09-02T12:00:00.000Z');

function event(
  before: string,
  delta: string,
  after: string,
  over: Partial<RatingEventRow> = {},
): RatingEventRow {
  return {
    tournamentId: TOURNAMENT_ID,
    ratingBefore: new Prisma.Decimal(before),
    delta: new Prisma.Decimal(delta),
    ratingAfter: new Prisma.Decimal(after),
    createdAt: WRITTEN_AT,
    tournament: { name: 'Кубок клуба', startsAt: new Date('2026-09-02T10:00:00.000Z') },
    ...over,
  };
}

describe('порядок событий турнира', () => {
  it('цепочка восстанавливается по значениям, а не по времени', () => {
    // Порядок в массиве нарочно перепутан: время у всех одинаковое.
    const bounds = chainBounds([
      event('255.00', '10.00', '265.00'),
      event('250.00', '5.00', '255.00'),
      event('265.00', '-3.00', '262.00'),
    ]);

    expect(bounds.before.toString()).toBe('250');
    expect(bounds.after.toString()).toBe('262');
  });

  it('нулевая дельта цепочку не рвёт', () => {
    // Разрыв в 100 очков даёт нулевое изменение (ТЗ 7), и такое событие
    // выглядит как «250 → 250».
    const bounds = chainBounds([
      event('250.00', '0.00', '250.00'),
      event('250.00', '8.00', '258.00'),
    ]);

    expect(bounds.before.toString()).toBe('250');
    expect(bounds.after.toString()).toBe('258');
  });

  it('неоднозначная цепочка сворачивается суммой дельт', () => {
    // Две одинаковые нулевые записи различить нечем. Сумма даёт тот же итог,
    // и это честнее, чем выбрать одну из них наугад.
    const bounds = chainBounds([
      event('250.00', '0.00', '250.00'),
      event('250.00', '0.00', '250.00'),
    ]);

    expect(bounds.after.toString()).toBe('250');
  });

  it('единственное событие — само себе начало и конец', () => {
    const bounds = chainBounds([event('250.00', '5.25', '255.25')]);

    expect(bounds.before.toString()).toBe('250');
    expect(bounds.after.toString()).toBe('255.25');
  });
});

describe('кривая рейтинга', () => {
  it('турнир даёт одну точку, а не точку на встречу', () => {
    const points = buildRatingPoints([
      event('250.00', '5.00', '255.00'),
      event('255.00', '10.00', '265.00'),
    ]);

    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      ratingBefore: '250',
      ratingAfter: '265',
      delta: '15',
      matches: 2,
    });
  });

  it('точка стоит на дате турнира, а не на дате обсчёта', () => {
    // Обсчёт идёт после последней встречи, иногда на следующий день. На
    // графике турнир обязан стоять там, когда он игрался.
    const points = buildRatingPoints([event('250.00', '5.00', '255.00')]);

    expect(points[0]?.playedAt).toBe('2026-09-02T10:00:00.000Z');
  });

  it('ручная корректировка остаётся отдельной точкой', () => {
    const points = buildRatingPoints([
      event('250.00', '5.00', '255.00'),
      event('255.00', '-5.00', '250.00', {
        tournamentId: null,
        tournament: null,
        createdAt: new Date('2026-09-03T10:00:00.000Z'),
      }),
    ]);

    // Без неё кривая прыгнула бы без объяснения — ТЗ 12.
    expect(points).toHaveLength(2);
    expect(points[1]).toMatchObject({ tournamentId: null, delta: '-5', matches: 0 });
  });

  it('точки идут по возрастанию времени: график рисуется слева направо', () => {
    const points = buildRatingPoints([
      event('260.00', '5.00', '265.00', {
        tournamentId: 'later',
        tournament: { name: 'Второй', startsAt: new Date('2026-09-10T10:00:00.000Z') },
      }),
      event('250.00', '10.00', '260.00'),
    ]);

    expect(points.map((point) => point.tournamentName)).toEqual(['Кубок клуба', 'Второй']);
  });
});

function match(over: Partial<PlayerMatchRow> = {}): PlayerMatchRow {
  return {
    id: 'match-1',
    tournamentId: TOURNAMENT_ID,
    playerAId: PLAYER_ID,
    playerBId: OPPONENT_ID,
    setsA: 3,
    setsB: 1,
    resultType: 'NORMAL',
    finishedAt: new Date('2026-09-02T10:25:00.000Z'),
    tournament: { name: 'Кубок клуба' },
    stage: { name: 'Круговая' },
    ratingEvents: [{ delta: new Prisma.Decimal('5.25') }],
    ...over,
  };
}

describe('встреча глазами игрока', () => {
  it('счёт разворачивается: свои сеты слева', () => {
    const view = toPlayerMatch(
      match({ playerAId: OPPONENT_ID, playerBId: PLAYER_ID }),
      PLAYER_ID,
      new Map(),
    );

    // Игрок стоял справа, но видит «1:3», а не «3:1».
    expect(view).toMatchObject({ setsFor: 1, setsAgainst: 3, won: false });
  });

  it('дельта берётся своя', () => {
    expect(toPlayerMatch(match(), PLAYER_ID, new Map()).delta).toBe('5.25');
  });

  it('необсчитанный турнир даёт пустую дельту, а не ноль', () => {
    // Ноль означал бы «рейтинг не изменился», а изменение просто ещё не
    // посчитано: оно приходит при завершении турнира (ТЗ 7.3).
    expect(toPlayerMatch(match({ ratingEvents: [] }), PLAYER_ID, new Map()).delta).toBeNull();
  });
});

describe('личный счёт', () => {
  it('складывается по всем встречам', () => {
    const won = toPlayerMatch(match(), PLAYER_ID, new Map());
    const lost = toPlayerMatch(match({ setsA: 1, setsB: 3 }), PLAYER_ID, new Map());

    expect(summarize([won, lost, won])).toEqual({
      wins: 2,
      losses: 1,
      setsWon: 7,
      setsLost: 5,
    });
  });
});
