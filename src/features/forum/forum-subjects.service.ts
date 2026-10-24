import type { ForumPostRole, ForumSubject, ForumSubjectType } from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { isoDate } from '../club-content/content-views.js';
import { subjectKey } from './forum-views.js';

/** Предмет темы — тип и идентификатор. */
export interface SubjectRef {
  readonly subjectType: ForumSubjectType | null;
  readonly subjectId: string | null;
}

/**
 * Обсуждаемая сторона (ADR-067 §3): кто говорит за предмет и с какой меткой.
 * `notify` — кому уходят новые сообщения темы: владелец и организаторы клуба,
 * сам тренер. Судья клуба пишет с меткой, но уведомлений не получает.
 */
export interface SubjectSide {
  readonly role: ForumPostRole;
  readonly speakers: ReadonlySet<string>;
  readonly notify: readonly string[];
}

const COACH_SIDE = (userId: string): SubjectSide => ({
  role: 'COACH',
  speakers: new Set([userId]),
  notify: [userId],
});

/**
 * Предмет темы — турнир, клуб, тренер, товар (ADR-064 §7), новость клуба и
 * тренера (ADR-067), дуэль (ADR-068). Ссылка без внешнего ключа: предметы в разных таблицах,
 * а удалённый предмет не уносит разговор о нём — кроме новости: её тема
 * удаляется вместе с записью (`ForumNewsService`).
 */
@Injectable()
export class ForumSubjectsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Предмет, о котором можно говорить публично: опубликованный турнир,
   * не скрытый клуб, одобренная страница тренера, опубликованный товар,
   * не скрытая новость, любая дуэль — её страница открыта всем.
   */
  async findPublic(type: ForumSubjectType, id: string): Promise<ForumSubject | null> {
    const [subject] = (await this.describe([{ subjectType: type, subjectId: id }], true)).values();

    return subject ?? null;
  }

  /**
   * Предметы списка тем одним заходом на тип. `onlyPublic` — только те, о
   * которых можно заводить разговор; для подписи уже существующей темы
   * публичность не проверяется.
   */
  async describe(
    pairs: readonly SubjectRef[],
    onlyPublic = false,
  ): Promise<Map<string, ForumSubject>> {
    const ids = groupIds(pairs);
    const of = (type: ForumSubjectType): string[] => [...(ids.get(type) ?? [])];
    const has = (type: ForumSubjectType): boolean => ids.has(type);
    const coachPublic = { status: 'APPROVED', hiddenAt: null } as const;
    const coachPlayer = { select: { lastName: true, firstName: true } } as const;

    const [tournaments, clubs, coaches, products, clubPosts, coachPosts, duels] = await Promise.all(
      [
        has('TOURNAMENT')
          ? this.prisma.tournament.findMany({
              where: {
                id: { in: of('TOURNAMENT') },
                ...(onlyPublic ? { status: { not: 'DRAFT' } } : {}),
              },
              select: { id: true, name: true },
            })
          : [],
        has('CLUB')
          ? this.prisma.club.findMany({
              where: { id: { in: of('CLUB') }, ...(onlyPublic ? { hiddenAt: null } : {}) },
              select: { id: true, name: true },
            })
          : [],
        has('COACH')
          ? this.prisma.coach.findMany({
              where: { id: { in: of('COACH') }, ...(onlyPublic ? coachPublic : {}) },
              select: { id: true, slug: true, player: coachPlayer },
            })
          : [],
        has('PRODUCT')
          ? this.prisma.product.findMany({
              where: {
                id: { in: of('PRODUCT') },
                ...(onlyPublic ? { status: 'PUBLISHED', hiddenAt: null } : {}),
              },
              select: { id: true, name: true, slug: true },
            })
          : [],
        has('CLUB_POST')
          ? this.prisma.clubPost.findMany({
              where: {
                id: { in: of('CLUB_POST') },
                ...(onlyPublic ? { hiddenAt: null, club: { hiddenAt: null } } : {}),
              },
              select: {
                id: true,
                title: true,
                kind: true,
                imageUrl: true,
                validUntil: true,
                club: { select: { id: true, name: true, logoUrl: true } },
              },
            })
          : [],
        has('COACH_POST')
          ? this.prisma.coachPost.findMany({
              where: {
                id: { in: of('COACH_POST') },
                ...(onlyPublic ? { hiddenAt: null, coach: coachPublic } : {}),
              },
              select: {
                id: true,
                title: true,
                kind: true,
                imageUrl: true,
                validUntil: true,
                coach: { select: { id: true, slug: true, photoUrl: true, player: coachPlayer } },
              },
            })
          : [],
        has('DUEL')
          ? this.prisma.duel.findMany({
              where: { id: { in: of('DUEL') } },
              select: duelSubjectFields,
            })
          : [],
      ],
    );

    const result = new Map<string, ForumSubject>();
    const put = (subject: Omit<ForumSubject, 'owner' | 'news'> & Partial<ForumSubject>): void => {
      result.set(subjectKey(subject.type, subject.id), {
        owner: null,
        news: null,
        ...subject,
      });
    };

    tournaments.forEach((row) => {
      put({ type: 'TOURNAMENT', id: row.id, name: row.name, slug: null });
    });
    clubs.forEach((row) => {
      put({ type: 'CLUB', id: row.id, name: row.name, slug: null });
    });
    coaches.forEach((row) => {
      put({ type: 'COACH', id: row.id, name: fullName(row.player), slug: row.slug });
    });
    products.forEach((row) => {
      put({ type: 'PRODUCT', id: row.id, name: row.name, slug: row.slug });
    });
    clubPosts.forEach((row) => {
      put({
        type: 'CLUB_POST',
        id: row.id,
        name: row.title,
        slug: null,
        owner: {
          kind: 'CLUB',
          id: row.club.id,
          slug: null,
          name: row.club.name,
          logoUrl: row.club.logoUrl,
        },
        news: {
          kind: row.kind,
          imageUrl: row.imageUrl,
          validUntil: row.validUntil === null ? null : isoDate(row.validUntil),
        },
      });
    });
    coachPosts.forEach((row) => {
      put({
        type: 'COACH_POST',
        id: row.id,
        name: row.title,
        slug: null,
        owner: {
          kind: 'COACH',
          id: row.coach.id,
          slug: row.coach.slug,
          name: fullName(row.coach.player),
          logoUrl: row.coach.photoUrl,
        },
        news: {
          kind: row.kind,
          imageUrl: row.imageUrl,
          validUntil: row.validUntil === null ? null : isoDate(row.validUntil),
        },
      });
    });
    duels.forEach((row) => {
      put(duelSubject(row));
    });

    return result;
  }

  /**
   * Обсуждаемые стороны тем (ADR-067 §3): за турнир говорит состав
   * клуба-хозяина, за клуб и его новости — состав клуба, за тренера и его
   * новости — сам тренер. У товара стороны нет.
   */
  async sides(pairs: readonly SubjectRef[]): Promise<Map<string, SubjectSide>> {
    const ids = groupIds(pairs);
    const of = (type: ForumSubjectType): string[] => [...(ids.get(type) ?? [])];

    const [tournaments, clubPosts, coaches, coachPosts] = await Promise.all([
      ids.has('TOURNAMENT')
        ? this.prisma.tournament.findMany({
            where: { id: { in: of('TOURNAMENT') } },
            select: { id: true, clubId: true },
          })
        : [],
      ids.has('CLUB_POST')
        ? this.prisma.clubPost.findMany({
            where: { id: { in: of('CLUB_POST') } },
            select: { id: true, clubId: true },
          })
        : [],
      ids.has('COACH')
        ? this.prisma.coach.findMany({
            where: { id: { in: of('COACH') } },
            select: { id: true, userId: true },
          })
        : [],
      ids.has('COACH_POST')
        ? this.prisma.coachPost.findMany({
            where: { id: { in: of('COACH_POST') } },
            select: { id: true, coach: { select: { userId: true } } },
          })
        : [],
    ]);

    // Клуб каждой темы — сам клуб, клуб турнира или клуб новости.
    const clubOf = new Map<string, { clubId: string; role: ForumPostRole }>();
    for (const id of of('CLUB')) clubOf.set(subjectKey('CLUB', id), { clubId: id, role: 'CLUB' });
    for (const row of tournaments) {
      clubOf.set(subjectKey('TOURNAMENT', row.id), { clubId: row.clubId, role: 'ORGANIZER' });
    }
    for (const row of clubPosts) {
      clubOf.set(subjectKey('CLUB_POST', row.id), { clubId: row.clubId, role: 'CLUB' });
    }

    const clubIds = [...new Set([...clubOf.values()].map((value) => value.clubId))];
    const members =
      clubIds.length === 0
        ? []
        : await this.prisma.clubMember.findMany({
            where: { clubId: { in: clubIds } },
            select: { clubId: true, userId: true, role: true },
          });

    const result = new Map<string, SubjectSide>();

    for (const [key, { clubId, role }] of clubOf) {
      const staff = members.filter((member) => member.clubId === clubId);

      result.set(key, {
        role,
        speakers: new Set(staff.map((member) => member.userId)),
        notify: staff
          .filter((member) => member.role === 'OWNER' || member.role === 'ORGANIZER')
          .map((member) => member.userId),
      });
    }
    for (const row of coaches) result.set(subjectKey('COACH', row.id), COACH_SIDE(row.userId));
    for (const row of coachPosts) {
      result.set(subjectKey('COACH_POST', row.id), COACH_SIDE(row.coach.userId));
    }

    return result;
  }
}

