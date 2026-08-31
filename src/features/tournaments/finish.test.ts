import { describe, expect, it } from 'vitest';

import {
  buildRatingRun,
  playersWithoutSnapshot,
  ratedMatches,
  ratedPlayers,
  unfinishedMatches,
  unresolvedTies,
  withdrawnPlayers,
} from './finish.js';
import type { RegistrationRecord, StageRecord } from './tournaments.select.js';

/**
 * Подготовка завершения турнира — ТЗ 4.1 и ТЗ 7.3.
 *
 * Проверяется отбор: что доходит до движка рейтинга и что останавливает
 * завершение. Сам расчёт покрыт в общем коде и здесь не дублируется.
 */

interface MatchSeed {
  readonly a: string | null;
  readonly b: string | null;
  readonly setsA?: number;
  readonly setsB?: number;
  readonly resultType?: 'NORMAL' | 'WALKOVER' | 'RETIRED';
  readonly id?: string;
  readonly round?: number;
  readonly slot?: number;
  readonly sourceA?: unknown;
  readonly status?: string;
}

function makeStage(
  type: StageRecord['type'],
  matches: readonly MatchSeed[],
  order = 0,
): StageRecord {
  return {
    id: `stage-${String(order)}`,
    order,
    type,
    name: type,
    config: { setsToWin: 3 },
    groups: [],
    matches: matches.map((match, index) => ({
      id: match.id ?? `s${String(order)}m${String(index)}`,
      stageId: `stage-${String(order)}`,
      groupId: null,
      playerAId: match.a,
      playerBId: match.b,
      sourceA: match.sourceA ?? null,
      sourceB: null,
      status: match.status ?? (match.setsA === undefined ? 'PENDING' : 'FINISHED'),
      tableNumber: null,
      setsA: match.setsA ?? null,
      setsB: match.setsB ?? null,
      setScores: null,
      resultType: match.setsA === undefined ? null : (match.resultType ?? 'NORMAL'),
      bracketRound: match.round ?? null,
      bracketSlot: match.slot ?? null,
    })),
  } as unknown as StageRecord;
}

interface PlayerSeed {
  readonly id: string;
  readonly status?: RegistrationRecord['status'];
  readonly isRated?: boolean;
  readonly ratingAtStart?: number | null;
  readonly matchesAtStart?: number | null;
  readonly rating?: number;
  readonly ratedMatches?: number;
}

function makeRegistration(seed: PlayerSeed): RegistrationRecord {
  return {
    id: `reg-${seed.id}`,
    tournamentId: 't',
    status: seed.status ?? 'PLAYING',
    isRated: seed.isRated ?? true,
    seed: null,
    ratingAtStart: seed.ratingAtStart === undefined ? 300 : seed.ratingAtStart,
    matchesAtStart: seed.matchesAtStart === undefined ? 25 : seed.matchesAtStart,
    createdAt: new Date(),
    player: {
      id: seed.id,
      rating: seed.rating ?? 300,
      ratedMatches: seed.ratedMatches ?? 25,
    },
  } as unknown as RegistrationRecord;
}

describe('снявшиеся', () => {
  it('снятые и не явившиеся собираются вместе — ТЗ 4.4', () => {
    const withdrawn = withdrawnPlayers([
      makeRegistration({ id: 'a' }),
      makeRegistration({ id: 'b', status: 'WITHDRAWN' }),
      makeRegistration({ id: 'c', status: 'NO_SHOW' }),
    ]);

    expect([...withdrawn].sort()).toEqual(['b', 'c']);
  });
});

