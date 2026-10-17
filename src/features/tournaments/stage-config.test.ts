import { describe, expect, it } from 'vitest';

import { matchSetsToWin } from './stage-config.js';

/**
 * Длина встречи для проверки счёта — ADR-044.
 *
 * Сама таблица кругов проверена в общем коде; здесь — разбор `Stage.config`,
 * который лежит в базе колонкой `Json` и может оказаться любым.
 */
describe('длина встречи по этапу', () => {
  const knockout = { setsToWin: 3, bracketSize: 16, playoffSetsToWin: { final: 4, thirdPlace: 2 } };

  it('финал и встреча за третье место — своей длиной', () => {
    expect(matchSetsToWin(knockout, { bracketRound: 4, bracketSlot: 0 })).toBe(4);
    expect(matchSetsToWin(knockout, { bracketRound: 4, bracketSlot: 1 })).toBe(2);
    expect(matchSetsToWin(knockout, { bracketRound: 1, bracketSlot: 3 })).toBe(3);
  });

  it('встреча группы позиции в сетке не имеет и играется длиной этапа', () => {
    expect(matchSetsToWin(knockout, { bracketRound: 1, bracketSlot: null })).toBe(3);
  });

  it('этап, созданный до появления длин, играется как раньше', () => {
    expect(
      matchSetsToWin({ setsToWin: 3, bracketSize: 16 }, { bracketRound: 4, bracketSlot: 0 }),
    ).toBe(3);
    expect(matchSetsToWin({ setsToWin: 2 }, { bracketRound: 4, bracketSlot: 0 })).toBe(2);
  });

  it('испорченная конфигурация не роняет ввод счёта', () => {
    expect(matchSetsToWin(null, { bracketRound: 4, bracketSlot: 0 })).toBe(3);
    expect(
      matchSetsToWin(
        { setsToWin: 3, bracketSize: 16, playoffSetsToWin: { final: 9 } },
        { bracketRound: 4, bracketSlot: 0 },
      ),
    ).toBe(3);
  });
});
