import { ONLINE_WINDOW_MS, type ForumBirthday, type ForumOnline } from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { clubDate } from '../clubs/club-stats.service.js';

/** Сколько именинников показывает блок. */
const BIRTHDAYS_MAX = 30;

/**
 * Блоки сбоку на форуме — ADR-067 §6, как у RTTF: «Сейчас на сайте» и
 * «Дни рождения».
 */
@Injectable()
export class ForumSidebarService {
  constructor(private readonly prisma: PrismaService) {}

  /** Игроков на сайте: заходили последние `ONLINE_WINDOW_MS` (ADR-050). */
  async online(now = new Date()): Promise<ForumOnline> {
    const players = await this.prisma.user.count({
      where: {
        lastSeenAt: { gte: new Date(now.getTime() - ONLINE_WINDOW_MS) },
        player: { isNot: null },
      },
    });

    return { players };
  }

  /**
   * Именинники сегодня по времени Казахстана. Только игроки с аккаунтом,
   * которые показывают дату рождения целиком (ADR-037): у остальных
   * посторонним виден лишь год, и день рождения выдал бы скрытое.
   */
  async birthdays(now = new Date()): Promise<ForumBirthday[]> {
    const today = clubDate(now);
    const month = today.getUTCMonth() + 1;
    const day = today.getUTCDate();
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        lastName: string;
        firstName: string;
        photoUrl: string | null;
        rating: string;
        birthDate: Date;
      }[]
    >`
      SELECT p."id", p."lastName", p."firstName", p."photoUrl", p."rating"::text AS "rating", p."birthDate"
      FROM "Player" p
      WHERE p."userId" IS NOT NULL
        AND p."birthDate" IS NOT NULL
        AND p."birthYearOnly" = false
        AND EXTRACT(MONTH FROM p."birthDate") = ${month}
        AND EXTRACT(DAY FROM p."birthDate") = ${day}
      ORDER BY p."rating" DESC
      LIMIT ${BIRTHDAYS_MAX}
    `;

    return rows.map((row) => ({
      playerId: row.id,
      name: `${row.lastName} ${row.firstName}`,
      photoUrl: row.photoUrl,
      rating: Number(row.rating),
      age: today.getUTCFullYear() - row.birthDate.getUTCFullYear(),
    }));
  }
}
