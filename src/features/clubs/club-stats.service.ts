import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  CLUB_UTC_OFFSET_MIN,
  clubLimits,
  type ClubEventInput,
  type ClubEventKind,
  type ClubStatsView,
} from '@kttf/shared/types';
import { Inject, Injectable } from '@nestjs/common';

import { RepeatFilter } from '../../common/repeat-filter.js';
import { ENV, type Env } from '../../infra/config/env.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';

/** Колонка счётчика на каждый вид события. */
const COLUMNS = {
  VIEW: 'views',
  PHONE: 'phoneClicks',
  WHATSAPP: 'whatsappClicks',
  TELEGRAM: 'telegramClicks',
  INSTAGRAM: 'instagramClicks',
  WEBSITE: 'websiteClicks',
  ROUTE: 'routeClicks',
  COACH_TRAINING: 'coachTrainingClicks',
} as const satisfies Record<ClubEventKind, string>;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Статистика страницы клуба — ADR-055, решение 4.
 *
 * Дневные счётчики без персональных данных: ни адреса, ни cookie в базу не
 * попадают. Повторы отсекаются в памяти экземпляра — `RepeatFilter`.
 */
@Injectable()
export class ClubStatsService {
  private readonly repeats: RepeatFilter;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) env: Env,
  ) {
    this.repeats = new RepeatFilter(env.JWT_SECRET);
  }

  async record(clubId: string, event: ClubEventInput, ip: string, now = new Date()): Promise<void> {
    if (this.repeats.isRepeat(ip, `club:${clubId}:${event.kind}`, now)) return;

    const club = await this.prisma.club.findUnique({ where: { id: clubId }, select: { id: true } });

    // Чужой идентификатор молча не считается: отказ подсказал бы, какие клубы есть.
    if (club === null) return;

    const column = COLUMNS[event.kind];
    const date = clubDate(now);

    await this.prisma.clubStatDaily.upsert({
      where: { clubId_date_source: { clubId, date, source: event.source } },
      create: { clubId, date, source: event.source, [column]: 1 },
      update: { [column]: { increment: 1 } },
    });
  }

  /** Окно статистики. Глубже, чем позволяет план, — отказ, а не тихая обрезка. */
  async stats(clubId: string, days: number, now = new Date()): Promise<ClubStatsView> {
    const club = await this.prisma.club.findUnique({
      where: { id: clubId },
      select: { plan: true },
    });

    if (club === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Club not found', { id: clubId });
    }

    if (days > clubLimits(club.plan).statsDays) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Stats window exceeds the plan', {
        field: 'days',
      });
    }

    const to = clubDate(now);
    const from = new Date(to.getTime() - (days - 1) * DAY_MS);

    const rows = await this.prisma.clubStatDaily.findMany({
      where: { clubId, date: { gte: from, lte: to } },
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
        website: row.websiteClicks,
        route: row.routeClicks,
        coachTraining: row.coachTrainingClicks,
        trialRequests: row.trialRequests,
      })),
    };
  }
}

/** День по местному времени клуба — полночь UTC той же календарной даты, как хранит `@db.Date`. */
export function clubDate(now: Date): Date {
  const local = new Date(now.getTime() + CLUB_UTC_OFFSET_MIN * 60_000);

  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
