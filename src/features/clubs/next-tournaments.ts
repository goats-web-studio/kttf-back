import { CLUB_UTC_OFFSET_MIN } from '@kttf/shared/types';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';

/** Начало сегодняшнего дня по местному времени клуба (UTC+5). */
export function startOfClubDay(now: Date): Date {
  const offset = CLUB_UTC_OFFSET_MIN * 60_000;
  const local = new Date(now.getTime() + offset);

  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offset,
  );
}

/**
 * Ближайший турнир каждого клуба: идущий или назначенный на сегодня и позже.
 *
 * Сегодняшний, даже начавшийся утром, считается ближайшим — как в списке
 * турниров (ADR-052). Черновик и отменённый не в счёт: первого зритель не
 * видит, второго не будет.
 */
export async function nextTournaments(
  prisma: PrismaService,
  clubIds: readonly string[],
  now: Date,
): Promise<ReadonlyMap<string, Date>> {
  if (clubIds.length === 0) return new Map();

  const rows = await prisma.tournament.groupBy({
    by: ['clubId'],
    where: {
      clubId: { in: [...clubIds] },
      OR: [
        { status: 'RUNNING' },
        {
          status: { in: ['PUBLISHED', 'REG_OPEN', 'REG_CLOSED'] },
          startsAt: { gte: startOfClubDay(now) },
        },
      ],
    },
    _min: { startsAt: true },
  });

  return new Map(
    rows.flatMap((row) => (row._min.startsAt === null ? [] : [[row.clubId, row._min.startsAt]])),
  );
}
