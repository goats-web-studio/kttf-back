import type { ClubView } from '@kttf/shared/types';

import type { Prisma } from '../../generated/prisma/client.js';
import { cityRefFields } from '../places/place.fields.js';

/**
 * Поля клуба в ответах.
 *
 * `balance`, `tariffId`, `plan` сюда не входят намеренно: финансы и тариф
 * клуба — не публичная карточка. `hiddenAt` уходит наружу признаком
 * `hidden`, без даты.
 */
export const clubFields = {
  id: true,
  name: true,
  shortName: true,
  city: { select: cityRefFields },
  address: true,
  lat: true,
  lng: true,
  tableCount: true,
  phone: true,
  whatsapp: true,
  instagram: true,
  logoUrl: true,
  description: true,
  coverUrl: true,
  website: true,
  telegram: true,
  twoGisUrl: true,
  amenities: true,
  tableBrand: true,
  floorType: true,
  ceilingHeightCm: true,
  hoursNote: true,
  primaryContact: true,
  profileReviewedAt: true,
  hiddenAt: true,
  createdAt: true,
  hours: {
    select: { weekday: true, opensMin: true, closesMin: true },
    orderBy: [{ weekday: 'asc' }, { opensMin: 'asc' }],
  },
  prices: {
    select: { id: true, kind: true, title: true, priceKzt: true, unit: true, note: true },
    orderBy: { sortOrder: 'asc' },
  },
} as const satisfies Prisma.ClubSelect;

export type ClubRecord = Prisma.ClubGetPayload<{ select: typeof clubFields }>;

export function toClubView(club: ClubRecord): ClubView {
  const { hiddenAt, profileReviewedAt, createdAt, ...rest } = club;

  return {
    ...rest,
    profileReviewedAt: profileReviewedAt?.toISOString() ?? null,
    hidden: hiddenAt !== null,
    createdAt: createdAt.toISOString(),
  };
}
