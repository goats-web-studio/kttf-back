import {
  CHILD_AUDIENCES,
  type CoachListItemView,
  type ListCoachesQuery,
  type ListTrainingsQuery,
  type Page,
  type TrainingListItemView,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { pageOf, skipOf } from '../../common/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { nameWords } from '../players/players.service.js';
import { countStudents } from './coach-students.js';
import {
  COACH_ORDER,
  PUBLIC_COACH,
  coachListFields,
  toListItemView,
  toTrainingView,
  trainingFields,
} from './coach-view.js';

/**
 * Условие на тренировки — раздел «Тренировки», `docs/11` 5.2. Только
 * тренировки опубликованных страниц; город и язык — страницы тренера.
 *
 * Аудитория и возраст ограничивают одно поле, поэтому складываются через
 * `AND`: иначе второе условие затёрло бы первое.
 */
export function trainingsWhere(query: ListTrainingsQuery): Prisma.CoachServiceWhereInput {
  const and: Prisma.CoachServiceWhereInput[] = [];

  if (query.audience !== undefined) and.push({ audiences: { hasSome: query.audience } });

  // Возраст ребёнка: тренировка для детей или подростков, которая берёт с
  // этого возраста или младше, либо возраст не указан.
  if (query.age !== undefined) {
    and.push({
      audiences: { hasSome: [...CHILD_AUDIENCES] },
      OR: [{ kidsFromAge: null }, { kidsFromAge: { lte: query.age } }],
    });
  }

  return {
    coach: {
      ...PUBLIC_COACH,
      ...(query.cityId === undefined ? {} : { cityId: { in: query.cityId } }),
      ...(query.language === undefined ? {} : { languages: { has: query.language } }),
    },
    ...(query.kind === undefined ? {} : { kind: { in: query.kind } }),
    ...(query.place === undefined ? {} : { place: { in: query.place } }),
    // Без цены — «по договорённости»: под «цену до» такая не подходит.
    ...(query.priceTo === undefined ? {} : { priceKzt: { not: null, lte: query.priceTo } }),
    ...(and.length === 0 ? {} : { AND: and }),
  };
}

export function coachesWhere(query: ListCoachesQuery): Prisma.CoachWhereInput {
  return {
    ...PUBLIC_COACH,
    ...(query.cityId === undefined ? {} : { cityId: { in: query.cityId } }),
    ...(query.language === undefined ? {} : { languages: { has: query.language } }),
    ...(query.search === undefined ? {} : { player: { AND: nameWords(query.search) } }),
  };
}

/** Публичные списки: тренеры и тренировки. */
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

  /**
   * Порядок — по свежести страницы, внутри страницы — как расставил тренер.
   * `coachId` между ними держит тренировки одного тренера рядом, когда
   * свежесть у двух страниц совпала.
   */
  async trainings(query: ListTrainingsQuery): Promise<Page<TrainingListItemView>> {
    const where = trainingsWhere(query);
    const [rows, total] = await Promise.all([
      this.prisma.coachService.findMany({
        where,
        select: trainingFields,
        orderBy: [
          { coach: { profileReviewedAt: { sort: 'desc', nulls: 'last' } } },
          { coachId: 'asc' },
          { sortOrder: 'asc' },
        ],
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.coachService.count({ where }),
    ]);
    const students = await countStudents(
      this.prisma,
      rows.map((training) => training.coach.playerId),
    );

    return pageOf(
      rows.map((training) => toTrainingView(training, students.get(training.coach.playerId) ?? 0)),
      total,
      query,
    );
  }
}
