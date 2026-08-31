import {
  bracketSourceSchema,
  formatConfigSchema,
  seedingConfigSchema,
  type BracketSourceView,
  type MatchView,
  type PlayerView,
  type RegistrationView,
  type StageView,
  type TournamentView,
} from '@kttf/shared/types';

import type { Prisma } from '../../generated/prisma/client.js';

import type {
  MatchRecord,
  RegistrationRecord,
  StageRecord,
  TournamentRecord,
} from './tournaments.select.js';

/**
 * Запись базы в ответ API.
 *
 * Десятичные значения уходят строкой: в базе это `Decimal(8,2)`, а число с
 * плавающей точкой хранит не все такие значения точно. Разница вылезет там,
 * где планка сравнивается с рейтингом, — ADR-014.
 */

function decimalOrNull(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toString();
}

/**
 * Конфигурация схемы приходит из колонки `Json` и типа не имеет.
 *
 * Разбирается той же схемой, что проверяла её на входе. Если в базе лежит
 * что-то другое, ошибка вылезет здесь, а не в консоли судьи посреди турнира.
 */
function parseFormatConfig(value: unknown): TournamentView['formatConfig'] {
  return formatConfigSchema.parse(value);
}

function parseSeedingConfig(value: unknown): TournamentView['seedingConfig'] {
  return value === null || value === undefined ? null : seedingConfigSchema.parse(value);
}

export function toTournamentView(tournament: TournamentRecord): TournamentView {
  return {
    id: tournament.id,
    clubId: tournament.clubId,
    name: tournament.name,
    startsAt: tournament.startsAt.toISOString(),
    registrationEndsAt: tournament.registrationEndsAt?.toISOString() ?? null,
    status: tournament.status,
    entryFee: tournament.entryFee,
    maxParticipants: tournament.maxParticipants,
    ratingCapMax: decimalOrNull(tournament.ratingCapMax),
    ratingCapMin: decimalOrNull(tournament.ratingCapMin),
    birthYearFrom: tournament.birthYearFrom,
    birthYearTo: tournament.birthYearTo,
    genderLimit: tournament.genderLimit,
    level: tournament.level,
    tableCount: tournament.tableCount,
    formatConfig: parseFormatConfig(tournament.formatConfig),
    seedingConfig: parseSeedingConfig(tournament.seedingConfig),
    description: tournament.description,
    prizeInfo: tournament.prizeInfo,
    publicToken: tournament.publicToken,
    participantCount: tournament._count.registrations,
    createdAt: tournament.createdAt.toISOString(),
    startedAt: tournament.startedAt?.toISOString() ?? null,
    finishedAt: tournament.finishedAt?.toISOString() ?? null,
    ratedAt: tournament.ratedAt?.toISOString() ?? null,
  };
}

function toPlayerView(player: RegistrationRecord['player']): PlayerView {
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

export function toRegistrationView(registration: RegistrationRecord): RegistrationView {
  return {
    id: registration.id,
    tournamentId: registration.tournamentId,
    status: registration.status,
    isRated: registration.isRated,
    seed: registration.seed,
    // До старта турнира снимка нет: он делается при переходе в RUNNING (ТС 5.4).
    ratingAtStart: decimalOrNull(registration.ratingAtStart),
    matchesAtStart: registration.matchesAtStart,
    createdAt: registration.createdAt.toISOString(),
    player: toPlayerView(registration.player),
  };
}

/** Источник участника лежит в колонке `Json` и типа не имеет — ADR-019. */
function toSource(value: unknown): BracketSourceView | null {
  if (value === null || value === undefined) return null;

  const parsed = bracketSourceSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}

export function toMatchView(match: MatchRecord): MatchView {
  return {
    id: match.id,
    stageId: match.stageId,
    groupId: match.groupId,
    playerAId: match.playerAId,
    playerBId: match.playerBId,
    sourceA: toSource(match.sourceA),
    sourceB: toSource(match.sourceB),
    status: match.status,
    tableNumber: match.tableNumber,
    setsA: match.setsA,
    setsB: match.setsB,
    resultType: match.resultType,
    bracketRound: match.bracketRound,
    bracketSlot: match.bracketSlot,
  };
}

export function toStageView(stage: StageRecord): StageView {
  const matches = [...stage.matches].sort(
    (left, right) =>
      (left.bracketRound ?? 0) - (right.bracketRound ?? 0) ||
      (left.bracketSlot ?? 0) - (right.bracketSlot ?? 0),
  );

  return {
    id: stage.id,
    order: stage.order,
    type: stage.type,
    name: stage.name,
    groups: stage.groups.map((group) => ({
      id: group.id,
      label: group.label,
      order: group.order,
      // Отдельной колонки под состав группы в модели нет: он выводится из
      // её встреч, а в круговой схеме играют все со всеми.
      participants: [
        ...new Set(
          matches
            .filter((match) => match.groupId === group.id)
            .flatMap((match) =>
              [match.playerAId, match.playerBId].filter((id): id is string => id !== null),
            ),
        ),
      ],
    })),
    matches: matches.map(toMatchView),
  };
}
