import type { AdvancingSelection } from '@kttf/shared/brackets';
import { AppError } from '@kttf/shared/errors';
import type { FormatConfig } from '@kttf/shared/types';
import { describe, expect, it } from 'vitest';

import { type DrawParticipant, planDraw, planNextStage, seedParticipants } from './draw.js';

function makeIdFactory(): () => string {
  let counter = 0;

  return () => `m${String(counter++)}`;
}

function participants(count: number, club: string | null = null): DrawParticipant[] {
  return Array.from({ length: count }, (_, index) => ({
    playerId: `p${String(index)}`,
    // По убыванию: первый сильнейший.
    rating: 500 - index * 10,
    clubId: club,
    seed: null,
  }));
}

const ROUND_ROBIN: FormatConfig = { type: 'ROUND_ROBIN', rounds: 1, setsToWin: 3 };

describe('посев', () => {
  it('по рейтингу — сильнейший первым', () => {
    const shuffled = [...participants(4)].reverse();

    expect(seedParticipants(shuffled, { method: 'RATING', separateByClub: true })).toMatchObject([
      { playerId: 'p0' },
      { playerId: 'p1' },
      { playerId: 'p2' },
      { playerId: 'p3' },
    ]);
  });

  it('при равных рейтингах порядок воспроизводим', () => {
    // Порядок выборки из базы воспроизводимым не является, а жеребьёвка
    // обязана быть таковой.
    const equal: DrawParticipant[] = [
      { playerId: 'b', rating: 300, clubId: null, seed: null },
      { playerId: 'a', rating: 300, clubId: null, seed: null },
    ];

    expect(seedParticipants(equal, null).map((player) => player.playerId)).toEqual(['a', 'b']);
  });

  it('ручной посев старше рейтинга, остальные идут следом', () => {
    const mixed: DrawParticipant[] = [
      { playerId: 'weak-but-seeded', rating: 100, clubId: null, seed: 1 },
      { playerId: 'strong', rating: 900, clubId: null, seed: null },
    ];

    expect(
      seedParticipants(mixed, { method: 'MANUAL', separateByClub: false }).map((p) => p.playerId),
    ).toEqual(['weak-but-seeded', 'strong']);
  });

  it('случайный посев порядок не меняет — его задаёт вызывающий', () => {
    // Иначе функция перестала бы быть чистой, а жеребьёвку нельзя было бы
    // воспроизвести по тем же входным данным.
    const given = participants(3);

    expect(
      seedParticipants([...given].reverse(), { method: 'RANDOM', separateByClub: false }).map(
        (p) => p.playerId,
      ),
    ).toEqual(['p2', 'p1', 'p0']);
  });
});

describe('круговая', () => {
  it('каждый играет с каждым по разу', () => {
    const plan = planDraw(ROUND_ROBIN, participants(4), null, makeIdFactory());

    expect(plan.stages).toHaveLength(1);
    expect(plan.stages[0]?.matches).toHaveLength(6);
    expect(plan.stages[0]?.type).toBe('ROUND_ROBIN');
  });

  it('в два круга встреч вдвое больше', () => {
    const plan = planDraw(
      { type: 'ROUND_ROBIN', rounds: 2, setsToWin: 3 },
      participants(4),
      null,
      makeIdFactory(),
    );

    expect(plan.stages[0]?.matches).toHaveLength(12);
  });

  it('группа заводится одна — судье негде было бы хранить решение о равенстве', () => {
    const plan = planDraw(ROUND_ROBIN, participants(4), null, makeIdFactory());

    expect(plan.stages[0]?.groups).toHaveLength(1);
    expect(plan.stages[0]?.groups[0]?.participants).toHaveLength(4);
  });

  it('все участники известны сразу, источников нет', () => {
    const plan = planDraw(ROUND_ROBIN, participants(4), null, makeIdFactory());

    for (const match of plan.stages[0]?.matches ?? []) {
      expect(match.playerAId).not.toBeNull();
      expect(match.sourceA).toBeNull();
    }
  });

  it('одного участника мало', () => {
    expect(() => planDraw(ROUND_ROBIN, participants(1), null, makeIdFactory())).toThrow(
      /two participants/,
    );
  });
});

