import { randomUUID } from 'node:crypto';

import { selectAdvancing, withoutWithdrawn, type GroupPlacement } from '@kttf/shared/brackets';
import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import { formatConfigSchema, type FormatConfig } from '@kttf/shared/types';

import type { Prisma } from '../../generated/prisma/client.js';

import { planNextStage, type PlannedMatch } from './draw.js';
import { parseGroupSeed, type GroupSeedRecord } from './group-seed.js';
import { isStageComplete } from './stage-completion.js';
import { writeStage } from './stage-writer.js';
import { buildStandings } from './standings.js';
import {
  matchFields,
  stageFields,
  type MatchRecord,
  type StageRecord,
} from './tournaments.select.js';
import { WITHDRAWN_STATUSES, withdrawalOrder } from './withdrawal.js';

/**
 * Досрочный старт финала — ADR-143, как «досрочный старт плей-офф» у RTTF.
 *
 * Обычно сетка после групп строится, когда доиграна последняя группа
 * (ADR-020). В зале это простой: группа A закончила час назад, а её
 * игроки ждут, пока доиграет группа D. Досрочный старт строит сетку сразу,
 * но не по результатам, а по шаблону «место в группе → позиция сетки»:
 * посев блоками мест с разведением одногруппников (ADR-061) зависит только
 * от числа групп и их размеров, а не от счёта.
 *
 * Каждая позиция помнит своё место в группе (`Match.seedA/seedB`). Доиграна
 * группа — её игроки ложатся на свои позиции, и встречи, где известны оба,
 * можно звать к столу. Остальные ждут, а консоль пишет, кого именно:
 * «ждёт гр. B, 2 место».
 *
 * Только «группы + сетка»: в финальных группах вкруг встреча с неизвестным
 * игроком сломала бы таблицу, а «с зачётом» (ADR-134) переносит счёт,
 * которого ещё нет.
 */

/** Группа глазами досрочного финала. */
interface GroupState {
  readonly id: string;
  readonly label: string;
  /** Доиграна, и равенство не мешает отдать места — ADR-008. */
  readonly ready: boolean;
  /**
   * Порядок мест: сначала играющие по таблице, затем снявшиеся. Снявшийся
   * после старта финала оказывается на последних позициях и отдаёт
   * сопернику техническую победу (ADR-061) — позиции шаблона уже заняты.
   */
  readonly order: readonly string[];
  /** Сколько в группе играющих. */
  readonly active: number;
}

/** Метка позиции шаблона: группа по порядку и место в ней. */
const TOKEN = /^seed:(\d+):(\d+)$/;

function token(group: number, place: number): string {
  return `seed:${String(group)}:${String(place)}`;
}

function refuse(tournamentId: string, reason: string, message: string): AppError {
  return new AppError(ERROR_CODES.VALIDATION_FAILED, message, { id: tournamentId, reason });
}

/**
 * Построить финал досрочно.
 *
 * @returns Идентификаторы построенных этапов.
 */
