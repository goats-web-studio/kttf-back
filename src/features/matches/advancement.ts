import { resolveBracketSlots } from '@kttf/shared/brackets';
import type { BracketSlotMatch, BracketSlotSource } from '@kttf/shared/brackets';
import { bracketSourceSchema } from '@kttf/shared/types';

import type { Prisma } from '../../generated/prisma/client.js';
import { matchFields, type MatchRecord } from '../tournaments/tournaments.select.js';

/**
 * Пересчёт состава сетки по источникам — ADR-019.
 *
 * Считается весь этап целиком, а не одна следующая встреча: так правка
 * результата сама убирает из следующего круга прежнего победителя.
 *
 * Общий для ввода счёта и для технических побед за снявшихся (ADR-061):
 * победитель обязан доехать до следующего круга одним и тем же путём.
 */
export async function applyAdvancement(
  tx: Prisma.TransactionClient,
  stageId: string,
): Promise<MatchRecord[]> {
  const matches = await tx.match.findMany({ where: { stageId }, select: matchFields });
  const assignments = resolveBracketSlots(matches.map(toSlotMatch));

  if (assignments.length === 0) return [];

  const updated: MatchRecord[] = [];

  for (const assignment of assignments) {
    updated.push(
      await tx.match.update({
        where: { id: assignment.matchId },
        data:
          assignment.side === 'A'
            ? { playerAId: assignment.participant }
            : { playerBId: assignment.participant },
        select: matchFields,
      }),
    );
  }

  return updated;
}

function toSlotMatch(match: MatchRecord): BracketSlotMatch {
  return {
    id: match.id,
    a: match.playerAId,
    b: match.playerBId,
    sourceA: toSlotSource(match.sourceA),
    sourceB: toSlotSource(match.sourceB),
    setsA: match.setsA,
    setsB: match.setsB,
  };
}

/** Источник приходит из колонки `Json` и разбирается той же схемой, что писала. */
function toSlotSource(value: unknown): BracketSlotSource | null {
  const parsed = bracketSourceSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}