describe('несыгранные встречи', () => {
  it('пустой список означает, что турнир доигран', () => {
    const stages = [makeStage('ROUND_ROBIN', [{ a: 'a', b: 'b', setsA: 3, setsB: 1 }])];

    expect(unfinishedMatches(stages, new Set())).toEqual([]);
  });

  it('встреча без результата держит турнир', () => {
    const stages = [
      makeStage('ROUND_ROBIN', [
        { a: 'a', b: 'b', setsA: 3, setsB: 1 },
        { a: 'a', b: 'c', id: 'ждём' },
      ]),
    ];

    expect(unfinishedMatches(stages, new Set())).toEqual(['ждём']);
  });

  it('встречу снявшегося в группе ждать не нужно — ADR-009', () => {
    const stages = [makeStage('ROUND_ROBIN', [{ a: 'a', b: 'b' }])];

    expect(unfinishedMatches(stages, new Set(['b']))).toEqual([]);
  });

  it('в сетке та же встреча ждёт технической победы от судьи', () => {
    // Без записанного результата победитель не поедет в следующий круг,
    // и играть там будет некому.
    const stages = [makeStage('KNOCKOUT', [{ a: 'a', b: 'b', id: 'полуфинал' }])];

    expect(unfinishedMatches(stages, new Set(['b']))).toEqual(['полуфинал']);
  });

  it('пустой слот сетки тоже считается несыгранной встречей', () => {
    const stages = [
      makeStage('KNOCKOUT', [
        { a: 'a', b: 'b', id: 'четвертьфинал' },
        { a: null, b: null, id: 'финал', sourceA: { kind: 'WINNER', matchId: 'четвертьфинал' } },
      ]),
    ];

    expect(unfinishedMatches(stages, new Set())).toEqual(['четвертьфинал', 'финал']);
  });

  it('несыгранное считается по всем этапам сразу', () => {
    const stages = [
      makeStage('GROUPS', [{ a: 'a', b: 'b', setsA: 3, setsB: 0 }], 0),
      makeStage('KNOCKOUT', [{ a: 'a', b: 'c', id: 'финал' }], 1),
    ];

    expect(unfinishedMatches(stages, new Set())).toEqual(['финал']);
  });
});

describe('неразрешённые равенства', () => {
  it('называются метками групп — ADR-008', () => {
    const ties = unresolvedTies({
      tournamentId: 't',
      groups: [
        { stageId: 's', groupId: 'g1', label: 'гр. 1', rows: [], unresolved: [] },
        {
          stageId: 's',
          groupId: 'g2',
          label: 'гр. 2',
          rows: [],
          unresolved: [{ participants: ['a', 'b'], places: [1, 2] }],
        },
      ],
    });

    expect(ties).toEqual(['гр. 2']);
  });
});

describe('участники расчёта', () => {
  it('снимок и текущее состояние разводятся — ТС 5.4', () => {
    const players = ratedPlayers([
      makeRegistration({
        id: 'a',
        ratingAtStart: 300,
        matchesAtStart: 10,
        rating: 355,
        ratedMatches: 14,
      }),
    ]);

    expect(players.get('a')).toEqual({
      atStart: { rating: 300, ratedMatches: 10 },
      current: { rating: 355, ratedMatches: 14 },
    });
  });

  it('вне зачёта в расчёт не входит — ТЗ 7.2', () => {
    const players = ratedPlayers([makeRegistration({ id: 'a', isRated: false })]);

    expect(players.size).toBe(0);
  });

  it('снявшийся входит: сыгранное им учитывается — ТЗ 4.4', () => {
    const players = ratedPlayers([makeRegistration({ id: 'a', status: 'WITHDRAWN' })]);

    expect(players.has('a')).toBe(true);
  });

  it('без снимка на старте участник в расчёт не попадает', () => {
    expect(ratedPlayers([makeRegistration({ id: 'a', ratingAtStart: null })]).size).toBe(0);
    expect(ratedPlayers([makeRegistration({ id: 'a', matchesAtStart: null })]).size).toBe(0);
  });
});

