import type { ClubMediaView, ClubPostView } from '@kttf/shared/types';

import type { Prisma } from '../../generated/prisma/client.js';

export const postFields = {
  id: true,
  clubId: true,
  kind: true,
  title: true,
  body: true,
  imageUrl: true,
  validUntil: true,
  pinnedAt: true,
  publishedAt: true,
  editedAt: true,
  hiddenAt: true,
  hiddenReason: true,
} as const satisfies Prisma.ClubPostSelect;

type PostRecord = Prisma.ClubPostGetPayload<{ select: typeof postFields }>;

export function toPostView(post: PostRecord): ClubPostView {
  return {
    id: post.id,
    clubId: post.clubId,
    kind: post.kind,
    title: post.title,
    body: post.body,
    imageUrl: post.imageUrl,
    validUntil: post.validUntil === null ? null : isoDate(post.validUntil),
    pinned: post.pinnedAt !== null,
    publishedAt: post.publishedAt.toISOString(),
    editedAt: post.editedAt?.toISOString() ?? null,
    hidden: post.hiddenAt !== null,
    hiddenReason: post.hiddenReason,
  };
}

export const mediaFields = {
  id: true,
  clubId: true,
  kind: true,
  imageUrl: true,
  youtubeId: true,
  width: true,
  height: true,
  caption: true,
  createdAt: true,
  hiddenAt: true,
} as const satisfies Prisma.ClubMediaSelect;

type MediaRecord = Prisma.ClubMediaGetPayload<{ select: typeof mediaFields }>;

export function toMediaView(media: MediaRecord): ClubMediaView {
  const { hiddenAt, createdAt, ...rest } = media;

  return { ...rest, createdAt: createdAt.toISOString(), hidden: hiddenAt !== null };
}

/** `@db.Date` приходит полночью UTC той же календарной даты. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Дата `YYYY-MM-DD` — в полночь UTC, как её хранит `@db.Date`. */
export function dateOf(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}
