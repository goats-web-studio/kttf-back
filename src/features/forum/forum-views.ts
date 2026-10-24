import {
  forumImageSchema,
  ONLINE_WINDOW_MS,
  type ForumAuthor,
  type ForumImage,
  type ForumPostItem,
  type ForumPostRole,
  type ForumPostView,
  type ForumSubject,
  type ForumTopicItem,
} from '@kttf/shared/types';
import { z } from 'zod';

import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Выборки и отображение форума — ADR-064, ADR-067. Автор берётся из профиля
 * игрока на момент чтения: сменил клуб — у старых сообщений тоже новый.
 */

export const authorFields = {
  id: true,
  isAdmin: true,
  lastSeenAt: true,
  player: {
    select: {
      id: true,
      lastName: true,
      firstName: true,
      photoUrl: true,
      rating: true,
      club: { select: { id: true, name: true } },
      coachPage: { select: { slug: true, status: true, hiddenAt: true } },
    },
  },
} satisfies Prisma.UserSelect;

export type AuthorRecord = Prisma.UserGetPayload<{ select: typeof authorFields }>;

/** Только имя — для «последний ответ» и снимков в уведомлениях. */
export const nameFields = {
  player: { select: { lastName: true, firstName: true } },
} satisfies Prisma.UserSelect;

/** Имя без профиля: аккаунт есть, анкеты нет — писать он не мог, но мог раньше. */
const NO_PROFILE = 'Без профиля';

export function authorName(
  user: { player: { lastName: string; firstName: string } | null } | null,
): string | null {
  if (user === null) return null;

  return user.player === null ? NO_PROFILE : `${user.player.lastName} ${user.player.firstName}`;
}

export function toAuthor(user: AuthorRecord | null, now = new Date()): ForumAuthor | null {
  if (user === null) return null;

  const player = user.player;
  const coach = player?.coachPage ?? null;

  return {
    userId: user.id,
    playerId: player?.id ?? null,
    name: authorName(user) ?? NO_PROFILE,
    photoUrl: player?.photoUrl ?? null,
    rating: player === null ? null : Number(player.rating),
    club: player?.club ?? null,
    moderator: user.isAdmin,
    // Метка «Тренер» — только у опубликованной и не скрытой страницы (ADR-059).
    coachSlug:
      coach !== null && coach.status === 'APPROVED' && coach.hiddenAt === null ? coach.slug : null,
    online:
      user.lastSeenAt !== null && now.getTime() - user.lastSeenAt.getTime() <= ONLINE_WINDOW_MS,
  };
}

// ---------------------------------------------------------------- темы

export const topicFields = {
  id: true,
  title: true,
  authorId: true,
  subjectType: true,
  subjectId: true,
  createdAt: true,
  postsCount: true,
  viewsCount: true,
  lastPostAt: true,
  pinnedAt: true,
  lockedAt: true,
  hiddenAt: true,
  hiddenReason: true,
  section: { select: { id: true, slug: true, title: true } },
  author: { select: authorFields },
  lastPostAuthor: { select: nameFields },
} satisfies Prisma.ForumTopicSelect;

export type TopicRecord = Prisma.ForumTopicGetPayload<{ select: typeof topicFields }>;

/** Ключ предмета для словаря: тип и идентификатор. */
export function subjectKey(type: string, id: string): string {
  return `${type}:${id}`;
}

/** Докуда человек дочитал тему: номер последнего прочитанного. */
export type ReadMarks = ReadonlyMap<string, number>;

export function toTopicItem(
  record: TopicRecord,
  subjects: ReadonlyMap<string, ForumSubject>,
  reads: ReadMarks | null = null,
): ForumTopicItem {
  const subject =
    record.subjectType === null || record.subjectId === null
      ? null
      : (subjects.get(subjectKey(record.subjectType, record.subjectId)) ?? null);
  // Тему, которую человек не открывал, «новой» не считаем: иначе весь форум жирный.
  const read = reads?.get(record.id);
  const unread = read === undefined ? null : Math.max(0, record.postsCount - read);

  return {
    id: record.id,
    section: record.section,
    title: record.title,
    author: toAuthor(record.author),
    subject,
    createdAt: record.createdAt.toISOString(),
    postsCount: record.postsCount,
    lastPostAt: record.lastPostAt.toISOString(),
    lastAuthorName: authorName(record.lastPostAuthor),
    pinned: record.pinnedAt !== null,
    locked: record.lockedAt !== null,
    hidden: record.hiddenAt !== null,
    hiddenReason: record.hiddenReason,
    viewsCount: record.viewsCount,
    unread,
    firstUnread: unread === null || unread === 0 || read === undefined ? null : read + 1,
  };
}