describe('олимпийская сетка', () => {
  const KNOCKOUT: FormatConfig = {
    type: 'KNOCKOUT',
    setsToWin: 3,
    thirdPlace: false,
    consolation: false,
  };

  it('разворачивается целиком, а не только первым кругом', () => {
    // ТЗ 9.4 требует показывать сетку в результатах, второй экран — по ходу
    // турнира. Восемь участников это семь встреч (ADR-019).
    const plan = planDraw(KNOCKOUT, participants(8), null, makeIdFactory());

    expect(plan.stages[0]?.matches).toHaveLength(7);
  });

  it('поздние круги ссылаются на победителей, а не на игроков', () => {
    const plan = planDraw(KNOCKOUT, participants(8), null, makeIdFactory());
    const semifinal = plan.stages[0]?.matches.find((match) => match.bracketRound === 2);

    expect(semifinal?.playerAId).toBeNull();
    expect(semifinal?.sourceA).toMatchObject({ kind: 'WINNER' });
  });

  it('ссылки ведут на существующие встречи', () => {
    const plan = planDraw(KNOCKOUT, participants(8), null, makeIdFactory());
    const known = new Set(plan.stages[0]?.matches.map((match) => match.id));

    for (const match of plan.stages[0]?.matches ?? []) {
      for (const source of [match.sourceA, match.sourceB]) {
        if (source !== null) expect(known.has(source.matchId), source.matchId).toBe(true);
      }
    }
  });

  it('матч за третье место добавляется по требованию', () => {
    const withThird = planDraw(
      { ...KNOCKOUT, thirdPlace: true },
      participants(4),
      null,
      makeIdFactory(),
    );

    expect(withThird.stages[0]?.matches).toHaveLength(4);
  });

  it('утешительная сетка честно отвергается', () => {
    // Движок её не строит, а собирать сетку в приложении запрещено:
    // офлайн-консоль обязана получить ту же сетку тем же кодом.
    expect(() =>
      planDraw({ ...KNOCKOUT, consolation: true }, participants(8), null, makeIdFactory()),
    ).toThrow(/Consolation/);
  });
});

describe('групповой этап', () => {
  const GROUPS: FormatConfig = {
    type: 'GROUPS_KNOCKOUT',
    groupCount: 2,
    advancePerGroup: 2,
    groupSetsToWin: 3,
    koSetsToWin: 3,
    thirdPlace: true,
  };

  it('строится только он: плей-офф сеется результатами, которых ещё нет', () => {
    const plan = planDraw(GROUPS, participants(8), null, makeIdFactory());

    expect(plan.stages).toHaveLength(1);
    expect(plan.stages[0]?.type).toBe('GROUPS');
    expect(plan.stages[0]?.groups).toHaveLength(2);
  });

  it('внутри каждой группы играют все со всеми', () => {
    const plan = planDraw(GROUPS, participants(8), null, makeIdFactory());

    // Две группы по четыре: по шесть встреч в каждой.
    expect(plan.stages[0]?.matches).toHaveLength(12);
  });

  it('несведённые одноклубники возвращаются списком', () => {
    // Их не может не быть: четверо из одного клуба на две группы —
    // совпадение неизбежно арифметически (ADR-011).
    const plan = planDraw(GROUPS, participants(4, 'club-1'), null, makeIdFactory());

    expect(plan.clubCollisions.length).toBeGreaterThan(0);
    expect(plan.clubCollisions[0]).toMatchObject({ club: 'club-1' });
  });

  it('без одноклубников список пуст, но возвращается', () => {
    const plan = planDraw(GROUPS, participants(8), null, makeIdFactory());

    expect(plan.clubCollisions).toEqual([]);
  });
});

