import { isAppError } from '@kttf/shared/errors';
import { describe, expect, it } from 'vitest';

import {
  assertScore,
  assertSlotTime,
  duelFlags,
  type FlagSubject,
  type PairDuel,
} from './duel-rules.js';

/** Правила дуэлей без базы — ADR-065, `docs/13` §3. */

const A = 'player-a';
const B = 'player-b';
const C = 'player-c';
const NOW = new Date('2026-10-24T10:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function codeOf(run: () => void): { code: string; details: unknown } | null {
  try {
    run();

    return null;
  } catch (error) {
    if (!isAppError(error)) throw error;

    return { code: error.code, details: error.details };
  }
}

describe('время варианта', () => {
  it('в будущем и не дальше 60 дней — можно', () => {
    expect(
      codeOf(() => {
        assertSlotTime(new Date(NOW.getTime() + DAY_MS), NOW);
      }),
    ).toBeNull();
    expect(
      codeOf(() => {
        assertSlotTime(new Date(NOW.getTime() + 60 * DAY_MS), NOW);
      }),
    ).toBeNull();
  });

  it('в прошлом, сейчас или дальше 60 дней — DUEL_TIME_INVALID', () => {
    for (const offset of [-DAY_MS, 0, 60 * DAY_MS + 1]) {
      expect(
        codeOf(() => {
          assertSlotTime(new Date(NOW.getTime() + offset), NOW, 1);
        }),
      ).toMatchObject({
        code: 'DUEL_TIME_INVALID',
        details: { index: 1, horizonDays: 60 },
      });
    }
  });
});

describe('счёт по формату', () => {
  it('до 3 побед: 3:0, 3:1, 3:2 — да', () => {
    for (const loserSets of [0, 1, 2]) {
      expect(
        codeOf(() => {
          assertScore(5, { winnerId: A, winnerSets: 3, loserSets }, [A, B]);
        }),
      ).toBeNull();
    }
  });

  it('не тот формат, ничья по партиям или чужой победитель — DUEL_SCORE_INVALID', () => {
    const cases = [
      { winnerId: A, winnerSets: 2, loserSets: 0 },
      { winnerId: A, winnerSets: 4, loserSets: 1 },
      { winnerId: A, winnerSets: 3, loserSets: 3 },
      { winnerId: C, winnerSets: 3, loserSets: 1 },
    ];

    for (const input of cases) {
      expect(
        codeOf(() => {
          assertScore(5, input, [A, B]);
        }),
      ).toEqual({
        code: 'DUEL_SCORE_INVALID',
        details: { setsToWin: 3 },
      });
    }
  });

  it('до 2 и до 4 побед', () => {
    expect(
      codeOf(() => {
        assertScore(3, { winnerId: B, winnerSets: 2, loserSets: 1 }, [A, B]);
      }),
    ).toBeNull();
    expect(
      codeOf(() => {
        assertScore(7, { winnerId: B, winnerSets: 4, loserSets: 3 }, [A, B]);
      }),
    ).toBeNull();
    expect(
      codeOf(() => {
        assertScore(7, { winnerId: B, winnerSets: 3, loserSets: 0 }, [A, B]);
      }),
    ).toMatchObject({
      details: { setsToWin: 4 },
    });
  });
});

describe('пометки администратора', () => {
  const at = new Date('2026-10-20T15:00:00.000Z');
  const subject = (over: Partial<FlagSubject> = {}): FlagSubject => ({
    id: 'duel-0',
    authorId: A,
    opponentId: B,
    at,
    winnerId: A,
    provisional: false,
    ...over,
  });
  const earlier = (index: number, over: Partial<PairDuel> = {}): PairDuel => ({
    id: `duel-${String(index)}`,
    authorId: index % 2 === 0 ? A : B,
    opponentId: index % 2 === 0 ? B : A,
    at: new Date(at.getTime() - index * 7 * DAY_MS),
    winnerId: A,
    ...over,
  });

  it('одна дуэль пары — без пометок, счёт пары 1', () => {
    expect(duelFlags(subject(), [], [])).toEqual({ flags: [], pairCount: 1 });
  });

  it('три за 30 дней, все выиграл один — частая и односторонняя', () => {
    const result = duelFlags(subject(), [earlier(1), earlier(2)], []);

    expect(result).toEqual({ flags: ['PAIR_FREQUENT', 'ONE_SIDED'], pairCount: 3 });
  });

  it('победы поровну — только частая', () => {
    expect(duelFlags(subject(), [earlier(1, { winnerId: B }), earlier(2)], []).flags).toEqual([
      'PAIR_FREQUENT',
    ]);
  });

  it('дальше 30 дней и чужие пары не считаются', () => {
    const result = duelFlags(
      subject(),
      [earlier(5), { ...earlier(1), opponentId: C }, earlier(1)],
      [],
    );

    expect(result.pairCount).toBe(2);
  });

  it('провизорный участник и большой набор победителя за 30 дней', () => {
    const gains = [
      { playerId: A, at, delta: 12.5 },
      { playerId: A, at: new Date(at.getTime() - 10 * DAY_MS), delta: 17.5 },
      // Старше окна и чужое — мимо.
      { playerId: A, at: new Date(at.getTime() - 40 * DAY_MS), delta: 50 },
      { playerId: B, at, delta: 40 },
    ];

    expect(duelFlags(subject({ provisional: true }), [], gains).flags).toEqual([
      'PROVISIONAL',
      'BIG_GAIN',
    ]);
    expect(duelFlags(subject(), [], gains.slice(0, 1)).flags).toEqual([]);
  });

  it('публикация без соперника — пары нет', () => {
    expect(duelFlags(subject({ opponentId: null, winnerId: null }), [earlier(1)], [])).toEqual({
      flags: [],
      pairCount: 0,
    });
  });
});
