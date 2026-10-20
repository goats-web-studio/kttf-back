import type { CoachListItemView, ListCoachesQuery, Page } from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { pageOf, skipOf } from '../../common/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { nameWords } from '../players/players.service.js';
import { countStudents } from './coach-students.js';
import { COACH_ORDER, PUBLIC_COACH, coachListFields, toListItemView } from './coach-view.js';

export function coachesWhere(query: ListCoachesQuery): Prisma.CoachWhereInput {
  return {
    ...PUBLIC_COACH,
    ...(query.cityId === undefined ? {} : { cityId: { in: query.cityId } }),
    ...(query.language === undefined ? {} : { languages: { has: query.language } }),
    ...(query.search === undefined ? {} : { player: { AND: nameWords(query.search) } }),
  };
}

/** Тренеры опубликованных страниц — переключатель «Тренеры» и выбор тренера в анкете. */
@Injectable()
export class CoachCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListCoachesQuery): Promise<Page<CoachListItemView>> {
    const where = coachesWhere(query);
    const [rows, total] = await Promise.all([
      this.prisma.coach.findMany({
        where,
        select: coachListFields,
        orderBy: [...COACH_ORDER],
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.coach.count({ where }),
    ]);
    const students = await countStudents(
      this.prisma,
      rows.map((coach) => coach.playerId),
    );

    return pageOf(
      rows.map((coach) => toListItemView(coach, students.get(coach.playerId) ?? 0)),
      total,
      query,
    );
  }
}
