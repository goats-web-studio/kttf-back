import { Prisma } from '../../generated/prisma/client.js';

import type { PlannedStage } from './draw.js';

/**
 * Запись запланированного этапа в базу.
 *
 * Вынесена отдельно, потому что этапы создаются в двух местах: жеребьёвка
 * пишет групповой этап, а плей-офф достраивается позже, по итогам групп.
 * Раскладка одна и та же, и второй её экземпляр разошёлся бы с первым при
 * первом же новом поле.
 */
export async function writeStage(
  tx: Prisma.TransactionClient,
  tournamentId: string,
  stage: PlannedStage,
): Promise<string> {
  const created = await tx.stage.create({
    data: {
      tournamentId,
      order: stage.order,
      type: stage.type,
      name: stage.name,
      config: stage.config as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  const groupIds = new Map<string, string>();

  for (const group of stage.groups) {
    const createdGroup = await tx.group.create({
      data: { stageId: created.id, label: group.label, order: group.order },
      select: { id: true },
    });

    groupIds.set(group.key, createdGroup.id);
  }

  await tx.match.createMany({
    data: stage.matches.map((match) => ({
      id: match.id,
      tournamentId,
      stageId: created.id,
      groupId: match.groupKey === null ? null : (groupIds.get(match.groupKey) ?? null),
      playerAId: match.playerAId,
      playerBId: match.playerBId,
      sourceA: match.sourceA ?? Prisma.DbNull,
      sourceB: match.sourceB ?? Prisma.DbNull,
      bracketRound: match.bracketRound,
      bracketSlot: match.bracketSlot,
    })),
  });

  return created.id;
}
