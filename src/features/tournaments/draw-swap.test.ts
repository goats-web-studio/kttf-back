import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import { describe, expect, it } from 'vitest';

import { planDrawSwap, type DrawMatch } from './draw-swap.js';

/**
 * Ручная корректировка жеребьёвки — ТЗ 5.3.
 *
 * Проверяется то, ради чего обмен выбран вместо полной расстановки: состав
 * групп и структура сетки остаются теми же, какими их построил движок.
 */

function match(id: string, a: string | null, b: string | null, setsA: number | null = null) {
  return { id, playerAId: a, playerBId: b, setsA } satisfies DrawMatch;
}

/** Две группы по три, круговая внутри каждой. */
const GROUPS: DrawMatch[] = [
  match('m1', 'a1', 'a2'),
  match('m2', 'a1', 'a3'),
  match('m3', 'a2', 'a3'),
  match('m4', 'b1', 'b2'),
  match('m5', 'b1', 'b3'),
  match('m6', 'b2', 'b3'),
];

describe('обмен двумя игроками', () => {
  it('переставляет игрока в другую группу, не трогая её размер', () => {
    const updates = planDrawSwap(GROUPS, 'a1', 'b1');

    // Изменились только встречи этих двоих: у остальных состав прежний.
    expect(updates.map((update) => update.id)).toEqual(['m1', 'm2', 'm4', 'm5']);

    const byId = new Map(updates.map((update) => [update.id, update]));
    expect(byId.get('m1')).toEqual({ id: 'm1', playerAId: 'b1', playerBId: 'a2' });
    expect(byId.get('m4')).toEqual({ id: 'm4', playerAId: 'a1', playerBId: 'b2' });
  });

  it('внутри одной группы меняет стороны, а не состав', () => {
    // Перестановка в другой слот той же группы: соперники у обоих те же,
    // меняется расписание. Встреча этих двоих не задваивается.
    const updates = planDrawSwap(GROUPS, 'a1', 'a2');

    expect(updates.map((update) => update.id)).toEqual(['m1', 'm2', 'm3']);
    expect(updates[0]).toEqual({ id: 'm1', playerAId: 'a2', playerBId: 'a1' });
  });

  it('свободный проход достаётся тому, кого поставили на это место', () => {
    // Проход не материализован: участник просто начинает со второго круга
    // (ADR-019). Обмен именами переносит проход без отдельного случая.
    const bracket: DrawMatch[] = [
      match('r1', 'p3', 'p4'),
      match('final', 'p1', null),
    ];

    const updates = planDrawSwap(bracket, 'p1', 'p3');

    expect(updates).toEqual([
      { id: 'r1', playerAId: 'p1', playerBId: 'p4' },
      { id: 'final', playerAId: 'p3', playerBId: null },
    ]);
  });

  it('игрока вне расстановки не переставляет', () => {
    // Снятый или не попавший в жеребьёвку: меняться местами не с кем.
    expect(() => planDrawSwap(GROUPS, 'a1', 'нет-такого')).toThrow(
      expect.objectContaining({ code: ERROR_CODES.DRAW_POSITION_NOT_FOUND }) as AppError,
    );
  });

  it('не переписывает сыгранную встречу', () => {
    // До старта таких быть не может, но обмен, дошедший до сыгранной встречи,
    // молча переписал бы её результат на чужой.
    const played = [match('m1', 'a1', 'a2', 3), ...GROUPS.slice(1)];

    expect(() => planDrawSwap(played, 'a1', 'b1')).toThrow(
      expect.objectContaining({ code: ERROR_CODES.MATCH_ALREADY_FINISHED }) as AppError,
    );
  });

  it('пустая расстановка отвергается, а не молча ничего не делает', () => {
    expect(() => planDrawSwap([], 'a1', 'b1')).toThrow(AppError);
  });
});