function groupIds(pairs: readonly SubjectRef[]): Map<ForumSubjectType, Set<string>> {
  const ids = new Map<ForumSubjectType, Set<string>>();

  for (const { subjectType, subjectId } of pairs) {
    if (subjectType === null || subjectId === null) continue;
    ids.set(subjectType, (ids.get(subjectType) ?? new Set()).add(subjectId));
  }

  return ids;
}

function fullName(player: { lastName: string; firstName: string }): string {
  return `${player.lastName} ${player.firstName}`;
}

const duelSubjectFields = {
  id: true,
  kind: true,
  author: { select: { lastName: true } },
  opponent: { select: { lastName: true } },
} as const;

/**
 * Подпись дуэли (ADR-068): «Дуэль: Петров — Аманбаев», у публикации без
 * соперника — «Дуэль: Петров ищет соперника». По фамилиям: в списке тем
 * полное имя двоих не помещается, а страница дуэли — по ссылке.
 */
export function duelSubject(row: {
  id: string;
  kind: 'DUEL' | 'SPARRING';
  author: { lastName: string };
  opponent: { lastName: string } | null;
}): ForumSubject {
  const kind = row.kind === 'DUEL' ? 'Дуэль' : 'Спарринг';
  const players =
    row.opponent === null
      ? `${row.author.lastName} ищет соперника`
      : `${row.author.lastName} — ${row.opponent.lastName}`;

  return {
    type: 'DUEL',
    id: row.id,
    name: `${kind}: ${players}`,
    slug: null,
    owner: null,
    news: null,
  };
}
