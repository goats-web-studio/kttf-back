import {
  coachCredentialFilePath,
  type CoachApplicationView,
  type CoachCredentialView,
  type CoachListItemView,
  type CoachView,
  type TrainingLink,
} from '@kttf/shared/types';

import type { Prisma } from '../../generated/prisma/client.js';
import { cityRefFields } from '../places/place.fields.js';
import {
  TRAINING_ORDER,
  coachPlayerFields,
  toPlayerRef,
  toTrainingView,
  trainingFields,
} from './training-view.js';

export { PUBLIC_COACH } from './training-view.js';

/** Свежие страницы сверху: «Всё актуально» поднимает тренера в списке. */
export const COACH_ORDER = [
  { profileReviewedAt: { sort: 'desc', nulls: 'last' } },
  { createdAt: 'desc' },
] as const satisfies Prisma.CoachOrderByWithRelationInput[];

export const credentialFields = {
  id: true,
  kind: true,
  title: true,
  issuer: true,
  year: true,
  fileKey: true,
  filePublic: true,
  verifiedAt: true,
} as const satisfies Prisma.CoachCredentialSelect;

/**
 * Страница целиком. `plan` и `planUntil` наружу не уходят — тариф не часть
 * карточки, как у клуба; `hiddenAt` уходит признаком `hidden`.
 */
export const coachFields = {
  id: true,
  slug: true,
  playerId: true,
  userId: true,
  player: { select: coachPlayerFields },
  status: true,
  rejectReason: true,
  reviewedAt: true,
  submittedAt: true,
  hiddenAt: true,
  hiddenReason: true,
  headline: true,
  about: true,
  photoUrl: true,
  coverUrl: true,
  coachingSince: true,
  city: { select: cityRefFields },
  formats: true,
  visitAreas: true,
  languages: true,
  phone: true,
  whatsapp: true,
  telegram: true,
  instagram: true,
  primaryContact: true,
  sportsRank: true,
  coachCategory: true,
  refereeCategory: true,
  education: true,
  plan: true,
  profileReviewedAt: true,
  createdAt: true,
  // Все тренировки с этим тренером: свои и клубные, где он указан.
  trainings: { select: trainingFields, orderBy: [...TRAINING_ORDER] },
  credentials: { select: credentialFields, orderBy: { sortOrder: 'asc' } },
  achievements: {
    select: { id: true, role: true, year: true, title: true },
    orderBy: { sortOrder: 'asc' },
  },
} as const satisfies Prisma.CoachSelect;

export type CoachRecord = Prisma.CoachGetPayload<{ select: typeof coachFields }>;

/** Карточка тренера в списке: без документов и текста «о себе». */
export const coachListFields = {
  id: true,
  slug: true,
  playerId: true,
  player: { select: coachPlayerFields },
  headline: true,
  photoUrl: true,
  city: { select: cityRefFields },
  formats: true,
  languages: true,
  sportsRank: true,
  coachCategory: true,
  coachingSince: true,
  profileReviewedAt: true,
  trainings: {
    select: {
      author: true,
      clubId: true,
      link: true,
      priceKzt: true,
      club: { select: { id: true, name: true, hiddenAt: true } },
    },
  },
} as const satisfies Prisma.CoachSelect;

export type CoachListRecord = Prisma.CoachGetPayload<{ select: typeof coachListFields }>;

type CredentialRecord = CoachRecord['credentials'][number];

/** Тренировка с этим тренером — в том объёме, который нужен правилу видимости. */
interface CoachTrainingLink {
  readonly author: 'COACH' | 'CLUB';
  readonly clubId: string | null;
  readonly link: TrainingLink;
  readonly club: { readonly hiddenAt: Date | null } | null;
}

/** Связь с клубом подтверждена, и клуб не скрыт. */
function confirmedInOpenClub(training: CoachTrainingLink): boolean {
  return training.link === 'CONFIRMED' && training.club !== null && training.club.hiddenAt === null;
}

/**
 * Тренировка на опубликованной странице тренера: своя без клуба или с
 * подтвердившим клубом, клубная — где тренер подтвердил участие.
 */
export function visibleOnCoachPage(training: CoachTrainingLink): boolean {
  return training.author === 'COACH' && training.clubId === null
    ? true
    : confirmedInOpenClub(training);
}

