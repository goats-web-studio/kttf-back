import {
  coachCredentialFilePath,
  type CoachApplicationView,
  type CoachCredentialView,
  type CoachListItemView,
  type CoachPlayerRef,
  type CoachServiceView,
  type CoachView,
  type TrainingListItemView,
} from '@kttf/shared/types';

import type { Prisma } from '../../generated/prisma/client.js';
import { cityRefFields } from '../places/place.fields.js';

/** Страница видна всем: одобрена и не скрыта (`isCoachPublic`). */
export const PUBLIC_COACH = {
  status: 'APPROVED',
  hiddenAt: null,
} as const satisfies Prisma.CoachWhereInput;

/** Свежие страницы сверху: «Всё актуально» поднимает тренера в списке. */
export const COACH_ORDER = [
  { profileReviewedAt: { sort: 'desc', nulls: 'last' } },
  { createdAt: 'desc' },
] as const satisfies Prisma.CoachOrderByWithRelationInput[];

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

export const serviceFields = {
  id: true,
  kind: true,
  audiences: true,
  kidsFromAge: true,
  place: true,
  title: true,
  schedule: true,
  priceKzt: true,
  unit: true,
  note: true,
} as const satisfies Prisma.CoachServiceSelect;

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
  services: { select: serviceFields, orderBy: { sortOrder: 'asc' } },
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
  services: { select: { priceKzt: true } },
} as const satisfies Prisma.CoachSelect;

export type CoachListRecord = Prisma.CoachGetPayload<{ select: typeof coachListFields }>;

/** Тренер в карточке тренировки — ровно то, что берёт `trainingListItemViewSchema`. */
export const trainingCoachFields = {
  id: true,
  slug: true,
  playerId: true,
  player: { select: coachPlayerFields },
  photoUrl: true,
  city: { select: cityRefFields },
  languages: true,
} as const satisfies Prisma.CoachSelect;

export const trainingFields = {
  ...serviceFields,
  coach: { select: trainingCoachFields },
} as const satisfies Prisma.CoachServiceSelect;

export type TrainingRecord = Prisma.CoachServiceGetPayload<{ select: typeof trainingFields }>;

type PlayerRecord = CoachRecord['player'];
type ServiceRecord = CoachRecord['services'][number];
type CredentialRecord = CoachRecord['credentials'][number];

/**
 * Кто смотрит. Владелец страницы и администратор видят причину отказа,
 * пути загрузки сканов и непубличные сканы; остальные — только метки.
 */
export interface CoachViewer {
  readonly privileged: boolean;
}

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

export function toServiceView(service: ServiceRecord): CoachServiceView {
  return { ...service };
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
    services: coach.services.map(toServiceView),
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
  const prices = coach.services.flatMap((service) =>
    service.priceKzt === null ? [] : [service.priceKzt],
  );

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
    servicesCount: coach.services.length,
    studentsCount,
    profileReviewedAt: coach.profileReviewedAt?.toISOString() ?? null,
  };
}

export function toTrainingView(
  training: TrainingRecord,
  studentsCount: number,
): TrainingListItemView {
  const { coach, ...service } = training;

  return {
    ...toServiceView(service),
    coach: {
      id: coach.id,
      slug: coach.slug,
      player: toPlayerRef(coach.player),
      photoUrl: coach.photoUrl,
      city: coach.city,
      languages: coach.languages,
      studentsCount,
    },
  };
}
