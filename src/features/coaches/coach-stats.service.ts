import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  coachLimits,
  isCoachPublic,
  type CoachEventInput,
  type CoachEventKind,
  type CoachStatsView,
} from '@kttf/shared/types';
import { Inject, Injectable } from '@nestjs/common';

import { RepeatFilter } from '../../common/repeat-filter.js';
import { ENV, type Env } from '../../infra/config/env.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { clubDate } from '../clubs/club-stats.service.js';

/** Колонка счётчика на каждый вид события. */
const COLUMNS = {
  VIEW: 'views',
  PHONE: 'phoneClicks',
  WHATSAPP: 'whatsappClicks',
  TELEGRAM: 'telegramClicks',
  INSTAGRAM: 'instagramClicks',
} as const satisfies Record<CoachEventKind, string>;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Статистика страницы тренера — ADR-059, механика `ClubStatDaily` (ADR-055).
 *
 * Дневные счётчики без персональных данных: ни адреса, ни cookie в базу не
 * попадают. Считается только опубликованная страница: просмотры черновика —
 * это сам тренер и администратор.
 */
@Injectable()
export class CoachStatsService {
  private readonly repeats: RepeatFilter;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) env: Env,
  ) {
    this.repeats = new RepeatFilter(env.JWT_SECRET);
  }

  async record(
    coachId: string,
    event: CoachEventInput,
    ip: string,
    now = new Date(),
  ): Promise<void> {
    if (this.repeats.isRepeat(ip, `coach:${coachId}:${event.kind}`, now)) return;

    const coach = await this.prisma.coach.findUnique({
      where: { id: coachId },
      select: { status: true, hiddenAt: true },
    });

    // Чужой идентификатор и неопубликованная страница молча не считаются:
    // отказ подсказал бы, какие страницы есть.
    if (
      coach === null ||
      !isCoachPublic({ status: coach.status, hidden: coach.hiddenAt !== null })
    ) {
      return;
    }

    const column = COLUMNS[event.kind];
    const date = clubDate(now);

    await this.prisma.coachStatDaily.upsert({
      where: { coachId_date_source: { coachId, date, source: event.source } },
      create: { coachId, date, source: event.source, [column]: 1 },
      update: { [column]: { increment: 1 } },
    });
  }

  /** Окно статистики. Глубже, чем позволяет план, — отказ, а не тихая обрезка. */
  async stats(coachId: string, days: number, now = new Date()): Promise<CoachStatsView> {
    const coach = await this.prisma.coach.findUnique({
      where: { id: coachId },
      select: { plan: true },
    });

    if (coach === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Coach not found', { id: coachId });
    }

    if (days > coachLimits(coach.plan).statsDays) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Stats window exceeds the plan', {
        field: 'days',
      });
    }

    const to = clubDate(now);
    const from = new Date(to.getTime() - (days - 1) * DAY_MS);

    const rows = await this.prisma.coachStatDaily.findMany({
      where: { coachId, date: { gte: from, lte: to } },
      orderBy: [{ date: 'asc' }, { source: 'asc' }],
    });

    return {
      from: isoDate(from),
      to: isoDate(to),
      rows: rows.map((row) => ({
        date: isoDate(row.date),
        source: row.source,
        views: row.views,
        phone: row.phoneClicks,
        whatsapp: row.whatsappClicks,
        telegram: row.telegramClicks,
        instagram: row.instagramClicks,
      })),
    };
  }
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
