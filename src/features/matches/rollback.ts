import { bracketSourceSchema } from '@kttf/shared/types';

import { Prisma } from '../../generated/prisma/client.js';
import { isEarlySeeded } from '../tournaments/early-finals.js';
import { parseGroupSeed } from '../tournaments/group-seed.js';
import { matchFields, type MatchRecord } from '../tournaments/tournaments.select.js';

import { applyAdvancement } from './advancement.js';

/**
 * Откат цепочкой — ADR-141.
 *
 * Неверный счёт нашли, когда дальше уже играли. У RTTF судья сам обнуляет
 * встречи сверху вниз — финал, полуфинал — и только потом правит нужную
 * (`docs/research/rttf-tm/02`, 7.5). Здесь то же самое делает сервер одним
 * действием и пишет в журнал, что откатил. Что именно откатится, консоль
 * показывает заранее (`dependentsOf`) — молча стирать сыгранное нельзя.
 */

/** Что держится на результате встречи. */
export interface Dependents {
  /** Сыгранные встречи сетки, выросшие из этой, — от дальней к ближней. */
  readonly matches: readonly MatchRecord[];
  /** Этапы, посеянные итогами групп, где уже сыграно. */
  readonly stages: readonly {
    readonly id: string;
    readonly name: string;
    readonly played: number;
  }[];
}

interface MatchContext {
  readonly id: string;
  readonly tournamentId: string;
  readonly groupId?: string | null;
  readonly stage: { readonly id: string; readonly order: number; readonly type: string };
}

export async function dependentsOf(
  tx: Prisma.TransactionClient,
  match: MatchContext,
): Promise<Dependents> {
  // Финал начат досрочно (ADR-143): правка группы задевает не этапы
  // целиком, а позиции её мест — и то, что из них выросло.
  if (match.stage.type === 'GROUPS' && match.groupId !== undefined && match.groupId !== null) {
    const later = await tx.match.findMany({
      where: { tournamentId: match.tournamentId, stage: { order: { gt: match.stage.order } } },
      select: matchFields,
    });

    if (later.some(isEarlySeeded)) {
      const groupId = match.groupId;
      const roots = later.filter(
        (candidate) =>
          (candidate.setsA !== null || candidate.status === 'PLAYING') &&
          [candidate.seedA, candidate.seedB].some(
            (seed) => parseGroupSeed(seed)?.groupId === groupId,
          ),
      );
      const depth = descendants(
        later,
        roots.map((root) => root.id),
      );
      for (const root of roots) if (!depth.has(root.id)) depth.set(root.id, 0);

      return {
        matches: later
          .filter(
            (candidate) =>
              depth.has(candidate.id) &&
              (candidate.setsA !== null || candidate.status === 'PLAYING'),
          )
          .sort((left, right) => (depth.get(right.id) ?? 0) - (depth.get(left.id) ?? 0)),
        stages: [],
      };
    }
  }

  const all = await tx.match.findMany({ where: { stageId: match.stage.id }, select: matchFields });
  const depth = descendants(all, [match.id]);

  const matches = all
    .filter((candidate) => depth.has(candidate.id) && candidate.setsA !== null)
    .sort((left, right) => (depth.get(right.id) ?? 0) - (depth.get(left.id) ?? 0));

  // Сетка ничего не сеет дальше себя; групповой этап сеет следующие.
  const stages =
    match.stage.type === 'KNOCKOUT' || match.stage.type === 'CONSOLATION'
      ? []
      : (
          await tx.stage.findMany({
            where: { tournamentId: match.tournamentId, order: { gt: match.stage.order } },
            select: {
              id: true,
              name: true,
              matches: {
                where: { NOT: { setsA: null }, carriedFromId: null },
                select: { id: true },
              },
            },
            orderBy: { order: 'asc' },
          })
        )
          .filter((stage) => stage.matches.length > 0)
          .map((stage) => ({ id: stage.id, name: stage.name, played: stage.matches.length }));

  return { matches, stages };
}

/**
 * Встречи сетки, выросшие из данных, с глубиной — сколько кругов от
 * ближайшей из них. Сами начальные встречи в ответ не входят.
 */
function descendants(all: readonly MatchRecord[], from: readonly string[]): Map<string, number> {
  // Дети по источникам сетки: кто ждёт победителя или проигравшего.
  const children = new Map<string, MatchRecord[]>();
  for (const candidate of all) {
    for (const source of [candidate.sourceA, candidate.sourceB]) {
      const parsed = bracketSourceSchema.safeParse(source);
      if (!parsed.success) continue;
      children.set(parsed.data.matchId, [...(children.get(parsed.data.matchId) ?? []), candidate]);
    }
  }

  // Обход в ширину: глубина — сколько кругов от исправляемой встречи.
  const depth = new Map<string, number>();
  const queue = from.map((id) => ({ id, level: 0 }));
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const child of children.get(current.id) ?? []) {
      const level = current.level + 1;
      if ((depth.get(child.id) ?? 0) >= level) continue;
      depth.set(child.id, level);
      queue.push({ id: child.id, level });
    }
  }

  return depth;
}

/**
 * Откатить всё, что держится на встрече: сыгранные встречи сетки — от
 * дальней к ближней — возвращаются в ожидание; этапы после групп, где уже
 * играли, сносятся и строятся заново достройкой после правки.
 *
 */
export async function rollBack(
  tx: Prisma.TransactionClient,
  match: MatchContext,
  userId: string,
): Promise<Dependents> {
  const found = await dependentsOf(tx, match);

  for (const dependent of found.matches) {
    await tx.match.update({
      where: { id: dependent.id },
      data: {
        setsA: null,
        setsB: null,
        setScores: Prisma.DbNull,
        resultType: null,
        tableNumber: null,
        status: 'PENDING',
        startedAt: null,
        finishedAt: null,
      },
    });
  }

  // Досрочный финал (ADR-143): откат прошёл по чужим этапам — их слоты
  // пересчитываются здесь, свой этап пересчитает запись счёта.
  for (const stageId of new Set(found.matches.map((dependent) => dependent.stageId))) {
    if (stageId !== match.stage.id) await applyAdvancement(tx, stageId);
  }

  if (found.stages.length > 0) {
    await tx.stage.deleteMany({ where: { id: { in: found.stages.map((stage) => stage.id) } } });
  }

  if (found.matches.length > 0 || found.stages.length > 0) {
    await tx.auditLog.create({
      data: {
        actorId: userId,
        action: 'match.rollback',
        entityType: 'Match',
        entityId: match.id,
        before: {
          matches: found.matches.map((dependent) => ({
            id: dependent.id,
            playerAId: dependent.playerAId,
            playerBId: dependent.playerBId,
            setsA: dependent.setsA,
            setsB: dependent.setsB,
            resultType: dependent.resultType,
          })),
          stages: found.stages.map((stage) => ({ name: stage.name, played: stage.played })),
        },
      },
    });
  }

  return found;
}
