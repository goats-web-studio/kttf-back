import type { ForumDiscussionLink, CoachMediaView, CoachPostView } from '@kttf/shared/types';

import type { Prisma } from '../../generated/prisma/client.js';
import { isoDate } from '../club-content/content-views.js';

export const postFields = {
  id: true,
  coachId: true,
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
} as const satisfies Prisma.CoachPostSelect;

export type PostRecord = Prisma.CoachPostGetPayload<{ select: typeof postFields }>;

export function toPostView(
  post: PostRecord,
  discussion: ForumDiscussionLink | null = null,
): CoachPostView {
  return {
    id: post.id,
    coachId: post.coachId,
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
    discussion,
  };
}

export const mediaFields = {
  id: true,
  coachId: true,
  kind: true,
  imageUrl: true,
  youtubeId: true,
  width: true,
  height: true,
  caption: true,
  createdAt: true,
  hiddenAt: true,
  hiddenReason: true,
} as const satisfies Prisma.CoachMediaSelect;

type MediaRecord = Prisma.CoachMediaGetPayload<{ select: typeof mediaFields }>;

export function toMediaView(media: MediaRecord): CoachMediaView {
  const { hiddenAt, createdAt, ...rest } = media;

  return { ...rest, createdAt: createdAt.toISOString(), hidden: hiddenAt !== null };
}