/**
 * Кто смотрит. Владелец страницы и администратор видят причину отказа,
 * пути загрузки сканов и непубличные сканы; остальные — только метки.
 */
export interface CoachViewer {
  readonly privileged: boolean;
}

export function toCredentialView(
  coachId: string,
  credential: CredentialRecord,
  viewer: CoachViewer,
): CoachCredentialView {
  const hasFile = credential.fileKey !== null;
  const mayOpen = hasFile && (credential.filePublic || viewer.privileged);

  return {
    id: credential.id,
    kind: credential.kind,
    title: credential.title,
    issuer: credential.issuer,
    year: credential.year,
    hasFile,
    filePublic: credential.filePublic,
    fileUrl: mayOpen ? coachCredentialFilePath(coachId, credential.id) : null,
    file: viewer.privileged ? credential.fileKey : null,
    verifiedAt: credential.verifiedAt?.toISOString() ?? null,
  };
}

export function toCoachView(
  coach: CoachRecord,
  studentsCount: number,
  viewer: CoachViewer,
): CoachView {
  return {
    id: coach.id,
    slug: coach.slug,
    player: toPlayerRef(coach.player),
    status: coach.status,
    rejectReason: viewer.privileged ? coach.rejectReason : null,
    reviewedAt: coach.reviewedAt?.toISOString() ?? null,
    hidden: coach.hiddenAt !== null,
    hiddenReason: coach.hiddenReason,
    headline: coach.headline,
    about: coach.about,
    photoUrl: coach.photoUrl,
    coverUrl: coach.coverUrl,
    coachingSince: coach.coachingSince,
    city: coach.city,
    formats: coach.formats,
    visitAreas: coach.visitAreas,
    languages: coach.languages,
    phone: coach.phone,
    whatsapp: coach.whatsapp,
    telegram: coach.telegram,
    instagram: coach.instagram,
    primaryContact: coach.primaryContact,
    sportsRank: coach.sportsRank,
    coachCategory: coach.coachCategory,
    refereeCategory: coach.refereeCategory,
    education: coach.education,
    // Владельцу и администратору — свои тренировки как есть, со статусом
    // связи; остальным — только видимые. Клубные — с подтверждённой связью.
    trainings: coach.trainings
      .filter((training) =>
        training.author === 'COACH'
          ? viewer.privileged || visibleOnCoachPage(training)
          : confirmedInOpenClub(training),
      )
      .map((training) => toTrainingView(training, viewer.privileged)),
    trainingRequests: viewer.privileged
      ? coach.trainings
          .filter((training) => training.author === 'CLUB' && training.link === 'PENDING')
          .map((training) => toTrainingView(training, true))
      : [],
    credentials: coach.credentials.map((credential) =>
      toCredentialView(coach.id, credential, viewer),
    ),
    achievements: coach.achievements,
    studentsCount,
    profileReviewedAt: coach.profileReviewedAt?.toISOString() ?? null,
    createdAt: coach.createdAt.toISOString(),
  };
}

/** Строка разбора у администратора — страница целиком, как её увидят все. */
export function toApplicationView(coach: CoachRecord, studentsCount: number): CoachApplicationView {
  return {
    ...toCoachView(coach, studentsCount, { privileged: true }),
    submittedAt: coach.submittedAt?.toISOString() ?? null,
  };
}

export function toListItemView(coach: CoachListRecord, studentsCount: number): CoachListItemView {
  const visible = coach.trainings.filter(visibleOnCoachPage);
  const prices = visible.flatMap((training) =>
    training.priceKzt === null ? [] : [training.priceKzt],
  );
  const clubs = new Map<string, { id: string; name: string }>();

  for (const training of visible) {
    if (training.club !== null) clubs.set(training.club.id, training.club);
  }

  return {
    id: coach.id,
    slug: coach.slug,
    player: toPlayerRef(coach.player),
    headline: coach.headline,
    photoUrl: coach.photoUrl,
    city: coach.city,
    formats: coach.formats,
    languages: coach.languages,
    sportsRank: coach.sportsRank,
    coachCategory: coach.coachCategory,
    coachingSince: coach.coachingSince,
    minPriceKzt: prices.length === 0 ? null : Math.min(...prices),
    trainingsCount: visible.length,
    clubs: [...clubs.values()].map((club) => ({ id: club.id, name: club.name })),
    studentsCount,
    profileReviewedAt: coach.profileReviewedAt?.toISOString() ?? null,
  };
}
