import type { RatedMatch, RatedPlayer, TournamentLevel } from '@kttf/shared/rating';
import type { TournamentStandingsView } from '@kttf/shared/types';

import { unplayedMatches } from './stage-completion.js';
import type { MatchRecord, RegistrationRecord, StageRecord } from './tournaments.select.js';

/**
 * Подготовка турнира к завершению — ТЗ 4.1 и ТЗ 7.3.
 *
 * Чистые функции: проверки и сборка входа движка. Сам расчёт живёт в
 * `@kttf/shared/rating`, здесь только перекладывание записей базы — считать
 * что-либо своё в приложении нельзя (запрет №2 брифа).
 */

/** Участники, чьи встречи не будут сыграны никогда, — ТЗ 4.4. */
export function withdrawnPlayers(registrations: readonly RegistrationRecord[]): Set<string> {
  return new Set(
    registrations
      .filter(
        (registration) => registration.status === 'WITHDRAWN' || registration.status === 'NO_SHOW',
      )
      .map((registration) => registration.player.id),
  );
}

/** Встречи без результата, мешающие завершению. Пусто — турнир доигран. */
export function unfinishedMatches(
  stages: readonly StageRecord[],
  withdrawn: ReadonlySet<string>,
): string[] {
  return stages.flatMap((stage) => unplayedMatches(stage, withdrawn).map((match) => match.id));
}

/**
 * Группы, где равенство не разрешено судьёй, — ADR-008.
 *
 * Пока места не определены, турнир не завершается: результат турнира —
 * это места, а не набор счетов.
 */
export function unresolvedTies(standings: TournamentStandingsView): string[] {
  return standings.groups
    .filter((group) => group.unresolved.length > 0)
    .map((group) => group.label);
}

/**
 * Участники расчёта: снимок на старте и текущее состояние проекции.
 *
 * Снятые сюда входят наравне с прочими: по ТЗ 4.4 их сыгранные встречи
 * учитываются, а несыгранные и так не дойдут до расчёта — результата у них
 * нет. «Вне зачёта» не входят: их встречи отсеиваются целиком.
 */
export function ratedPlayers(
  registrations: readonly RegistrationRecord[],
): Map<string, RatedPlayer> {
  const players = new Map<string, RatedPlayer>();

  for (const registration of registrations) {
    const { ratingAtStart, matchesAtStart, player } = registration;

    if (!registration.isRated || ratingAtStart === null || matchesAtStart === null) continue;

    players.set(player.id, {
      atStart: { rating: Number(ratingAtStart), ratedMatches: matchesAtStart },
      current: { rating: Number(player.rating), ratedMatches: player.ratedMatches },
    });
  }

  return players;
}

/**
 * Сыгранные встречи, идущие в зачёт рейтинга.
 *
 * Отсеивается то, о чём движок знать не обязан: встречи с участием игрока
 * вне зачёта и встречи без обоих участников. Техническую победу и снятие
 * движок отбрасывает сам — это правило формулы (ТЗ 7.2), а не выборки.
 *
 * Порядок структурный, а не по времени: пересчёт истории обязан дать ту же
 * цепочку событий (ТС 5.5, инвариант 8), а `finishedAt` зависит от того,
 * когда судья успел нажать кнопку.
 */
export function ratedMatches(
  stages: readonly StageRecord[],
  players: ReadonlyMap<string, RatedPlayer>,
): RatedMatch[] {
  const ordered = [...stages]
    .sort((left, right) => left.order - right.order)
    .flatMap((stage) => [...stage.matches].sort(byBracketPosition));

  return ordered.filter(isPlayed).map(toRatedMatch).filter(bothRated(players));
}

/** Все данные, которые нужны движку, кроме уровня турнира. */
export interface RatingRunInput {
  readonly level: TournamentLevel;
  readonly players: Map<string, RatedPlayer>;
  readonly matches: RatedMatch[];
}

export function buildRatingRun(
  level: TournamentLevel,
  registrations: readonly RegistrationRecord[],
  stages: readonly StageRecord[],
): RatingRunInput {
  const players = ratedPlayers(registrations);

  return { level, players, matches: ratedMatches(stages, players) };
}

interface PlayedMatch extends MatchRecord {
  playerAId: string;
  playerBId: string;
  setsA: number;
  setsB: number;
}

function isPlayed(match: MatchRecord): match is PlayedMatch {
  return (
    match.playerAId !== null &&
    match.playerBId !== null &&
    match.setsA !== null &&
    match.setsB !== null &&
    match.setsA !== match.setsB
  );
}

/**
 * Обе стороны обязаны быть в зачёте.
 *
 * Встреча «вне зачёта» не влияет на рейтинг (ТЗ 7.2) — ни у того, кто вне
 * зачёта, ни у его соперника: встреча целиком не рейтинговая. Игрок без
 * снимка на старте отсеивается тут же, но это не норма, а испорченные
 * данные — вызывающий проверяет их отдельно и отказывает громко.
 */
function bothRated(players: ReadonlyMap<string, RatedPlayer>): (match: RatedMatch) => boolean {
  return (match) => players.has(match.winnerId) && players.has(match.loserId);
}

function toRatedMatch(match: PlayedMatch): RatedMatch {
  const winnerFirst = match.setsA > match.setsB;

  return {
    matchId: match.id,
    winnerId: winnerFirst ? match.playerAId : match.playerBId,
    loserId: winnerFirst ? match.playerBId : match.playerAId,
    winnerSets: winnerFirst ? match.setsA : match.setsB,
    loserSets: winnerFirst ? match.setsB : match.setsA,
    resultType: match.resultType ?? 'NORMAL',
  };
}

/**
 * Структурный порядок встреч: этап, круг, позиция, идентификатор.
 *
 * Экспортируется, потому что тот же порядок нужен публичным результатам:
 * журнал `RatingEvent` своего порядка не хранит — все события турнира пишутся
 * одним `createMany` и получают одинаковый `createdAt`. Второе определение
 * того же порядка неизбежно разошлось бы с этим.
 */
export function byBracketPosition(left: MatchRecord, right: MatchRecord): number {
  const round = (left.bracketRound ?? 0) - (right.bracketRound ?? 0);
  if (round !== 0) return round;

  const slot = (left.bracketSlot ?? 0) - (right.bracketSlot ?? 0);
  if (slot !== 0) return slot;

  return left.id < right.id ? -1 : 1;
}

/**
 * Сыгранные встречи, у участников которых нет снимка на старте.
 *
 * Это не «вне зачёта», а испорченные данные: игрок сыграл, но в составе
 * турнира его нет. Считать такую встречу по текущему рейтингу вместо снимка
 * значит тихо нарушить ТС 5.4, поэтому завершение останавливается.
 */
export function playersWithoutSnapshot(
  stages: readonly StageRecord[],
  registrations: readonly RegistrationRecord[],
): string[] {
  const known = new Set(
    registrations
      .filter(
        (registration) =>
          registration.ratingAtStart !== null && registration.matchesAtStart !== null,
      )
      .map((registration) => registration.player.id),
  );

  const outsiders = new Set<string>();

  for (const stage of stages) {
    for (const match of stage.matches) {
      if (!isPlayed(match)) continue;

      for (const playerId of [match.playerAId, match.playerBId]) {
        if (!known.has(playerId)) outsiders.add(playerId);
      }
    }
  }

  return [...outsiders];
}