describe('достройка этапа по итогам групп', () => {
  const GROUPS_KNOCKOUT: FormatConfig = {
    type: 'GROUPS_KNOCKOUT',
    groupCount: 2,
    advancePerGroup: 2,
    groupSetsToWin: 3,
    koSetsToWin: 4,
    thirdPlace: true,
  };

  const FINAL_GROUPS: FormatConfig = {
    type: 'GROUPS_FINAL_GROUPS',
    groupCount: 2,
    advancePerGroup: 2,
    finalGroupCount: 2,
    setsToWin: 3,
  };

  const SELECTION: AdvancingSelection = {
    seeded: ['a1', 'b1', 'a2', 'b2'],
    byPlace: [
      ['a1', 'b1'],
      ['a2', 'b2'],
    ],
    blocked: [],
  };

  it('плей-офф — это сетка вторым этапом', () => {
    const stage = planNextStage(GROUPS_KNOCKOUT, SELECTION, makeIdFactory());

    expect(stage).toMatchObject({ order: 1, type: 'KNOCKOUT', name: 'Плей-офф' });
    // Полуфиналы, финал и встреча за третье место.
    expect(stage?.matches).toHaveLength(4);
  });

  it('плей-офф играется по своей планке сетов, а не по групповой', () => {
    const stage = planNextStage(GROUPS_KNOCKOUT, SELECTION, makeIdFactory());

    expect(stage?.config).toMatchObject({ setsToWin: 4 });
  });

  it('участники плей-офф известны сразу: они уже вышли', () => {
    const stage = planNextStage(GROUPS_KNOCKOUT, SELECTION, makeIdFactory());
    const first = stage?.matches.filter((match) => match.bracketRound === 1) ?? [];

    expect(first).toHaveLength(2);
    for (const match of first) {
      expect(match.playerAId).not.toBeNull();
      expect(match.playerBId).not.toBeNull();
    }
  });

  it('финал ссылается на победителей полуфиналов', () => {
    const stage = planNextStage(GROUPS_KNOCKOUT, SELECTION, makeIdFactory());
    const final = stage?.matches.find(
      (match) => match.bracketRound === 2 && match.bracketSlot === 0,
    );

    expect(final?.sourceA).toMatchObject({ kind: 'WINNER' });
    expect(final?.sourceB).toMatchObject({ kind: 'WINNER' });
    expect(final?.playerAId).toBeNull();
  });

  it('финальные группы собираются по местам', () => {
    // ТЗ 5.1, «финалы по местам»: k-я группа — те, кто занял k-е место.
    const stage = planNextStage(FINAL_GROUPS, SELECTION, makeIdFactory());

    expect(stage).toMatchObject({ order: 1, type: 'GROUPS', name: 'Финальные группы' });
    expect(stage?.groups.map((group) => group.participants)).toEqual([
      ['a1', 'b1'],
      ['a2', 'b2'],
    ]);
  });

  it('в финальной группе играют все со всеми', () => {
    const stage = planNextStage(FINAL_GROUPS, SELECTION, makeIdFactory());

    // Две группы по двое: по одной встрече в каждой.
    expect(stage?.matches).toHaveLength(2);
    expect(stage?.matches.every((match) => match.groupKey !== null)).toBe(true);
  });

  it('схемы без второго этапа его и не получают', () => {
    expect(planNextStage(ROUND_ROBIN, SELECTION, makeIdFactory())).toBeNull();
  });
});

describe('жеребьёвка отвергает конфигурацию, из которой некому выйти', () => {
  it('из групп по одному при одной группе выходит один — плей-офф не собрать', () => {
    // Проверка стоит здесь, а не на достройке: достройка случается посреди
    // турнира при вводе счёта, и отказывать судье там поздно и не за что.
    const config: FormatConfig = {
      type: 'GROUPS_KNOCKOUT',
      groupCount: 1,
      advancePerGroup: 1,
      groupSetsToWin: 3,
      koSetsToWin: 3,
      thirdPlace: false,
    };

    expect(() => planDraw(config, participants(4), null, makeIdFactory())).toThrow(AppError);
  });
});
