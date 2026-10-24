import { DUEL_CONFIRM_HOURS } from '@kttf/shared/rating';
import type {
  DuelBestOf,
  DuelItemView,
  DuelPlayer,
  DuelRatingChange,
  DuelResponseView,
  DuelResult,
  DuelView,
} from '@kttf/shared/types';

import type { Prisma } from '../../generated/prisma/client.js';
import { cityRefFields } from '../places/place.fields.js';

/**
 * Выборки и отображение дуэлей — ADR-065, `docs/13`. Игрок показывается
 * с рейтингом на момент чтения: на доске важно, с кем играешь сейчас, а
 * рейтинг на момент начисления хранит журнал (`ratingChanges`).
 */

const HOUR_MS = 60 * 60 * 1000;

/** Игрок дуэли: имя, рейтинг, город — и аккаунт, чтобы слать уведомления. */
export const sideFields = {
  id: true,
  userId: true,
  lastName: true,
  firstName: true,
  photoUrl: true,
  rating: true,
  ratedMatches: true,
  isProvisional: true,
  city: { select: cityRefFields },
} as const satisfies Prisma.PlayerSelect;

export type SideRecord = Prisma.PlayerGetPayload<{ select: typeof sideFields }>;

/** Строка списка: всё, кроме откликов и журнала. */
export const duelFields = {
  id: true,
  kind: true,
  rated: true,
  bestOf: true,
  status: true,
  authorId: true,
  challenge: true,
  opponentId: true,
  venueName: true,
  venueAddress: true,
  note: true,
  slotsFrom: true,
  slotsUntil: true,
  startsAt: true,
  endsAt: true,
  winnerId: true,
  winnerSets: true,
  loserSets: true,
  reportedById: true,
  reportedAt: true,
  confirmedAt: true,
  disputeComment: true,
  resolutionComment: true,
  ratingSkipped: true,
  provisional: true,
  annulledAt: true,
  annulReason: true,
  createdAt: true,
  author: { select: sideFields },
  opponent: { select: sideFields },
  club: { select: { id: true, name: true, address: true } },
  city: { select: cityRefFields },
  slots: { select: { id: true, startsAt: true, endsAt: true }, orderBy: { startsAt: 'asc' } },
  // Счётчик новых откликов — метка автору на доске и в «Моих дуэлях».
  _count: { select: { responses: { where: { status: 'NEW' } } } },
} as const satisfies Prisma.DuelSelect;

export type DuelRecord = Prisma.DuelGetPayload<{ select: typeof duelFields }>;

export const responseFields = {
  id: true,
  duelId: true,
  playerId: true,
  slotId: true,
  proposedStartsAt: true,
  proposedEndsAt: true,
  message: true,
  status: true,
  createdAt: true,
  player: { select: sideFields },
} as const satisfies Prisma.DuelResponseSelect;

export type ResponseRecord = Prisma.DuelResponseGetPayload<{ select: typeof responseFields }>;

/** Начисление по дуэли — события `MATCH` журнала, обратные сюда не входят. */
export const ratingChangeFields = {
  playerId: true,
  ratingBefore: true,
  delta: true,
  ratingAfter: true,
} as const satisfies Prisma.RatingEventSelect;

export type RatingChangeRecord = Prisma.RatingEventGetPayload<{
  select: typeof ratingChangeFields;
}>;

/** Кто смотрит: профиль игрока, если он есть. Аноним — оба `null`. */
export interface DuelViewer {
  readonly userId: string | null;
  readonly playerId: string | null;
}

export const ANONYMOUS_VIEWER: DuelViewer = { userId: null, playerId: null };

export function playerName(player: { lastName: string; firstName: string }): string {
  return `${player.lastName} ${player.firstName}`;
}

export function toDuelPlayer(player: SideRecord): DuelPlayer {
  return {
    id: player.id,
    name: playerName(player),
    photoUrl: player.photoUrl,
    rating: player.rating.toString(),
    isProvisional: player.isProvisional,
    city: player.city,
  };
}

/** Срок подтверждения счёта. */
export function confirmByOf(reportedAt: Date): Date {
  return new Date(reportedAt.getTime() + DUEL_CONFIRM_HOURS * HOUR_MS);
}

function toResult(record: DuelRecord): DuelResult | null {
  const { winnerId, winnerSets, loserSets, reportedById, reportedAt } = record;

  if (
    winnerId === null ||
    winnerSets === null ||
    loserSets === null ||
    reportedById === null ||
    reportedAt === null
  ) {
    return null;
  }

  return {
    winnerId,
    winnerSets,
    loserSets,
    reportedById,
    reportedAt: reportedAt.toISOString(),
    confirmBy: confirmByOf(reportedAt).toISOString(),
    confirmedAt: record.confirmedAt?.toISOString() ?? null,
    disputeComment: record.disputeComment,
    resolutionComment: record.resolutionComment,
  };
}

