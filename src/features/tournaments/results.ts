import {
  calculatePlacement,
  type BracketResult,
  type GroupTable,
  type PlacementInput,
  type PlacementRow,
  type PlacementScheme,
} from '@kttf/shared/brackets';
import type {
  FormatConfig,
  ParticipantRatingView,
  RatingEventView,
  ResultParticipantView,
  TournamentResultsView,
  TournamentStandingsView,
} from '@kttf/shared/types';

import { Prisma } from '../../generated/prisma/client.js';

import { byBracketPosition } from './finish.js';
import { toStageView, toTournamentView } from './tournaments.mapper.js';
import type {
  MatchRecord,
  RegistrationRecord,
  StageRecord,
  TournamentRecord,
} from './tournaments.select.js';

/**
 * Публичные результаты турнира — ТЗ 9.4.
 *
 * Чистая функция поверх движка: места считает `calculatePlacement`, здесь
 * только сборка входа из записей базы. Считать что-либо своё в приложении
 * нельзя — офлайн-консоль обязана получить те же места (запрет №2 брифа).
 */

/** Событие журнала рейтинга в том виде, в каком его читают результаты. */
export interface RatingEventRecord {
  readonly playerId: string;
  readonly matchId: string | null;
  readonly ratingBefore: Prisma.Decimal;
  readonly delta: Prisma.Decimal;
  readonly ratingAfter: Prisma.Decimal;
}

export interface ResultsInput {
  readonly tournament: TournamentRecord;
  readonly stages: readonly StageRecord[];
  readonly registrations: readonly RegistrationRecord[];
  readonly standings: TournamentStandingsView;
  readonly events: readonly RatingEventRecord[];
}

export function buildResults(input: ResultsInput): TournamentResultsView {
  const config = parseConfig(input.tournament.formatConfig);
  const placement = calculatePlacement(config.type, placementInput(input.stages, input.standings));
  const byPlayer = new Map(placement.rows.map((row) => [row.participant, row]));

  return {
    tournament: toTournamentView(input.tournament),
    participants: participants(input.registrations, byPlayer),
    shared: placement.shared.map(toTie),
    unresolved: placement.unresolved.map(toTie),
    standings: input.standings,
    stages: [...input.stages].sort((left, right) => left.order - right.order).map(toStageView),
    ratings: ratings(input.registrations, input.stages, input.events),
  };
}

/**
 * Схема проведения из колонки `Json`.
 *
 * Литералы `formatConfig.type` и `PlacementScheme` совпадают по составу, но
 * объявлены независимо: движок не имеет права зависеть от Zod-схем (ADR-023).
 * Присваивание здесь — единственное место, где эти два перечня встречаются,
 * и оно проверяется типом.
 */
function parseConfig(value: unknown): { type: PlacementScheme } {
  const config = value as FormatConfig;

  return { type: config.type };
}

function placementInput(
  stages: readonly StageRecord[],
  standings: TournamentStandingsView,
): PlacementInput {
  const ordered = [...stages].sort((left, right) => left.order - right.order);
  const first = ordered.find((stage) => stage.type !== 'KNOCKOUT');
  // Финальные группы — второй групповой этап: тот же тип, больший порядок.
  const final = ordered.find((stage) => stage.type === 'GROUPS' && stage !== first);
  const knockout = ordered.find((stage) => stage.type === 'KNOCKOUT');

  return {
    groups: first === undefined ? [] : tablesOf(first, standings),
    finalGroups: final === undefined ? [] : tablesOf(final, standings),
    bracket: knockout === undefined ? [] : knockout.matches.map(toBracketResult),
  };
}

/** Таблицы одного этапа с порядком групп: он задаёт диапазоны мест. */
function tablesOf(stage: StageRecord, standings: TournamentStandingsView): GroupTable[] {
  const orderOf = new Map(stage.groups.map((group) => [group.id, group.order]));

  return standings.groups
    .filter((group) => group.stageId === stage.id)
    .map((group) => ({
      order: group.groupId === null ? 0 : (orderOf.get(group.groupId) ?? 0),
      standings: { rows: group.rows, unresolved: group.unresolved },
    }));
}

/**
 * Встреча сетки для расчёта мест.
 *
 * Встреча за третье место в базе ничем не помечена: `kind` движка при записи
 * не сохраняется. Узнаётся она по источникам — это единственная встреча
 * сетки, в которую едут проигравшие, а не победители.
 *
 * Техническая победа и снятие здесь считаются исходом наравне с обычной
 * победой: в отличие от рейтинга, по сетке победитель едет дальше в любом
 * случае, и место он занял.
 */
