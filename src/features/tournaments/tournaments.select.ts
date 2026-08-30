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

export type TournamentRecord = Prisma.TournamentGetPayload<{ select: typeof tournamentFields }>;
export type RegistrationRecord = Prisma.RegistrationGetPayload<{
  select: typeof registrationFields;
}>;