describe('встречи в зачёт', () => {
  const players = ratedPlayers([
    makeRegistration({ id: 'a' }),
    makeRegistration({ id: 'b' }),
    makeRegistration({ id: 'c', isRated: false }),
  ]);

  it('победитель определяется по счёту, а не по стороне', () => {
    const stages = [makeStage('ROUND_ROBIN', [{ a: 'a', b: 'b', setsA: 1, setsB: 3 }])];

    expect(ratedMatches(stages, players)).toEqual([
      {
        matchId: 's0m0',
        winnerId: 'b',
        loserId: 'a',
        winnerSets: 3,
        loserSets: 1,
        resultType: 'NORMAL',
      },
    ]);
  });

  it('встреча с участником вне зачёта отсеивается целиком', () => {
    const stages = [makeStage('ROUND_ROBIN', [{ a: 'a', b: 'c', setsA: 3, setsB: 0 }])];

    expect(ratedMatches(stages, players)).toEqual([]);
  });

  it('несыгранное и равный счёт до движка не доходят', () => {
    const stages = [
      makeStage('ROUND_ROBIN', [
        { a: 'a', b: 'b' },
        { a: 'a', b: 'b', setsA: 2, setsB: 2 },
        { a: null, b: 'b', setsA: 3, setsB: 0 },
      ]),
    ];

    expect(ratedMatches(stages, players)).toEqual([]);
  });

  it('техническая победа доходит: правило нуля принадлежит движку', () => {
    const stages = [
      makeStage('ROUND_ROBIN', [{ a: 'a', b: 'b', setsA: 3, setsB: 0, resultType: 'WALKOVER' }]),
    ];

    expect(ratedMatches(stages, players)[0]?.resultType).toBe('WALKOVER');
  });

  it('порядок структурный: этап, круг, позиция, идентификатор', () => {
    const stages = [
      makeStage(
        'KNOCKOUT',
        [
          { a: 'a', b: 'b', setsA: 3, setsB: 0, id: 'второй круг', round: 2, slot: 0 },
          { a: 'a', b: 'b', setsA: 3, setsB: 0, id: 'первый круг, слот 1', round: 1, slot: 1 },
          { a: 'a', b: 'b', setsA: 3, setsB: 0, id: 'первый круг, слот 0', round: 1, slot: 0 },
        ],
        1,
      ),
      makeStage('GROUPS', [{ a: 'a', b: 'b', setsA: 3, setsB: 0, id: 'группа' }], 0),
    ];

    expect(ratedMatches(stages, players).map((match) => match.matchId)).toEqual([
      'группа',
      'первый круг, слот 0',
      'первый круг, слот 1',
      'второй круг',
    ]);
  });

  it('встречи одного круга без позиции разводятся идентификатором', () => {
    // Порядок обязан быть воспроизводимым: пересчёт истории даёт ту же
    // цепочку событий (ТС 5.5, инвариант 8), а порядок выборки — не даёт.
    const stages = [
      makeStage('ROUND_ROBIN', [
        { a: 'a', b: 'b', setsA: 3, setsB: 0, id: 'm-b' },
        { a: 'a', b: 'b', setsA: 3, setsB: 0, id: 'm-a' },
      ]),
    ];

    expect(ratedMatches(stages, players).map((match) => match.matchId)).toEqual(['m-a', 'm-b']);
  });
});

describe('игроки без снимка', () => {
  it('сыгравший, которого нет в составе, останавливает завершение', () => {
    const stages = [makeStage('ROUND_ROBIN', [{ a: 'a', b: 'чужой', setsA: 3, setsB: 0 }])];

    expect(playersWithoutSnapshot(stages, [makeRegistration({ id: 'a' })])).toEqual(['чужой']);
  });

  it('вне зачёта снимок имеет и претензий не вызывает', () => {
    const stages = [makeStage('ROUND_ROBIN', [{ a: 'a', b: 'b', setsA: 3, setsB: 0 }])];
    const registrations = [
      makeRegistration({ id: 'a' }),
      makeRegistration({ id: 'b', isRated: false }),
    ];

    expect(playersWithoutSnapshot(stages, registrations)).toEqual([]);
  });

  it('несыгранная встреча претензий не вызывает', () => {
    const stages = [makeStage('ROUND_ROBIN', [{ a: 'a', b: 'чужой' }])];

    expect(playersWithoutSnapshot(stages, [makeRegistration({ id: 'a' })])).toEqual([]);
  });

  it('участник без снимка в составе тоже считается чужим', () => {
    const stages = [makeStage('ROUND_ROBIN', [{ a: 'a', b: 'b', setsA: 3, setsB: 0 }])];
    const registrations = [
      makeRegistration({ id: 'a' }),
      makeRegistration({ id: 'b', ratingAtStart: null }),
    ];

    expect(playersWithoutSnapshot(stages, registrations)).toEqual(['b']);
  });
});

describe('вход движка', () => {
  it('собирается целиком: уровень, участники, встречи', () => {
    const run = buildRatingRun(
      'NATIONAL',
      [makeRegistration({ id: 'a' }), makeRegistration({ id: 'b' })],
      [makeStage('ROUND_ROBIN', [{ a: 'a', b: 'b', setsA: 3, setsB: 1 }])],
    );

    expect(run.level).toBe('NATIONAL');
    expect([...run.players.keys()].sort()).toEqual(['a', 'b']);
    expect(run.matches).toHaveLength(1);
  });
});
