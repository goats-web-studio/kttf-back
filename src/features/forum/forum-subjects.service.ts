import type { ForumSubject, ForumSubjectType } from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { subjectKey } from './forum-views.js';

/**
 * Предмет темы — турнир, клуб, тренер, товар (ADR-064 §7). Ссылка без
 * внешнего ключа: предметы в четырёх таблицах, а удалённый предмет не уносит
 * разговор о нём — тема остаётся, ссылки на предмет у неё больше нет.
 */
@Injectable()
export class ForumSubjectsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Предмет, о котором можно говорить публично: опубликованный турнир,
   * не скрытый клуб, одобренная страница тренера, опубликованный товар.
   */
  async findPublic(type: ForumSubjectType, id: string): Promise<ForumSubject | null> {
    switch (type) {
      case 'TOURNAMENT': {
        const row = await this.prisma.tournament.findFirst({
          where: { id, status: { not: 'DRAFT' } },
          select: { id: true, name: true },
        });

        return row === null ? null : { type, id: row.id, name: row.name, slug: null };
      }
      case 'CLUB': {
        const row = await this.prisma.club.findFirst({
          where: { id, hiddenAt: null },
          select: { id: true, name: true },
        });

        return row === null ? null : { type, id: row.id, name: row.name, slug: null };
      }
      case 'COACH': {
        const row = await this.prisma.coach.findFirst({
          where: { id, status: 'APPROVED', hiddenAt: null },
          select: { id: true, slug: true, player: { select: { lastName: true, firstName: true } } },
        });

        return row === null ? null : coachSubject(row);
      }
      case 'PRODUCT': {
        const row = await this.prisma.product.findFirst({
          where: { id, status: 'PUBLISHED', hiddenAt: null },
          select: { id: true, name: true, slug: true },
        });

        return row === null ? null : { type, id: row.id, name: row.name, slug: row.slug };
      }
    }
  }

  /**
   * Предметы списка тем одним заходом на тип. Без проверки публичности:
   * тема уже существует, ей нужна только подпись и ссылка.
   */
  async describe(
    pairs: readonly { subjectType: ForumSubjectType | null; subjectId: string | null }[],
  ): Promise<Map<string, ForumSubject>> {
    const ids = new Map<ForumSubjectType, Set<string>>();

    for (const { subjectType, subjectId } of pairs) {
      if (subjectType === null || subjectId === null) continue;
      ids.set(subjectType, (ids.get(subjectType) ?? new Set()).add(subjectId));
    }

    const of = (type: ForumSubjectType): string[] => [...(ids.get(type) ?? [])];
    const [tournaments, clubs, coaches, products] = await Promise.all([
      ids.has('TOURNAMENT')
        ? this.prisma.tournament.findMany({
            where: { id: { in: of('TOURNAMENT') } },
            select: { id: true, name: true },
          })
        : [],
      ids.has('CLUB')
        ? this.prisma.club.findMany({
            where: { id: { in: of('CLUB') } },
            select: { id: true, name: true },
          })
        : [],
      ids.has('COACH')
        ? this.prisma.coach.findMany({
            where: { id: { in: of('COACH') } },
            select: {
              id: true,
              slug: true,
              player: { select: { lastName: true, firstName: true } },
            },
          })
        : [],
      ids.has('PRODUCT')
        ? this.prisma.product.findMany({
            where: { id: { in: of('PRODUCT') } },
            select: { id: true, name: true, slug: true },
          })
        : [],
    ]);

    const result = new Map<string, ForumSubject>();
    const put = (subject: ForumSubject): void => {
      result.set(subjectKey(subject.type, subject.id), subject);
    };

    tournaments.forEach((row) => {
      put({ type: 'TOURNAMENT', id: row.id, name: row.name, slug: null });
    });
    clubs.forEach((row) => {
      put({ type: 'CLUB', id: row.id, name: row.name, slug: null });
    });
    coaches.forEach((row) => {
      put(coachSubject(row));
    });
    products.forEach((row) => {
      put({ type: 'PRODUCT', id: row.id, name: row.name, slug: row.slug });
    });

    return result;
  }
}

function coachSubject(row: {
  id: string;
  slug: string;
  player: { lastName: string; firstName: string };
}): ForumSubject {
  return {
    type: 'COACH',
    id: row.id,
    name: `${row.player.lastName} ${row.player.firstName}`,
    slug: row.slug,
  };
}
