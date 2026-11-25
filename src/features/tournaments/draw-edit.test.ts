import { describe, expect, it } from 'vitest';

import { planDisband, planMove, planNewGroup, type EditableGroup } from './draw-edit.js';

/** Код и причина отказа: `{ code, reason }`. */
function refusalOf(run: () => unknown): { code?: string | undefined; reason?: unknown } {
  try {
    run();
  } catch (error) {
    const failure = error as { code?: string; details?: { reason?: unknown } };
    return { code: failure.code, reason: failure.details?.reason };
  }
  return {};
}

const groups: EditableGroup[] = [
  { id: 'g1', order: 0, label: 'гр. 1', participants: ['a', 'b', 'c'] },
  { id: 'g2', order: 1, label: 'гр. 2', participants: ['d', 'e', 'f'] },
  { id: 'g3', order: 2, label: 'гр. 3', participants: ['g', 'h'] },
];

describe('перенос игрока — ADR-124', () => {
  it('группы становятся разного размера', () => {
    const edit = planMove(groups, 'a', 'g2');

    expect(edit.changed.get('g1')).toEqual(['b', 'c']);
    expect(edit.changed.get('g2')).toEqual(['d', 'e', 'f', 'a']);
  });

  it('в группе остаётся не меньше двух', () => {
    expect(refusalOf(() => planMove(groups, 'g', 'g1')).reason).toBe('GROUP_TOO_SMALL');
  });

  it('в ту же группу — отказ, неизвестные — не найдено', () => {
    expect(refusalOf(() => planMove(groups, 'a', 'g1')).reason).toBe('SAME_GROUP');
    expect(refusalOf(() => planMove(groups, 'z', 'g1')).code).toBe('DRAW_POSITION_NOT_FOUND');
    expect(refusalOf(() => planMove(groups, 'a', 'g9')).code).toBe('DRAW_POSITION_NOT_FOUND');
  });
});

describe('новая группа из выбранных — ADR-124', () => {
  it('игроки уходят из своих групп', () => {
    const edit = planNewGroup(groups, ['a', 'd']);

    expect(edit.created).toEqual(['a', 'd']);
    expect(edit.changed.get('g1')).toEqual(['b', 'c']);
    expect(edit.changed.get('g2')).toEqual(['e', 'f']);
    expect(edit.changed.has('g3')).toBe(false);
  });

  it('группа ниже двух — отказ', () => {
    expect(refusalOf(() => planNewGroup(groups, ['a', 'g'])).reason).toBe('GROUP_TOO_SMALL');
    expect(refusalOf(() => planNewGroup(groups, ['a'])).reason).toBe('GROUP_TOO_SMALL');
  });

  it('игрок не из этапа — не найдено', () => {
    expect(refusalOf(() => planNewGroup(groups, ['a', 'z'])).code).toBe('DRAW_POSITION_NOT_FOUND');
  });
});

describe('расформирование группы — ADR-124', () => {
  it('игроки уходят по одному в самые малые', () => {
    const edit = planDisband(groups, 'g1');

    expect(edit.removed).toBe('g1');
    // g3 меньше всех — первый к ней, потом группы сравнялись, второй в g2.
    expect(edit.changed.get('g3')).toEqual(['g', 'h', 'a', 'c']);
    expect(edit.changed.get('g2')).toEqual(['d', 'e', 'f', 'b']);
  });

  it('последнюю группу не расформировать', () => {
    expect(refusalOf(() => planDisband(groups.slice(0, 1), 'g1')).reason).toBe('LAST_GROUP');
    expect(refusalOf(() => planDisband(groups, 'g9')).code).toBe('DRAW_POSITION_NOT_FOUND');
  });
});
