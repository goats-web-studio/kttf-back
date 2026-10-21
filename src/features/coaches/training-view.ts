import {
  isCoachPublic,
  type ClubCoachView,
  type CoachPlayerRef,
  type TrainingClubRef,
  type TrainingCoachRef,
  type TrainingView,
} from '@kttf/shared/types';

import type { Prisma } from '../../generated/prisma/client.js';
import { cityRefFields } from '../places/place.fields.js';

/** Страница тренера видна всем: одобрена и не скрыта (`isCoachPublic`). */
export const PUBLIC_COACH = {
  status: 'APPROVED',
  hiddenAt: null,
} as const satisfies Prisma.CoachWhereInput;

/**
 * Тренировка видна всем — решение владельца от 20.10.2026:
 * - тренерская — у опубликованной страницы, без клуба (выезд, онлайн, зал
 *   по адресу) или с клубом, который подтвердил связь и не скрыт;
 * - клубная — у не скрытого клуба; тренер в ней показывается отдельно,
 *   только подтверждённый и опубликованный (`toTrainingView`).
 */
export const PUBLIC_TRAINING = {
  OR: [
    { author: 'COACH', coach: { is: PUBLIC_COACH }, clubId: null },
    {
      author: 'COACH',
      coach: { is: PUBLIC_COACH },
      link: 'CONFIRMED',
      club: { is: { hiddenAt: null } },
    },
    { author: 'CLUB', club: { is: { hiddenAt: null } } },
  ],
} as const satisfies Prisma.TrainingWhereInput;

/** Внутри места — как расставил автор, затем по времени заведения. */
export const TRAINING_ORDER = [
  { sortOrder: 'asc' },
  { createdAt: 'asc' },
] as const satisfies Prisma.TrainingOrderByWithRelationInput[];

export const coachPlayerFields = {
  id: true,
  lastName: true,
  firstName: true,
  middleName: true,
  photoUrl: true,
  rating: true,
  isProvisional: true,
  city: { select: cityRefFields },
} as const satisfies Prisma.PlayerSelect;

export const trainingClubFields = {
  id: true,
  name: true,
  logoUrl: true,
  address: true,
  city: { select: cityRefFields },
  twoGisUrl: true,
  phone: true,
  whatsapp: true,
  telegram: true,
  primaryContact: true,
  hiddenAt: true,
  profileReviewedAt: true,
} as const satisfies Prisma.ClubSelect;

export const trainingCoachFields = {
  id: true,
  slug: true,
  userId: true,
  photoUrl: true,
  phone: true,
  whatsapp: true,
  telegram: true,
  primaryContact: true,
  status: true,
  hiddenAt: true,
  player: { select: coachPlayerFields },
} as const satisfies Prisma.CoachSelect;

export const trainingFields = {
  id: true,
  author: true,
  coachId: true,
  clubId: true,
  link: true,
  booking: true,
  linkAt: true,
  kind: true,
  audiences: true,
  kidsFromAge: true,
  place: true,
  venueName: true,
  venueAddress: true,
  title: true,
  schedule: true,
  priceKzt: true,
  unit: true,
  note: true,
  description: true,
  sortOrder: true,
  createdAt: true,
  club: { select: trainingClubFields },
  coach: { select: trainingCoachFields },
} as const satisfies Prisma.TrainingSelect;

export type TrainingRecord = Prisma.TrainingGetPayload<{ select: typeof trainingFields }>;
type PlayerRecord = Prisma.PlayerGetPayload<{ select: typeof coachPlayerFields }>;
type ClubRecord = NonNullable<TrainingRecord['club']>;
type CoachRefRecord = NonNullable<TrainingRecord['coach']>;

/** Связь штаба с обеими сторонами — для ответов о штабе (T2, ADR-059). */
export const clubCoachFields = {
  clubId: true,
  coachId: true,
  status: true,
  position: true,
  requestedAt: true,
  confirmedAt: true,
  club: { select: trainingClubFields },
  coach: { select: trainingCoachFields },
} as const satisfies Prisma.ClubCoachSelect;

export type ClubCoachRecord = Prisma.ClubCoachGetPayload<{ select: typeof clubCoachFields }>;

