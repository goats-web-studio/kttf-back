import { randomUUID } from 'node:crypto';

import { chooseLateGroup, scheduleLateEntry } from '@kttf/shared/brackets';
import { AppError, ERROR_CODES } from '@kttf/shared/errors';

import { Prisma } from '../../generated/prisma/client.js';

import { stageFields } from './tournaments.select.js';

/**
 * Поздняя запись в разыгранный турнир — ADR-062.
 *
 * Пока жеребьёвки нет, опоздавший просто встаёт в состав. После неё он
 * встаёт в группу текущего этапа и получает встречи со всеми в ней:
 * переигрывать жеребьёвку нельзя, сыгранное уже в таблице. Какую группу
 * взять, решает организатор, иначе — `chooseLateGroup`.
 *
 * Вставать некуда, когда групповой этап уже отдал следующий (его посеяли
 * без опоздавшего) и когда идёт сетка: там у каждого места своя история
 * встреч. В сетку игрок попадает заменой (`replaceParticipant`).
 */
export async function placeLateEntry(
  tx: Prisma.TransactionClient,
  tournamentId: string,
  playerId: string,
  groupId: string | undefined,
): Promise<void> {
  const stages = await tx.stage.findMany({
    where: { tournamentId },
    select: stageFields,
    orderBy: { order: 'asc' },
  });

  const [stage, ...later] = stages;

  if (stage === undefined) return;

  if (later.length > 0) {
    throw new AppError(ERROR_CODES.LATE_ENTRY_CLOSED, 'The next stage is already built', {
      reason: 'NEXT_STAGE_BUILT',
    });
  }

  if (stage.type === 'KNOCKOUT' || stage.type === 'CONSOLATION') {
    throw new AppError(ERROR_CODES.LATE_ENTRY_CLOSED, 'A bracket takes players by replacement', {
      reason: 'KNOCKOUT',
    });
  }

  const members = new Map(
    stage.groups.map((group) => [
      group.id,
      [
        ...new Set(
          stage.matches
            .filter((match) => match.groupId === group.id)
            .flatMap((match) => [match.playerAId, match.playerBId])
            .filter((id): id is string => id !== null),
        ),
      ],
    ]),
  );

  const target = groupId ?? (await suggestGroup(tx, tournamentId, members));
  const group = stage.groups.find((candidate) => candidate.id === target);

  if (group === undefined) {
    throw new AppError(ERROR_CODES.NOT_FOUND, 'Group not found', { groupId: target });
  }

  const lastRound = Math.max(
    0,
    ...stage.matches
      .filter((match) => match.groupId === group.id)
      .map((match) => match.bracketRound ?? 0),
  );
  const schedule = scheduleLateEntry(
    members.get(group.id) ?? [],
    playerId,
    roundsOf(stage.config),
    lastRound,
  );

  await tx.match.createMany({
    data: schedule.map((match) => ({
      id: randomUUID(),
      tournamentId,
      stageId: stage.id,
      groupId: group.id,
      playerAId: match.a,
      playerBId: match.b,
      sourceA: Prisma.DbNull,
      sourceB: Prisma.DbNull,
      bracketRound: match.round,
      bracketSlot: null,
    })),
  });
}

/** Группа по умолчанию: самая малая, из равных — самая слабая (ADR-062). */
async function suggestGroup(
  tx: Prisma.TransactionClient,
  tournamentId: string,
  members: ReadonlyMap<string, readonly string[]>,
): Promise<string | undefined> {
  const rows = await tx.registration.findMany({
    where: { tournamentId, playerId: { in: [...members.values()].flat() } },
    select: { playerId: true, ratingAtStart: true, player: { select: { rating: true } } },
  });
  const rating = new Map(
    rows.map((row) => [row.playerId, Number(row.ratingAtStart ?? row.player.rating)]),
  );

  return (
    chooseLateGroup(
      [...members].map(([key, ids]) => ({ key, ratings: ids.map((id) => rating.get(id) ?? 0) })),
    ) ?? undefined
  );
}

/** Кругов в группе — `Stage.config.rounds`, по умолчанию один. */
function roundsOf(config: unknown): number {
  if (typeof config === 'object' && config !== null && !Array.isArray(config)) {
    const rounds = (config as Record<string, unknown>).rounds;

    if (rounds === 2) return 2;
  }

  return 1;
}
