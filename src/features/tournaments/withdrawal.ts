import { bracketWalkover, isDecidedByWithdrawal } from '@kttf/shared/brackets';

import { Prisma } from '../../generated/prisma/client.js';
import { applyAdvancement } from '../matches/advancement.js';

import { matchSetsToWin } from './stage-config.js';
import { matchFields, stageFields, type MatchRecord } from './tournaments.select.js';

/**
 * Когда кто снялся — порядок технических побед, если снялись оба (ADR-077).
 * Время неизвестно (снятие до ADR-077) — игрока в порядке нет.
 */
export function withdrawalOrder(
  rows: readonly { readonly playerId: string; readonly withdrawnAt?: Date | null }[],
): Map<string, number> {
  return new Map(
    rows.flatMap((row) =>
      row.withdrawnAt === null || row.withdrawnAt === undefined
        ? []
        : [[row.playerId, row.withdrawnAt.getTime()] as const],
    ),
  );
}

/** Статусы записи, при которых участник больше не играет: снялся или не явился. */
export const WITHDRAWN_STATUSES = ['WITHDRAWN', 'NO_SHOW'] as const;

/**
 * Снявшиеся и не явившиеся по ходу турнира — ADR-009, ADR-061.
 *
 * В группе их несыгранные встречи решает расчёт таблицы (`applyWithdrawals`),
 * в базу ничего не пишется. В сетке так нельзя: без победителя следующий круг
 * остаётся без участника. Поэтому здесь встречам сетки, где снявшийся
 * встречает известного соперника, записывается техническая победа, и
 * соперник едет дальше тем же путём, что после обычного счёта.
 *
 * Проход повторяется, пока есть что решать: техническая победа поднимает
 * соперника в следующий круг, а там его может ждать ещё один снявшийся.
 * Каждый проход закрывает хотя бы одну встречу, поэтому цикл конечен.
 *
 * Вызывается после всего, что может посадить снявшегося напротив известного
 * соперника: снятия, ввода и правки счёта, отмены, достройки плей-офф.
 * Заодно освобождаются столы групповых встреч снявшегося (`releaseTables`).
 *
 * @returns Встречи, изменённые проходом: закрытые технически и пополненные.
 */
export async function settleWithdrawals(
  tx: Prisma.TransactionClient,
  tournamentId: string,
): Promise<MatchRecord[]> {
  const rows = await tx.registration.findMany({
    where: { tournamentId, status: { in: [...WITHDRAWN_STATUSES] } },
    select: { playerId: true },
  });
  const withdrawn = new Set(rows.map((row) => row.playerId));
  const changed: MatchRecord[] = [];

  if (withdrawn.size === 0) return changed;

  changed.push(...(await releaseTables(tx, tournamentId, withdrawn)));

  for (;;) {
    const stages = await tx.stage.findMany({ where: { tournamentId }, select: stageFields });
    const due = stages
      .filter((stage) => stage.type === 'KNOCKOUT' || stage.type === 'CONSOLATION')
      .flatMap((stage) =>
        stage.matches.flatMap((match) => {
          if (match.setsA !== null || match.status === 'CANCELLED') return [];

          const score = bracketWalkover(
            { a: match.playerAId, b: match.playerBId },
            withdrawn,
            matchSetsToWin(stage.config, match),
          );

          return score === null ? [] : [{ stageId: stage.id, matchId: match.id, score }];
        }),
      );

    if (due.length === 0) return changed;

    for (const { matchId, score } of due) {
      changed.push(
        await tx.match.update({
          where: { id: matchId },
          data: {
            ...score,
            setScores: Prisma.DbNull,
            resultType: 'WALKOVER',
            status: 'FINISHED',
            finishedAt: new Date(),
          },
          select: matchFields,
        }),
      );
    }

    for (const stageId of new Set(due.map((entry) => entry.stageId))) {
      changed.push(...(await applyAdvancement(tx, stageId)));
    }
  }
}

/**
 * Групповая встреча снявшегося, которая шла за столом, возвращается в
 * ожидание и освобождает стол.
 *
 * Её исход даёт таблица (ADR-009), и стола она больше не занимает: иначе он
 * висел бы занятым до конца турнира, а сервер отказывал бы в нём следующей
 * паре (`TABLE_BUSY`). Вернут игрока в игру — встреча снова в очереди.
 */
async function releaseTables(
  tx: Prisma.TransactionClient,
  tournamentId: string,
  withdrawn: ReadonlySet<string>,
): Promise<MatchRecord[]> {
  const stages = await tx.stage.findMany({ where: { tournamentId }, select: stageFields });
  const stuck = stages
    .filter((stage) => stage.type !== 'KNOCKOUT' && stage.type !== 'CONSOLATION')
    .flatMap((stage) => stage.matches)
    .filter(
      (match) =>
        match.status === 'PLAYING' &&
        match.setsA === null &&
        isDecidedByWithdrawal({ a: match.playerAId, b: match.playerBId }, withdrawn),
    );
  const released: MatchRecord[] = [];

  for (const match of stuck) {
    released.push(
      await tx.match.update({
        where: { id: match.id },
        data: { status: 'PENDING', tableNumber: null, startedAt: null },
        select: matchFields,
      }),
    );
  }

  return released;
}
