import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import type { IncomingTrialRequestView, TrialRequestView, TrialTarget } from '@kttf/shared/types';

import type { Prisma } from '../../generated/prisma/client.js';
import { coachPageFields, publicCoachSlug } from '../players/coach-ref.js';

/** Заявка глазами отправителя: тренировка и адресат одним запросом. */
export const trialFields = {
  id: true,
  status: true,
  userId: true,
  targetKind: true,
  coachId: true,
  clubId: true,
  forWhom: true,
  childAge: true,
  preferredTime: true,
  comment: true,
  reply: true,
  source: true,
  createdAt: true,
  answeredAt: true,
  training: { select: { id: true, title: true } },
  coach: {
    select: {
      ...coachPageFields,
      id: true,
      userId: true,
      phone: true,
      whatsapp: true,
      player: { select: { lastName: true, firstName: true } },
    },
  },
  club: { select: { id: true, name: true, phone: true, whatsapp: true } },
} as const satisfies Prisma.TrialRequestSelect;

/** Аккаунт в объёме, нужном для имени отправителя. */
export const requesterFields = {
  phone: true,
  login: true,
  player: { select: { id: true, lastName: true, firstName: true } },
} as const satisfies Prisma.UserSelect;

/** Плюс отправитель — для адресата. */
export const incomingTrialFields = {
  ...trialFields,
  user: { select: requesterFields },
} as const satisfies Prisma.TrialRequestSelect;

export type TrialRecord = Prisma.TrialRequestGetPayload<{ select: typeof trialFields }>;
export type IncomingTrialRecord = Prisma.TrialRequestGetPayload<{
  select: typeof incomingTrialFields;
}>;

type RequesterRecord = Prisma.UserGetPayload<{ select: typeof requesterFields }>;

/** Имя отправителя: из профиля игрока, без профиля — логин, без логина — телефон. */
export function requesterName(user: RequesterRecord): string {
  if (user.player !== null) return `${user.player.lastName} ${user.player.firstName}`;

  return user.login ?? user.phone;
}

/** Адресат по снимку в заявке. Снимок держится каскадом: без адресата заявки нет. */
export function targetOf(record: TrialRecord): TrialTarget {
  if (record.targetKind === 'COACH' && record.coach !== null) {
    return {
      kind: 'COACH',
      id: record.coach.id,
      name: `${record.coach.player.lastName} ${record.coach.player.firstName}`,
      // Скрытая или снятая страница по ссылке не откроется.
      slug: publicCoachSlug(record.coach),
      phone: record.coach.phone,
      whatsapp: record.coach.whatsapp,
    };
  }

  if (record.targetKind === 'CLUB' && record.club !== null) {
    return {
      kind: 'CLUB',
      id: record.club.id,
      name: record.club.name,
      slug: null,
      phone: record.club.phone,
      whatsapp: record.club.whatsapp,
    };
  }

  throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Trial request without target', {
    id: record.id,
  });
}

export function toTrialRequestView(record: TrialRecord): TrialRequestView {
  return {
    id: record.id,
    status: record.status,
    training: record.training,
    target: targetOf(record),
    forWhom: record.forWhom,
    childAge: record.childAge,
    preferredTime: record.preferredTime,
    comment: record.comment,
    reply: record.reply,
    createdAt: record.createdAt.toISOString(),
    answeredAt: record.answeredAt?.toISOString() ?? null,
  };
}

export function toIncomingTrialRequestView(record: IncomingTrialRecord): IncomingTrialRequestView {
  return {
    ...toTrialRequestView(record),
    requester: {
      name: requesterName(record.user),
      phone: record.user.phone,
      playerId: record.user.player?.id ?? null,
    },
    source: record.source,
  };
}
