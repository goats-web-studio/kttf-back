import type { PlayerMatchView, RatingPointView } from '@kttf/shared/types';

import { Prisma } from '../../generated/prisma/client.js';

/**
 * История игрока — ТЗ 9.3, маршруты ТС 7.2.
 *
 * Чистые функции над записями базы: журнал рейтинга и встречи превращаются
 * в то, что игрок видит о себе. Ничего не пересчитывается — дельты и рейтинги
 * уже посчитаны движком при завершении турнира (ADR-022).
 */

/** Событие журнала в том виде, в каком его читает история. */
export interface RatingEventRow {
  readonly tournamentId: string | null;
  readonly ratingBefore: Prisma.Decimal;
  readonly delta: Prisma.Decimal;
  readonly ratingAfter: Prisma.Decimal;
  readonly createdAt: Date;
  readonly tournament: { readonly name: string; readonly startsAt: Date } | null;
}

/**
 * Границы цепочки событий одного турнира.
 *
 * **Журнал не хранит порядок событий:** все записи турнира вставляются одним
 * `createMany` и получают одинаковый `createdAt`. Порядок восстанавливается
 * через саму цепочку — начало это событие, чей `ratingBefore` не является
 * ничьим `ratingAfter`, конец наоборот.
 *
 * Если цепочка не восстанавливается однозначно (так бывает, когда несколько
 * нулевых дельт подряд дают одинаковые значения), берётся первое событие как
 * начало, а конец складывается из суммы дельт. Разойтись эти два способа
 * могут только на отсечке `MIN_RATING`, а она сама по себе исключительное
 * событие и помечена флагом `clamped`.
 */
export function chainBounds(events: readonly RatingEventRow[]): {
  before: Prisma.Decimal;
  after: Prisma.Decimal;
} {
  const first = events[0];

  if (first === undefined) {
    return { before: new Prisma.Decimal(0), after: new Prisma.Decimal(0) };
  }

  const heads = events.filter(
    (event, index) =>
      !events.some(
        (other, position) => position !== index && sameValue(other.ratingAfter, event.ratingBefore),
      ),
  );
  const tails = events.filter(
    (event, index) =>
      !events.some(
        (other, position) => position !== index && sameValue(other.ratingBefore, event.ratingAfter),
      ),
  );

  const head = heads.length === 1 ? heads[0] : undefined;
  const tail = tails.length === 1 ? tails[0] : undefined;

  if (head !== undefined && tail !== undefined) {
    return { before: head.ratingBefore, after: tail.ratingAfter };
  }

  return { before: first.ratingBefore, after: first.ratingBefore.plus(sumOf(events)) };
}

function sameValue(left: Prisma.Decimal, right: Prisma.Decimal): boolean {
  return left.equals(right);
}

function sumOf(events: readonly RatingEventRow[]): Prisma.Decimal {
  return events.reduce((sum, event) => sum.plus(event.delta), new Prisma.Decimal(0));
}

/**
 * Кривая рейтинга по турнирам — ТЗ 9.3.
 *
 * Точка на турнир, а не на встречу: в кривой года сотня точек одного турнира
 * ничего не объясняет. Ручная корректировка турнира не имеет и остаётся
 * отдельной точкой — без неё кривая прыгала бы без причины (ТЗ 12).
 */
export function buildRatingPoints(events: readonly RatingEventRow[]): RatingPointView[] {
  const byTournament = new Map<string, RatingEventRow[]>();
  const standalone: RatingEventRow[] = [];

  for (const event of events) {
    if (event.tournamentId === null) {
      standalone.push(event);
      continue;
    }

    byTournament.set(event.tournamentId, [...(byTournament.get(event.tournamentId) ?? []), event]);
  }

  const points = [...byTournament].map(([tournamentId, group]): RatingPointView => {
    const bounds = chainBounds(group);
    const first = group[0];

    return {
      tournamentId,
      tournamentName: first?.tournament?.name ?? null,
      // Старт турнира, а не запись в журнал: на графике турнир стоит там,
      // когда он игрался, а не когда его обсчитали.
      playedAt: (first?.tournament?.startsAt ?? first?.createdAt ?? new Date()).toISOString(),
      ratingBefore: bounds.before.toString(),
      ratingAfter: bounds.after.toString(),
      delta: sumOf(group).toString(),
      // Нулевые дельты (разрыв 100 очков, ТЗ 7) — тоже сыгранные встречи.
      matches: group.length,
    };
  });

  const manual = standalone.map((event): RatingPointView => ({
    tournamentId: null,
    tournamentName: null,
    playedAt: event.createdAt.toISOString(),
    ratingBefore: event.ratingBefore.toString(),
    ratingAfter: event.ratingAfter.toString(),
    delta: event.delta.toString(),
    matches: 0,
  }));

  return [...points, ...manual].sort((left, right) => left.playedAt.localeCompare(right.playedAt));
}

/** Встреча в том виде, в каком её читает история. */
export interface PlayerMatchRow {
  readonly id: string;
  readonly tournamentId: string;
  readonly playerAId: string | null;
  readonly playerBId: string | null;
  readonly setsA: number | null;
  readonly setsB: number | null;
  readonly resultType: 'NORMAL' | 'WALKOVER' | 'RETIRED' | null;
  readonly finishedAt: Date | null;
  readonly tournament: { readonly name: string };
  readonly stage: { readonly name: string };
  readonly ratingEvents: readonly { readonly delta: Prisma.Decimal }[];
}

/**
 * Встреча глазами игрока.
 *
 * Счёт разворачивается на «свои» и «чужие» сеты: игрок не обязан помнить,
 * с какой стороны сетки он стоял.
 */
export function toPlayerMatch(
  row: PlayerMatchRow,
  playerId: string,
  opponents: ReadonlyMap<string, PlayerMatchView['opponent']>,
): PlayerMatchView {
  const isA = row.playerAId === playerId;
  const setsFor = (isA ? row.setsA : row.setsB) ?? 0;
  const setsAgainst = (isA ? row.setsB : row.setsA) ?? 0;
  const opponentId = isA ? row.playerBId : row.playerAId;

  return {
    matchId: row.id,
    tournamentId: row.tournamentId,
    tournamentName: row.tournament.name,
    stageName: row.stage.name,
    playedAt: row.finishedAt?.toISOString() ?? null,
    opponent: opponentId === null ? null : (opponents.get(opponentId) ?? null),
    setsFor,
    setsAgainst,
    won: setsFor > setsAgainst,
    resultType: row.resultType ?? 'NORMAL',
    // Дельты нет, пока турнир не обсчитан (ТЗ 7.3). Ноль здесь врал бы:
    // изменение не «нулевое», а ещё не посчитано.
    delta: row.ratingEvents[0]?.delta.toString() ?? null,
  };
}

/** Итог противостояния: считается по всем встречам, а не по странице. */
export function summarize(matches: readonly PlayerMatchView[]): {
  wins: number;
  losses: number;
  setsWon: number;
  setsLost: number;
} {
  return matches.reduce(
    (total, match) => ({
      wins: total.wins + (match.won ? 1 : 0),
      losses: total.losses + (match.won ? 0 : 1),
      setsWon: total.setsWon + match.setsFor,
      setsLost: total.setsLost + match.setsAgainst,
    }),
    { wins: 0, losses: 0, setsWon: 0, setsLost: 0 },
  );
}