export async function startFinalsEarly(
  tx: Prisma.TransactionClient,
  tournamentId: string,
): Promise<string[]> {
  const tournament = await tx.tournament.findUnique({
    where: { id: tournamentId },
    select: { formatConfig: true },
  });

  /* v8 ignore next -- турнир прочитан вызывающим до входа в транзакцию */
  if (tournament === null) throw refuse(tournamentId, 'EARLY_FORMAT', 'Tournament not found');

  const config: FormatConfig = formatConfigSchema.parse(tournament.formatConfig);

  if (config.type !== 'GROUPS_KNOCKOUT') {
    throw refuse(tournamentId, 'EARLY_FORMAT', 'Early finals need groups + bracket');
  }

  const stages = await tx.stage.findMany({
    where: { tournamentId },
    select: stageFields,
    orderBy: { order: 'asc' },
  });
  const groupStage = stages[0];

  if (groupStage?.type !== 'GROUPS' || stages.length !== 1) {
    throw refuse(tournamentId, 'EARLY_BUILT', 'The bracket is already built');
  }

  const states = await groupStates(tx, tournamentId, config, groupStage);

  if (!states.some((state) => state.ready)) {
    throw refuse(tournamentId, 'NO_GROUP_READY', 'No group has finished yet');
  }

  // Шаблон: вместо игроков — метки «группа, место». Посев тот же, что
  // у обычной достройки (`advanceAfterGroups`), только по меткам.
  const placements: GroupPlacement[] = states.map((state, index) => ({
    label: state.label,
    rows: Array.from({ length: state.active }, (_unused, offset) => ({
      participant: token(index, offset + 1),
      place: offset + 1,
    })),
    unresolved: [],
  }));
  const advancePerGroup =
    config.advanceAll === true
      ? Math.max(1, ...states.map((state) => state.active))
      : config.advancePerGroup;
  const selection = selectAdvancing(
    placements,
    advancePerGroup,
    config.advanceAll === true ? [] : (config.extraFinals ?? []),
  );

  if (selection.seeded.length < 2) {
    throw refuse(tournamentId, 'TOO_FEW_ADVANCE', 'Too few participants advance from groups');
  }

  const seedOf = (participant: string | null): GroupSeedRecord | undefined => {
    const parsed = participant === null ? null : TOKEN.exec(participant);
    if (parsed === null) return undefined;
    const state = states[Number(parsed[1])];
    /* v8 ignore next -- метку выдал шаблон выше, группа у неё есть всегда */
    if (state === undefined) return undefined;
    return { groupId: state.id, group: state.label, place: Number(parsed[2]) };
  };

  const ids: string[] = [];

  for (const stage of planNextStage(config, selection, () => randomUUID(), [])) {
    ids.push(
      await writeStage(tx, tournamentId, {
        ...stage,
        // Свободные проходы — метки шаблона; игроков в них подставлять
        // незачем: сетка их уже разложила по второму кругу.
        config: { ...stage.config, byes: [] },
        matches: stage.matches.map((match): PlannedMatch => {
          const seedA = seedOf(match.playerAId);
          const seedB = seedOf(match.playerBId);
          return {
            ...match,
            playerAId: seedA === undefined ? match.playerAId : null,
            playerBId: seedB === undefined ? match.playerBId : null,
            ...(seedA === undefined ? {} : { seedA }),
            ...(seedB === undefined ? {} : { seedB }),
          };
        }),
      }),
    );
  }

  await syncEarlySeeds(tx, tournamentId, null);

  return ids;
}

/** Начат ли досрочно хоть один из этапов. */
export async function hasEarlySeeds(
  tx: Prisma.TransactionClient,
  stageIds: readonly string[],
): Promise<boolean> {
  const matches = await tx.match.findMany({
    where: { stageId: { in: [...stageIds] } },
    select: { seedA: true, seedB: true },
  });
  return matches.some(isEarlySeeded);
}

/** Есть ли у встречи позиция, закреплённая за местом в группе. */
export function isEarlySeeded(match: { readonly seedA: unknown; readonly seedB: unknown }): boolean {
  return parseGroupSeed(match.seedA) !== null || parseGroupSeed(match.seedB) !== null;
}

/**
 * Разложить игроков доигранных групп по их позициям.
 *
 * Пустая позиция заполняется, как только её группа готова. Занятая
 * переезжает только при правке своей группы (`regroupId`): исправленный
 * счёт мог поменять места. Если при этом меняется игрок встречи, которая
 * уже сыграна или идёт, — отказ `DOWNSTREAM_MATCH_PLAYED`, как у обычной
 * правки группы после старта сетки; откат цепочкой — ADR-141.
 *
 * Снятие игрока занятые позиции не двигает: его встречу в сетке решает
 * техническая победа (ADR-061), как после обычной достройки.
 *
 * @param regroupId Группа, где правили счёт или решали равенство.
 * @returns Изменённые встречи.
 */
