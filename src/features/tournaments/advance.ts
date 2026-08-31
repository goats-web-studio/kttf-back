import { randomUUID } from 'node:crypto';

import { selectAdvancing, type GroupPlacement } from '@kttf/shared/brackets';
import { formatConfigSchema, type FormatConfig } from '@kttf/shared/types';

import type { Prisma } from '../../generated/prisma/client.js';

import { planNextStage } from './draw.js';
import { isStageComplete } from './stage-completion.js';
import { buildStandings } from './standings.js';
import { writeStage } from './stage-writer.js';
import { stageFields } from './tournaments.select.js';

/**
 * Достройка этапа по итогам группового этапа.
 *
 * Плей-офф и финальные группы не существуют в момент жеребьёвки: их сеют
 * результаты групп. Поэтому этап появляется здесь — когда последняя встреча
 * групп получила результат.
 *
 * **Достройка не имеет права уронить ввод счёта.** Судья вводит результат
 * и не обязан знать про схему турнира: если сеять пока нечем, счёт всё равно
 * записывается, а причина возвращается наружу.
 */

export interface AdvanceOutcome {
  /** Идентификатор достроенного этапа. `null` — достраивать нечего или рано. */
  readonly stageId: string | null;
  /** Метки групп, где равенство не разрешено судьёй, — ADR-008. */
  readonly blockedByTies: readonly string[];
}

const NOTHING: AdvanceOutcome = { stageId: null, blockedByTies: [] };

export async function advanceAfterGroups(
  tx: Prisma.TransactionClient,
  tournamentId: string,
): Promise<AdvanceOutcome> {
  const tournament = await tx.tournament.findUnique({
    where: { id: tournamentId },
    select: { formatConfig: true },
  });

  /* v8 ignore next -- турнир прочитан вызывающим до входа в транзакцию */
  if (tournament === null) return NOTHING;

  const config: FormatConfig = formatConfigSchema.parse(tournament.formatConfig);

  if (config.type !== 'GROUPS_KNOCKOUT' && config.type !== 'GROUPS_FINAL_GROUPS') return NOTHING;

  const stages = await tx.stage.findMany({
    where: { tournamentId },
    select: stageFields,
    orderBy: { order: 'asc' },
  });

  // Этап уже достроен. Повторно не строим: результаты, которые в нём успели
  // появиться, снесло бы вместе со встречами.
  if (stages.length > 1) return NOTHING;

  const groupStage = stages[0];
  if (groupStage === undefined) return NOTHING;

  const withdrawnRows = await tx.registration.findMany({
    where: { tournamentId, status: { in: ['WITHDRAWN', 'NO_SHOW'] } },
    select: { playerId: true },
  });
  const withdrawn = withdrawnRows.map((registration) => registration.playerId);

  if (!isStageComplete(groupStage, new Set(withdrawn))) return NOTHING;

  const standings = buildStandings({ tournamentId, stages: [groupStage], withdrawn });

  const placements: GroupPlacement[] = standings.groups.map((group) => ({
    label: group.label,
    rows: group.rows.map((row) => ({ participant: row.participant, place: row.place })),
    unresolved: group.unresolved,
  }));

  const selection = selectAdvancing(placements, config.advancePerGroup);

  if (selection.blocked.length > 0) return { stageId: null, blockedByTies: selection.blocked };

  const planned = planNextStage(config, selection, () => randomUUID());
  /* v8 ignore next -- обе групповые схемы этап дают, проверка типа выше */
  if (planned === null) return NOTHING;

  return { stageId: await writeStage(tx, tournamentId, planned), blockedByTies: [] };
}