export function toDuelItem(
  record: DuelRecord,
  viewer: DuelViewer,
  changes: readonly RatingChangeRecord[],
): DuelItemView {
  const isAuthor = viewer.playerId !== null && viewer.playerId === record.authorId;

  return {
    id: record.id,
    kind: record.kind,
    rated: record.rated,
    // В базе — число: формат проверен при создании (`duelBestOfSchema`).
    bestOf: record.bestOf as DuelBestOf | null,
    status: record.status,
    author: toDuelPlayer(record.author),
    opponent: record.opponent === null ? null : toDuelPlayer(record.opponent),
    venue: {
      club: record.club,
      venueName: record.venueName,
      venueAddress: record.venueAddress,
      city: record.city,
    },
    slots: record.slots.map((slot) => ({
      id: slot.id,
      startsAt: slot.startsAt.toISOString(),
      endsAt: slot.endsAt.toISOString(),
    })),
    startsAt: record.startsAt?.toISOString() ?? null,
    endsAt: record.endsAt?.toISOString() ?? null,
    note: record.note,
    // Сколько новых откликов — дело автора: остальным это знать незачем.
    responsesNew: isAuthor ? record._count.responses : null,
    result: toResult(record),
    ratingChanges: changes.map(toRatingChange),
    createdAt: record.createdAt.toISOString(),
  };
}

export function toResponseView(record: ResponseRecord): DuelResponseView {
  return {
    id: record.id,
    player: toDuelPlayer(record.player),
    slotId: record.slotId,
    proposedStartsAt: record.proposedStartsAt?.toISOString() ?? null,
    proposedEndsAt: record.proposedEndsAt?.toISOString() ?? null,
    message: record.message,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
  };
}

export function toRatingChange(record: RatingChangeRecord): DuelRatingChange {
  return {
    playerId: record.playerId,
    ratingBefore: record.ratingBefore.toString(),
    delta: record.delta.toString(),
    ratingAfter: record.ratingAfter.toString(),
  };
}

/**
 * Какие действия доступны смотрящему — те же правила, что проверяет сервис
 * при самом действии. Пределы за сутки сюда не входят: их узнают по отказу,
 * а кнопка без них не врёт о правилах дуэли.
 */
export function duelCan(
  record: DuelRecord,
  viewer: DuelViewer,
  ownNewResponse: boolean,
  now: Date,
): DuelView['can'] {
  const me = viewer.playerId;
  const none = {
    respond: false,
    withdraw: false,
    decline: false,
    cancel: false,
    report: false,
    confirm: false,
    dispute: false,
  };

  if (me === null) return none;

  const isAuthor = me === record.authorId;
  const isOpponent = me === record.opponentId;
  const isParticipant = isAuthor || isOpponent;
  const status = record.status;
  const reportedByOther =
    isParticipant && record.reportedById !== null && record.reportedById !== me;

  return {
    respond:
      !isAuthor && !ownNewResponse && (status === 'OPEN' || (status === 'CHALLENGE' && isOpponent)),
    withdraw: ownNewResponse,
    decline: status === 'CHALLENGE' && isOpponent,
    cancel:
      (isAuthor && (status === 'OPEN' || status === 'CHALLENGE' || status === 'SCHEDULED')) ||
      (isOpponent && status === 'SCHEDULED'),
    report:
      isParticipant &&
      record.rated &&
      status === 'SCHEDULED' &&
      record.startsAt !== null &&
      record.startsAt.getTime() <= now.getTime(),
    confirm: status === 'REPORTED' && reportedByOther,
    dispute: status === 'REPORTED' && reportedByOther,
  };
}

export function toDuelView(
  record: DuelRecord,
  viewer: DuelViewer,
  responses: readonly ResponseRecord[],
  changes: readonly RatingChangeRecord[],
  now: Date,
): DuelView {
  const isAuthor = viewer.playerId !== null && viewer.playerId === record.authorId;
  // Автору — все отклики, остальным — только свой: чужие сообщения не для них.
  const visible = isAuthor
    ? responses
    : responses.filter((response) => response.playerId === viewer.playerId);
  const ownNewResponse = responses.some(
    (response) => response.playerId === viewer.playerId && response.status === 'NEW',
  );

  return {
    ...toDuelItem(record, viewer, changes),
    responses: visible.map(toResponseView),
    annulledAt: record.annulledAt?.toISOString() ?? null,
    annulReason: record.annulReason,
    ratingSkipped: record.ratingSkipped,
    can: duelCan(record, viewer, ownNewResponse, now),
  };
}
