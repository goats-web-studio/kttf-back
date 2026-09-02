import { AppError, ERROR_CODES } from '@kttf/shared/errors';

/**
 * Ручная корректировка жеребьёвки — ТЗ 5.3.
 *
 * Чистая функция: получает встречи расстановки и двух игроков, возвращает
 * правки встреч. Ни базы, ни Prisma здесь нет.
 *
 * **Меняются имена в готовых встречах, а не структура.** Расстановку строит
 * движок, и перестроить её из базы нечем: состав группы выводится из её
 * встреч, а свободный проход в сетке вообще не материализован — участник
 * просто начинает со второго круга. Обмен именами оставляет структуру той
 * же, какой её построил движок: размеры групп, число встреч и круги не
 * меняются, а игроки оказываются на местах друг друга.
 *
 * Из этого следует и поведение свободного прохода: игрок, обменянный с тем,
 * кто проход занимал, получает проход сам. Отдельного случая для этого нет.
 */

export interface DrawMatch {
  readonly id: string;
  readonly playerAId: string | null;
  readonly playerBId: string | null;
  /** Результат встречи. Не `null` — встреча уже сыграна. */
  readonly setsA: number | null;
}

export interface MatchSwap {
  readonly id: string;
  readonly playerAId: string | null;
  readonly playerBId: string | null;
}

/**
 * Правки встреч, меняющие двух игроков местами.
 *
 * Возвращаются только изменившиеся встречи: остальные трогать незачем,
 * а версия турнира растёт от самой операции, а не от числа строк.
 */
export function planDrawSwap(
  matches: readonly DrawMatch[],
  playerAId: string,
  playerBId: string,
): MatchSwap[] {
  const involves = (match: DrawMatch, player: string): boolean =>
    match.playerAId === player || match.playerBId === player;

  const found = { [playerAId]: false, [playerBId]: false };

  for (const match of matches) {
    for (const player of [playerAId, playerBId]) {
      if (!involves(match, player)) continue;
      found[player] = true;

      // Вторая линия обороны: расстановку правят до старта, и сыгранных
      // встреч в ней быть не может. Если такая нашлась — обмен переписал бы
      // результат чужой встречи молча.
      if (match.setsA !== null) {
        throw new AppError(ERROR_CODES.MATCH_ALREADY_FINISHED, 'Match already has a result', {
          matchId: match.id,
        });
      }
    }
  }

  for (const player of [playerAId, playerBId]) {
    if (!found[player]) {
      throw new AppError(ERROR_CODES.DRAW_POSITION_NOT_FOUND, 'Player is not in the draw', {
        playerId: player,
      });
    }
  }

  const swap = (player: string | null): string | null => {
    if (player === playerAId) return playerBId;
    if (player === playerBId) return playerAId;
    return player;
  };

  return matches
    .map((match) => ({
      id: match.id,
      playerAId: swap(match.playerAId),
      playerBId: swap(match.playerBId),
    }))
    .filter((updated, index) => {
      const source = matches[index];
      return (
        source !== undefined &&
        (updated.playerAId !== source.playerAId || updated.playerBId !== source.playerBId)
      );
    });
}
