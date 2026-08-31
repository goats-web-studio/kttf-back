import type { MatchRecord, StageRecord } from './tournaments.select.js';

/**
 * Сыгран ли этап целиком.
 *
 * Правило одно на двоих: по нему достраивается плей-офф по итогам групп
 * (ADR-020) и по нему же завершается турнир (ТЗ 4.1). Две копии этого правила
 * разошлись бы, и турнир либо не завершался бы после достройки, либо
 * завершался до неё.
 *
 * Различие между групповым этапом и сеткой существенное:
 *
 * - **В группах** встречу снявшегося ждать нельзя: он её не сыграет никогда.
 *   Техническую победу сопернику даёт расчёт таблицы, а не запись в базе
 *   (ADR-009), поэтому такая встреча так и остаётся без результата.
 * - **В сетке** ждать приходится: пока результата нет, `resolveBracketSlots`
 *   не поднимет победителя в следующий круг, и играть будет некому. Снятие
 *   здесь вводится судьёй явной технической победой — иначе сетка не едет.
 */
export function unplayedMatches(stage: StageRecord, withdrawn: ReadonlySet<string>): MatchRecord[] {
  return stage.matches.filter((match) => !isSettled(stage, match, withdrawn));
}

export function isStageComplete(stage: StageRecord, withdrawn: ReadonlySet<string>): boolean {
  return unplayedMatches(stage, withdrawn).length === 0;
}

function isSettled(
  stage: StageRecord,
  match: MatchRecord,
  withdrawn: ReadonlySet<string>,
): boolean {
  if (match.setsA !== null) return true;
  if (match.status === 'CANCELLED') return true;

  // Встреча сетки без результата не сыграна, даже если участники в ней ещё
  // не определились: пустые слоты означают несыгранную встречу выше по сетке,
  // и та попадёт в список тоже. Считать такую встречу сыгранной значило бы
  // завершить турнир с недоигранной сеткой.
  if (stage.type === 'KNOCKOUT') return false;

  const { playerAId, playerBId } = match;

  // Состав группы известен с самой жеребьёвки, пустых слотов там не бывает.
  if (playerAId === null || playerBId === null) return true;

  return withdrawn.has(playerAId) || withdrawn.has(playerBId);
}
