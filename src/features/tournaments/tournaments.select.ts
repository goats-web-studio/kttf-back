import type { RegistrationStatus } from '@kttf/shared/types';

import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Наборы полей для выборок.
 *
 * Вынесены отдельно, потому что из них выводятся типы записей: перечислять
 * их повторно в маппере значит завести второй источник истины, который
 * разойдётся с первым при первом же новом поле.
 */

export const playerFields = {
  id: true,
  userId: true,
  lastName: true,
  firstName: true,
  middleName: true,
  birthYear: true,
  gender: true,
  city: true,
  photoUrl: true,
  clubId: true,
  rating: true,
  ratedMatches: true,
  isProvisional: true,
  createdAt: true,
} as const;

/** Статусы, занимающие место в составе — лист ожидания и снятые не занимают. */
export const OCCUPYING_STATUSES: RegistrationStatus[] = ['REGISTERED', 'CONFIRMED', 'PLAYING'];

const tournamentScalars = {
  id: true,
  clubId: true,
  name: true,
  startsAt: true,
  registrationEndsAt: true,
  status: true,
  entryFee: true,
  maxParticipants: true,
  ratingCapMax: true,
  ratingCapMin: true,
  birthYearFrom: true,
  birthYearTo: true,
  genderLimit: true,
  level: true,
  tableCount: true,
  formatConfig: true,
  seedingConfig: true,
  description: true,
  prizeInfo: true,
  publicToken: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  ratedAt: true,
} as const;

export const tournamentFields = {
  ...tournamentScalars,
  // Число участников считает база: тянуть весь состав ради длины списка
  // означало бы выгружать сотню записей на каждую карточку календаря.
  // Фильтр остаётся изменяемым массивом — Prisma не принимает readonly.
  _count: { select: { registrations: { where: { status: { in: OCCUPYING_STATUSES } } } } },
};

export const registrationFields = {
  id: true,
  tournamentId: true,
  status: true,
  isRated: true,
  seed: true,
  ratingAtStart: true,
  matchesAtStart: true,
  createdAt: true,
  player: { select: playerFields },
} as const;

export const matchFields = {
  id: true,
  stageId: true,
  groupId: true,
  playerAId: true,
  playerBId: true,
  sourceA: true,
  sourceB: true,
  status: true,
  tableNumber: true,
  setsA: true,
  setsB: true,
  setScores: true,
  resultType: true,
  bracketRound: true,
  bracketSlot: true,
  startedAt: true,
  finishedAt: true,
} as const;

export const stageFields = {
  id: true,
  order: true,
  type: true,
  name: true,
  config: true,
  groups: {
    select: {
      id: true,
      label: true,
      order: true,
      tieDecisions: { select: { orderedIds: true }, orderBy: { decidedAt: 'desc' } },
    },
    orderBy: { order: 'asc' },
  },
  // Порядок одним полем: массив под `as const` становится readonly, а Prisma
  // такой не принимает. Внутри круга встречи досортировываются в памяти.
  matches: { select: matchFields, orderBy: { bracketRound: 'asc' } },
} as const;

/** Журнал рейтинга для публичных результатов — ТЗ 9.4. */
export const ratingEventFields = {
  playerId: true,
  matchId: true,
  ratingBefore: true,
  delta: true,
  ratingAfter: true,
} as const;

export type TournamentRecord = Prisma.TournamentGetPayload<{ select: typeof tournamentFields }>;
export type StageRecord = Prisma.StageGetPayload<{ select: typeof stageFields }>;
export type MatchRecord = Prisma.MatchGetPayload<{ select: typeof matchFields }>;
export type RegistrationRecord = Prisma.RegistrationGetPayload<{
  select: typeof registrationFields;
}>;
