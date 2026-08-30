import { applyWithdrawals, calculateStandings } from '@kttf/shared/brackets';
import type { GroupStandingsView, TournamentStandingsView } from '@kttf/shared/types';

import type { MatchRecord, StageRecord } from './tournaments.select.js';

/**
 * Групповые таблицы турнира — ТЗ 6.6.
 *
 * Чистая функция поверх движка: сам расчёт и правило снявшегося живут в общем
 * коде, здесь только сборка входных данных из записей базы. Считать что-либо
 * своё в приложении нельзя — офлайн-консоль обязана получить те же места
 * (запрет №2 брифа).
 */

/** До скольких сетов идёт встреча. Лежит в `Stage.config`, положенной при жеребьёвке. */
function setsToWinOf(stage: StageRecord): number {
  const config = stage.config;

  if (typeof config === 'object' && config !== null && !Array.isArray(config)) {
    const value = (config as Record<string, unknown>).setsToWin;

    if (typeof value === 'number' && value > 0) return value;
  }

  // Умолчание на случай этапа, созданного до появления поля: три сета —
  // самая частая схема, и таблица без него не считалась бы вовсе.
  return 3;
}

function playedOf(match: MatchRecord): {
  a: string;
  b: string;
  setsA: number;
  setsB: number;
  setScores?: readonly (readonly [number, number])[];
  resultType: 'NORMAL' | 'WALKOVER' | 'RETIRED';
} | null {
  if (
    match.playerAId === null ||
    match.playerBId === null ||
    match.setsA === null ||
    match.setsB === null
  ) {
    return null;
  }

  const setScores = parseSetScores(match.setScores);

  return {
    a: match.playerAId,
    b: match.playerBId,
    setsA: match.setsA,
    setsB: match.setsB,
    ...(setScores === null ? {} : { setScores }),
    resultType: match.resultType ?? 'NORMAL',
  };
}

/** Счёт по сетам нужен правилам 3 и 5 разрешения равенства — ТЗ 6.6. */
function parseSetScores(value: unknown): (readonly [number, number])[] | null {
  if (!Array.isArray(value)) return null;

  const scores: [number, number][] = [];

  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;

    const [left, right] = entry as unknown[];

    if (typeof left !== 'number' || typeof right !== 'number') return null;

    scores.push([left, right]);
  }

  return scores;
}

export interface StandingsInput {
  readonly tournamentId: string;
  readonly stages: readonly StageRecord[];
  /** Игроки, снявшиеся или не явившиеся, — ТЗ 4.4. */
  readonly withdrawn: readonly string[];
}

export function buildStandings(input: StandingsInput): TournamentStandingsView {
  const groups: GroupStandingsView[] = [];

  for (const stage of input.stages) {
    for (const group of stage.groups) {
      groups.push(buildGroup(stage, group, input.withdrawn));
    }
  }

  return { tournamentId: input.tournamentId, groups };
}

function buildGroup(
  stage: StageRecord,
  group: StageRecord['groups'][number],
  withdrawn: readonly string[],
): GroupStandingsView {
  const matches = stage.matches.filter((match) => match.groupId === group.id);

  // Состав группы выводится из её встреч: в круговой схеме играют все со
  // всеми, поэтому список полон. Отдельной колонки под состав в модели нет.
  const participants = [
    ...new Set(
      matches.flatMap((match) =>
        [match.playerAId, match.playerBId].filter((id): id is string => id !== null),
      ),
    ),
  ];

  const played = matches.map(playedOf).filter((match) => match !== null);
  const playedKeys = new Set(played.map((match) => `${match.a}:${match.b}`));

  const pending = matches
    .filter(
      (match) =>
        match.playerAId !== null &&
        match.playerBId !== null &&
        !playedKeys.has(`${match.playerAId}:${match.playerBId}`),
    )
    .map((match) => ({ a: match.playerAId ?? '', b: match.playerBId ?? '' }));

  // Несыгранные встречи снявшегося уходят соперникам технической победой,
  // чтобы таблица и рейтинг считали одно и то же (ADR-009).
  const walkovers = applyWithdrawals(pending, withdrawn, setsToWinOf(stage));

  const decisions = group.tieDecisions
    .map((decision) => parseOrderedIds(decision.orderedIds))
    .filter((decision) => decision !== null);

  const standings = calculateStandings(participants, [...played, ...walkovers], {
    tieDecisions: decisions,
  });

  return {
    stageId: stage.id,
    groupId: group.id,
    label: group.label,
    rows: standings.rows.map((row) => ({ ...row })),
    unresolved: standings.unresolved.map((tie) => ({
      participants: [...tie.participants],
      places: [...tie.places],
    })),
  };
}

/** Решение судьи по равенству — массив `Player.id` в выбранном им порядке. */
function parseOrderedIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;

  const ids = value.filter((entry): entry is string => typeof entry === 'string');

  return ids.length === value.length ? ids : null;
}