/** Штаб: сначала давние, должность правит клуб. */
export const CLUB_COACH_ORDER = [
  { confirmedAt: 'asc' },
  { requestedAt: 'asc' },
] as const satisfies Prisma.ClubCoachOrderByWithRelationInput[];

export function toPlayerRef(player: PlayerRecord): CoachPlayerRef {
  return {
    id: player.id,
    lastName: player.lastName,
    firstName: player.firstName,
    middleName: player.middleName,
    photoUrl: player.photoUrl,
    // Строкой, как везде (ADR-014): через number рейтинг потерял бы точность.
    rating: player.rating.toString(),
    isProvisional: player.isProvisional,
    city: player.city,
  };
}

export function toClubRef(club: ClubRecord): TrainingClubRef {
  return {
    id: club.id,
    name: club.name,
    logoUrl: club.logoUrl,
    address: club.address,
    city: club.city,
    twoGisUrl: club.twoGisUrl,
    phone: club.phone,
    whatsapp: club.whatsapp,
    telegram: club.telegram,
    primaryContact: club.primaryContact,
  };
}

export function toCoachRef(coach: CoachRefRecord): TrainingCoachRef {
  return {
    id: coach.id,
    slug: coach.slug,
    player: toPlayerRef(coach.player),
    photoUrl: coach.photoUrl,
    phone: coach.phone,
    whatsapp: coach.whatsapp,
    telegram: coach.telegram,
    primaryContact: coach.primaryContact,
  };
}

export function toClubCoachView(link: ClubCoachRecord): ClubCoachView {
  return {
    club: toClubRef(link.club),
    coach: toCoachRef(link.coach),
    status: link.status,
    position: link.position,
    requestedAt: link.requestedAt.toISOString(),
    confirmedAt: link.confirmedAt?.toISOString() ?? null,
  };
}

/** Видна ли тренировка всем — то же правило, что `PUBLIC_TRAINING`, для уже прочитанных строк. */
export function isTrainingPublic(training: TrainingRecord): boolean {
  const clubOpen = training.club !== null && training.club.hiddenAt === null;

  if (training.author === 'CLUB') return clubOpen;

  const coachOpen =
    training.coach !== null &&
    isCoachPublic({ status: training.coach.status, hidden: training.coach.hiddenAt !== null });

  return coachOpen && (training.clubId === null || (training.link === 'CONFIRMED' && clubOpen));
}

/**
 * Тренировка в ответе. `reveal` — смотрит автор, вторая сторона или
 * администратор: им вторая сторона показывается как есть, при любом
 * статусе связи. Остальным тренер клубной тренировки виден только
 * подтверждённым и опубликованным.
 */
export function toTrainingView(training: TrainingRecord, reveal: boolean): TrainingView {
  const coach = training.coach;
  // Постороннему незачем знать, что приглашение ждёт ответа или отклонено:
  // для него такая связь выглядит как её отсутствие.
  const masked = !reveal && (training.link === 'PENDING' || training.link === 'DECLINED');
  const showCoach =
    coach !== null &&
    (training.author === 'COACH' ||
      reveal ||
      (training.link === 'CONFIRMED' &&
        isCoachPublic({ status: coach.status, hidden: coach.hiddenAt !== null })));
  // Клуб — вторая сторона только у тренировки тренера; у клубной это место.
  const showClub = training.club !== null && !(masked && training.author === 'COACH');

  return {
    id: training.id,
    author: training.author,
    // Клубную записывает клуб — всегда, что бы ни лежало в строке.
    booking: training.author === 'CLUB' ? 'CLUB' : training.booking,
    kind: training.kind,
    audiences: training.audiences,
    kidsFromAge: training.kidsFromAge,
    place: training.place,
    club: showClub && training.club !== null ? toClubRef(training.club) : null,
    venue:
      training.venueName === null || training.venueAddress === null
        ? null
        : { name: training.venueName, address: training.venueAddress },
    coach: showCoach ? toCoachRef(coach) : null,
    link: masked ? 'NONE' : training.link,
    title: training.title,
    schedule: training.schedule,
    priceKzt: training.priceKzt,
    unit: training.unit,
    note: training.note,
    description: training.description,
  };
}
