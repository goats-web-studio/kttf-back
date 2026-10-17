import { playoffSetsToWin } from '@kttf/shared/brackets';
import { playoffSetsToWinSchema } from '@kttf/shared/types';

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
