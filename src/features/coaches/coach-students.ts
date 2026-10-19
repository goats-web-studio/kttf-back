import type { PrismaService } from '../../infra/prisma/prisma.service.js';

/**
 * Ученики тренеров — игроки, выбравшие его в анкете (ADR-035): ссылка
 * `coachPlayerId` указывает на игрока, на чьём профиле стоит страница.
 * Одним запросом на страницу списка, а не по запросу на тренера.
 */
export async function countStudents(
  prisma: PrismaService,
  playerIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  if (playerIds.length === 0) return new Map();

  const rows = await prisma.player.groupBy({
    by: ['coachPlayerId'],
    where: { coachPlayerId: { in: [...new Set(playerIds)] } },
    _count: { _all: true },
  });

  return new Map(
    rows.flatMap((row) =>
      row.coachPlayerId === null ? [] : [[row.coachPlayerId, row._count._all]],
    ),
  );
}