// ---------------------------------------------------------------- сообщения

export const postFields = {
  id: true,
  topicId: true,
  authorId: true,
  number: true,
  body: true,
  quotePostId: true,
  quoteText: true,
  images: true,
  likesCount: true,
  createdAt: true,
  editedAt: true,
  deletedAt: true,
  hiddenAt: true,
  hiddenReason: true,
  author: { select: authorFields },
  quotePost: { select: { number: true, author: { select: nameFields } } },
} satisfies Prisma.ForumPostSelect;

export type PostRecord = Prisma.ForumPostGetPayload<{ select: typeof postFields }>;

/** Кто читает: от этого зависит, виден ли текст скрытого сообщения. */
export interface Viewer {
  readonly userId: string | undefined;
  readonly isAdmin: boolean;
}

export const ANONYMOUS: Viewer = { userId: undefined, isAdmin: false };

const imagesSchema = z.array(forumImageSchema);

/** Фото из JSON-колонки. Строка, не прошедшая контракт, не роняет тему. */
export function parseImages(value: Prisma.JsonValue): ForumImage[] {
  const parsed = imagesSchema.safeParse(value);

  return parsed.success ? parsed.data : [];
}

export function toPostView(
  record: PostRecord,
  viewer: Viewer,
  liked: boolean,
  role: ForumPostRole | null = null,
): ForumPostView {
  const mine = viewer.userId !== undefined && record.authorId === viewer.userId;
  const deleted = record.deletedAt !== null;
  const hidden = record.hiddenAt !== null;
  // Удалённое не видит никто; скрытое — автор и администратор.
  const showText = !deleted && (!hidden || mine || viewer.isAdmin);

  return {
    id: record.id,
    topicId: record.topicId,
    number: record.number,
    author: toAuthor(record.author),
    body: showText ? record.body : '',
    quote:
      showText && record.quoteText !== null
        ? {
            postId: record.quotePostId,
            number: record.quotePost?.number ?? null,
            authorName: authorName(record.quotePost?.author ?? null),
            text: record.quoteText,
          }
        : null,
    images: showText ? parseImages(record.images) : [],
    createdAt: record.createdAt.toISOString(),
    editedAt: record.editedAt?.toISOString() ?? null,
    deleted,
    hidden,
    hiddenReason: record.hiddenReason,
    likes: record.likesCount,
    liked,
    mine,
    role,
  };
}

/** Начало текста для лент: по границе слова, с многоточием. */
export function excerptOf(body: string, max = 200): string {
  const flat = body.replace(/\s+/g, ' ').trim();

  if (flat.length <= max) return flat;

  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');

  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export const postItemFields = {
  id: true,
  number: true,
  body: true,
  createdAt: true,
  likesCount: true,
  authorId: true,
  topic: {
    select: {
      id: true,
      title: true,
      subjectType: true,
      subjectId: true,
      section: { select: { slug: true, title: true } },
    },
  },
  author: { select: authorFields },
} satisfies Prisma.ForumPostSelect;

export type PostItemRecord = Prisma.ForumPostGetPayload<{ select: typeof postItemFields }>;

export function toPostItem(
  record: PostItemRecord,
  subjects: ReadonlyMap<string, ForumSubject>,
  role: ForumPostRole | null,
): ForumPostItem {
  const { subjectType, subjectId } = record.topic;

  return {
    id: record.id,
    number: record.number,
    topic: { id: record.topic.id, title: record.topic.title },
    section: record.topic.section,
    subject:
      subjectType === null || subjectId === null
        ? null
        : (subjects.get(subjectKey(subjectType, subjectId)) ?? null),
    author: toAuthor(record.author),
    role,
    excerpt: excerptOf(record.body),
    createdAt: record.createdAt.toISOString(),
    likes: record.likesCount,
  };
}
