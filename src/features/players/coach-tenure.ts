import type { Prisma } from '../../generated/prisma/client.js';

/**
 * История тренера — T2 (ADR-059). Смена `Player.coachPlayerId` закрывает
 * открытый период прежнего тренера и открывает новый. Вызывается внутри
 * той же транзакции, что меняет игрока: история не расходится с анкетой.
 *
 * Тренер тот же — ничего не пишется: повторное сохранение анкеты не рвёт
 * период на два.
 */
export async function switchCoach(
  tx: Prisma.TransactionClient,
  playerId: string,
  previous: string | null,
  next: string | null,
  now: Date = new Date(),
): Promise<void> {
  if (previous === next) return;

  if (previous !== null) {
    await tx.coachTenure.updateMany({
      where: { playerId, coachPlayerId: previous, to: null },
      data: { to: now },
    });
  }

  if (next !== null) {
    await tx.coachTenure.create({ data: { playerId, coachPlayerId: next, from: now } });
  }
}
