import type { Prisma } from '../../generated/prisma/client.js';
import { BEFORE_START } from '../tournaments/tournament-lifecycle.js';

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

/** Тренер в анкете: из списка или строкой. */
export interface ProfileCoach {
  coachPlayerId: string | null;
  coachName: string | null;
}

/**
 * Тренер в записях на турниры идёт за анкетой — T3 (ADR-059). Только до
 * старта и только там, где его не правили руками: после старта запись —
 * история, а поправленное руками игрок или организатор указали осознанно.
 * Вызывается в той же транзакции, что меняет анкету.
 */
export async function followProfileCoach(
  tx: Prisma.TransactionClient,
  playerId: string,
  coach: ProfileCoach,
): Promise<void> {
  await tx.registration.updateMany({
    where: { playerId, coachManual: false, tournament: { status: { in: [...BEFORE_START] } } },
    data: { coachPlayerId: coach.coachPlayerId, coachName: coach.coachName },
  });
}
