import { playoffSetsToWin, type TieBreakRule } from '@kttf/shared/brackets';
import {
  playoffSetsToWinSchema,
  type FormatConfig,
  type PlayoffSetsToWin,
  type StageType,
} from '@kttf/shared/types';

/**
 * Разбор колонок `Json` этапа и встречи.
 *
 * Живёт отдельно, потому что читают их двое: расчёт таблицы и ввод счёта.
 * Планка сетов, по которой проверяется результат, обязана совпадать с той,
 * по которой считается таблица, — иначе принятый счёт даст неверную таблицу.
 */

/** До скольких выигранных сетов идёт встреча — ТЗ 5.2. Лежит в `Stage.config`. */
export function setsToWinOf(config: unknown): number {
  if (typeof config === 'object' && config !== null && !Array.isArray(config)) {
    const value = (config as Record<string, unknown>).setsToWin;

    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  }

  // Умолчание на случай этапа, созданного до появления поля: три сета —
  // самая частая схема, и таблица без него не считалась бы вовсе.
  return 3;
}

/**
 * Правило равенства этапа — ADR-062. Лежит в `Stage.config`; не задано или
 * испорчено — разница сетов (ТЗ 6.6), как считались этапы до появления поля.
 */
export function tieBreakOfStage(config: unknown): TieBreakRule {
  if (typeof config === 'object' && config !== null && !Array.isArray(config)) {
    const value = (config as Record<string, unknown>).tieBreak;

    if (value === 'SET_RATIO') return 'SET_RATIO';
  }

  return 'SET_DIFF';
}

/**
 * До скольких побед идёт эта встреча — с учётом длин по кругам плей-офф
 * (ADR-044).
 *
 * Круг и позиция лежат у самой встречи, размер сетки и длины — в `config`
 * её этапа. Встреча группы или круговой позиции в сетке не имеет и играется
 * длиной этапа. Тот же расчёт делает офлайн-консоль — общим правилом
 * `playoffSetsToWin`, а не своей копией.
 */
export function matchSetsToWin(
  config: unknown,
  match: { readonly bracketRound: number | null; readonly bracketSlot: number | null },
): number {
  const base = setsToWinOf(config);

  if (match.bracketRound === null || match.bracketSlot === null) return base;
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return base;

  const record = config as Record<string, unknown>;
  const bracketSize = record.bracketSize;

  if (typeof bracketSize !== 'number' || bracketSize < 2) return base;

  const lengths = playoffSetsToWinSchema.safeParse(record.playoffSetsToWin);

  return playoffSetsToWin(
    base,
    lengths.success ? lengths.data : undefined,
    { round: match.bracketRound, slot: match.bracketSlot },
    Math.log2(bracketSize),
  );
}

/** Длины встреч этапа так, как их кладёт в `Stage.config` жеребьёвка. */
export interface StageLengths {
  readonly setsToWin: number;
  /** Длины по кругам — только у основной сетки (ADR-044, ADR-045). */
  readonly playoffSetsToWin?: PlayoffSetsToWin;
}

/**
 * Длины встреч этапа по схеме турнира — ADR-061.
 *
 * Жеребьёвка и достройка кладут их в `Stage.config` (`draw.ts`), правка по
 * ходу турнира — переписывает. Совпадение с жеребьёвкой стережёт тест
 * `stage-config.test.ts`: иначе правка длины поменяла бы этап не так, как
 * его построили.
 */
export function stageLengths(format: FormatConfig, stageType: StageType): StageLengths {
  switch (format.type) {
    case 'ROUND_ROBIN':
    case 'GROUPS_FINAL_GROUPS':
      return { setsToWin: format.setsToWin };
    case 'KNOCKOUT':
      return withPlayoff(format.setsToWin, format.playoffSetsToWin);
    case 'GROUPS_KNOCKOUT':
      if (stageType === 'GROUPS') return { setsToWin: format.groupSetsToWin };
      // Сетка за места играется общей длиной плей-офф — ADR-045.
      if (stageType === 'CONSOLATION') return { setsToWin: format.koSetsToWin };
      return withPlayoff(format.koSetsToWin, format.playoffSetsToWin);
  }
}

function withPlayoff(setsToWin: number, lengths: PlayoffSetsToWin | undefined): StageLengths {
  return lengths === undefined ? { setsToWin } : { setsToWin, playoffSetsToWin: lengths };
}

/** Счёт по сетам нужен правилам 3 и 5 разрешения равенства — ТЗ 6.6. */
export function parseSetScores(value: unknown): [number, number][] | null {
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