export async function syncEarlySeeds(
  tx: Prisma.TransactionClient,
  tournamentId: string,
  regroupId: string | null,
): Promise<MatchRecord[]> {
  const stages = await tx.stage.findMany({
    where: { tournamentId },
    select: stageFields,
    orderBy: { order: 'asc' },
  });
  const [groupStage, ...later] = stages;

  if (groupStage?.type !== 'GROUPS') return [];

  const seeded = later.flatMap((stage) => stage.matches.filter(isEarlySeeded));

  if (seeded.length === 0) return [];

  const tournament = await tx.tournament.findUniqueOrThrow({
    where: { id: tournamentId },
    select: { formatConfig: true },
  });
  const config = formatConfigSchema.parse(tournament.formatConfig);

  /* v8 ignore next -- позиции с местом в группе строит только «группы + сетка» */
  if (config.type !== 'GROUPS_KNOCKOUT') return [];

  const states = new Map(
    (await groupStates(tx, tournamentId, config, groupStage)).map((state) => [state.id, state]),
  );
  const changed: MatchRecord[] = [];

  for (const match of seeded) {
    const data: { playerAId?: string | null; playerBId?: string | null } = {};

    for (const side of ['A', 'B'] as const) {
      const seed = parseGroupSeed(side === 'A' ? match.seedA : match.seedB);
      if (seed === null) continue;

      const current = side === 'A' ? match.playerAId : match.playerBId;
      const state = states.get(seed.groupId);
      const desired = state?.ready === true ? (state.order[seed.place - 1] ?? null) : null;

      if (current === desired) continue;
      // Занятую позицию двигает только правка её группы.
      if (current !== null && seed.groupId !== regroupId) continue;

      if (current !== null && (match.setsA !== null || match.status === 'PLAYING')) {
        throw new AppError(
          ERROR_CODES.DOWNSTREAM_MATCH_PLAYED,
          'A later stage seeded by this result is already played',
          { blockedBy: match.id },
        );
      }

      data[side === 'A' ? 'playerAId' : 'playerBId'] = desired;
    }

    if (Object.keys(data).length === 0) continue;

    changed.push(
      await tx.match.update({
        where: { id: match.id },
        // Пару уже позвали к столу, а в ней сменился игрок — встреча
        // возвращается в очередь без стола.
        data: { ...data, ...(match.status === 'QUEUED' ? { status: 'PENDING', tableNumber: null } : {}) },
        select: matchFields,
      }),
    );
  }

  return changed;
}

/** Готовность и порядок мест каждой группы — в порядке таблиц. */
async function groupStates(
  tx: Prisma.TransactionClient,
  tournamentId: string,
  config: Extract<FormatConfig, { type: 'GROUPS_KNOCKOUT' }>,
  groupStage: StageRecord,
): Promise<GroupState[]> {
  const withdrawnRows = await tx.registration.findMany({
    where: { tournamentId, status: { in: [...WITHDRAWN_STATUSES] } },
    select: { playerId: true, withdrawnAt: true },
  });
  const withdrawn = new Set(withdrawnRows.map((row) => row.playerId));
  const standings = buildStandings({
    tournamentId,
    stages: [groupStage],
    withdrawn: [...withdrawn],
    order: withdrawalOrder(withdrawnRows),
  });

  return standings.groups.flatMap((table) => {
    const groupId = table.groupId;
    /* v8 ignore next -- у группового этапа у каждой таблицы своя группа */
    if (groupId === null) return [];

    const rows = table.rows.map((row) => ({ participant: row.participant, place: row.place }));
    const [placement] = withoutWithdrawn(
      [{ label: table.label, rows, unresolved: table.unresolved }],
      withdrawn,
    );
    /* v8 ignore next -- одна группа на входе — одна на выходе */
    if (placement === undefined) return [];

    const active = placement.rows.length;
    const complete = isStageComplete(
      { ...groupStage, matches: groupStage.matches.filter((match) => match.groupId === groupId) },
      withdrawn,
    );
    const perGroup = config.advanceAll === true ? Math.max(1, active) : config.advancePerGroup;
    const blocked =
      active > 0 &&
      selectAdvancing(
        [placement],
        perGroup,
        config.advanceAll === true ? [] : (config.extraFinals ?? []),
      ).blocked.length > 0;

    return [
      {
        id: groupId,
        label: table.label,
        ready: complete && !blocked,
        order: [
          ...placement.rows.map((row) => row.participant),
          ...rows.map((row) => row.participant).filter((id) => withdrawn.has(id)),
        ],
        active,
      },
    ];
  });
}