function toBracketResult(match: MatchRecord): BracketResult {
  const decided =
    match.playerAId !== null &&
    match.playerBId !== null &&
    match.setsA !== null &&
    match.setsB !== null &&
    match.setsA !== match.setsB;

  const winnerIsA = decided && (match.setsA ?? 0) > (match.setsB ?? 0);

  return {
    round: match.bracketRound ?? 1,
    kind: takesLosers(match) ? 'THIRD_PLACE' : 'MAIN',
    winner: decided ? (winnerIsA ? match.playerAId : match.playerBId) : null,
    loser: decided ? (winnerIsA ? match.playerBId : match.playerAId) : null,
  };
}

function takesLosers(match: MatchRecord): boolean {
  return [match.sourceA, match.sourceB].some(
    (source) =>
      typeof source === 'object' &&
      source !== null &&
      !Array.isArray(source) &&
      (source as Record<string, unknown>).kind === 'LOSER',
  );
}

function participants(
  registrations: readonly RegistrationRecord[],
  places: ReadonlyMap<string, PlacementRow>,
): ResultParticipantView[] {
  const rows = registrations.map((registration): ResultParticipantView => {
    const found = places.get(registration.player.id);

    return {
      player: toPlayer(registration),
      place: found?.place ?? null,
      // Участника может не быть в раскладке вовсе: снялся до жеребьёвки или
      // остался в листе ожидания. Мест он не разыгрывал, но и не выбывал
      // из группы — это именно «не определено».
      reason: found?.reason ?? 'UNDECIDED',
      status: registration.status,
      isRated: registration.isRated,
      seed: registration.seed,
    };
  });

  return rows.sort(byPlace);
}

/** Сначала занявшие места по возрастанию, следом все прочие по фамилии. */
function byPlace(left: ResultParticipantView, right: ResultParticipantView): number {
  if (left.place !== null && right.place !== null) return left.place - right.place;
  if (left.place !== null) return -1;
  if (right.place !== null) return 1;

  return left.player.lastName.localeCompare(right.player.lastName, 'ru');
}

function toPlayer(registration: RegistrationRecord): ResultParticipantView['player'] {
  const { player } = registration;

  return {
    id: player.id,
    userId: player.userId,
    lastName: player.lastName,
    firstName: player.firstName,
    middleName: player.middleName,
    birthYear: player.birthYear,
    gender: player.gender,
    city: player.city,
    photoUrl: player.photoUrl,
    clubId: player.clubId,
    rating: player.rating.toString(),
    ratedMatches: player.ratedMatches,
    isProvisional: player.isProvisional,
    createdAt: player.createdAt.toISOString(),
  };
}

/**
 * Изменение рейтинга по каждому участнику — ТЗ 9.4.
 *
 * События упорядочиваются структурно, а не по времени: журнал своего порядка
 * не хранит, все записи турнира вставляются одним `createMany` и получают
 * одинаковый `createdAt`. Тот же порядок использует расчёт (ADR-022).
 */
function ratings(
  registrations: readonly RegistrationRecord[],
  stages: readonly StageRecord[],
  events: readonly RatingEventRecord[],
): ParticipantRatingView[] {
  const position = matchOrder(stages);
  const ordered = [...events].sort(
    (left, right) => indexOf(position, left.matchId) - indexOf(position, right.matchId),
  );

  return registrations.map((registration): ParticipantRatingView => {
    const own = ordered.filter((event) => event.playerId === registration.player.id);
    const total = own.reduce((sum, event) => sum.plus(event.delta), new Prisma.Decimal(0));
    const last = own.at(-1);

    return {
      playerId: registration.player.id,
      ratingAtStart: registration.ratingAtStart?.toString() ?? null,
      ratingAfter: last?.ratingAfter.toString() ?? null,
      // toString, а не toFixed: остальные десятичные API отдаются так же,
      // и разнобой внутри одного ответа — «+16» рядом с «44.80» — пришлось бы
      // разбирать на клиенте.
      totalDelta: total.toString(),
      events: own.map(toRatingEvent),
    };
  });
}

function toRatingEvent(event: RatingEventRecord): RatingEventView {
  return {
    matchId: event.matchId,
    ratingBefore: event.ratingBefore.toString(),
    delta: event.delta.toString(),
    ratingAfter: event.ratingAfter.toString(),
  };
}

/** Позиция встречи в структурном порядке: этап, круг, слот, идентификатор. */
function matchOrder(stages: readonly StageRecord[]): Map<string, number> {
  const ordered = [...stages]
    .sort((left, right) => left.order - right.order)
    .flatMap((stage) => [...stage.matches].sort(byBracketPosition));

  return new Map(ordered.map((match, index) => [match.id, index]));
}

/** Событие без встречи — ручная корректировка: место ей в конце. */
function indexOf(position: ReadonlyMap<string, number>, matchId: string | null): number {
  if (matchId === null) return Number.MAX_SAFE_INTEGER;

  return position.get(matchId) ?? Number.MAX_SAFE_INTEGER;
}

function toTie(tie: { participants: readonly string[]; places: readonly number[] }): {
  participants: string[];
  places: number[];
} {
  return { participants: [...tie.participants], places: [...tie.places] };
}
