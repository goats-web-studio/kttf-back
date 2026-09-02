import { describe, expect, it } from 'vitest';

import { Prisma } from '../../generated/prisma/client.js';

import { buildResults, type RatingEventRecord } from './results.js';
import { buildStandings } from './standings.js';
import type { RegistrationRecord, StageRecord, TournamentRecord } from './tournaments.select.js';

/**
 * Публичные результаты — ТЗ 9.4.
 *
 * Проверяется сборка ответа, а не сам расчёт мест: он живёт в общем коде
 * и покрыт там. Здесь важно другое — что записи базы доезжают до движка без
 * потерь, а обратно приходит то, что схема проведения действительно дала.
 */

const TOURNAMENT_ID = '00000000-0000-4000-8000-000000000000';
const STAGE_ID = '11111111-1111-4111-8111-111111111111';
const GROUP_ID = '22222222-2222-4222-8222-222222222222';
const KO_STAGE_ID = '33333333-3333-4333-8333-333333333333';

interface MatchSeed {
  readonly id?: string;
  readonly a: string | null;
  readonly b: string | null;
  readonly setsA?: number;
  readonly setsB?: number;
  readonly round?: number;
  readonly slot?: number;
  readonly takesLosers?: boolean;
}

function makeMatch(stageId: string, groupId: string | null, seed: MatchSeed, index: number) {
  const source = seed.takesLosers === true ? { kind: 'LOSER', matchId: 'x' } : null;

  return {
    id: seed.id ?? `${stageId}-match-${String(index)}`,
    stageId,
    groupId,
    playerAId: seed.a,
    playerBId: seed.b,
    sourceA: source,
    sourceB: source,
    status: seed.setsA === undefined ? 'PENDING' : 'FINISHED',
    tableNumber: null,
    setsA: seed.setsA ?? null,
    setsB: seed.setsB ?? null,
    setScores: null,
    resultType: seed.setsA === undefined ? null : 'NORMAL',
    bracketRound: seed.round ?? 1,
    bracketSlot: seed.slot ?? null,
  };
}

function roundRobinStage(matches: readonly MatchSeed[]): StageRecord {
  return {
    id: STAGE_ID,
    order: 0,
    type: 'ROUND_ROBIN',
    name: 'Круговая',
    config: { setsToWin: 2 },
    groups: [{ id: GROUP_ID, label: 'Круговая', order: 0, tieDecisions: [] }],
    matches: matches.map((seed, index) => makeMatch(STAGE_ID, GROUP_ID, seed, index)),
  } as unknown as StageRecord;
}

function knockoutStage(matches: readonly MatchSeed[]): StageRecord {
  return {
    id: KO_STAGE_ID,
    order: 1,
    type: 'KNOCKOUT',
    name: 'Плей-офф',
    config: { setsToWin: 2, thirdPlace: true },
    groups: [],
    matches: matches.map((seed, index) => makeMatch(KO_STAGE_ID, null, seed, index)),
  } as unknown as StageRecord;
}

function registration(playerId: string, lastName: string, overrides = {}): RegistrationRecord {
  return {
    id: `reg-${playerId}`,
    tournamentId: TOURNAMENT_ID,
    status: 'PLAYING',
    isRated: true,
    seed: null,
    ratingAtStart: new Prisma.Decimal('250.00'),
    matchesAtStart: 0,
    createdAt: new Date('2026-09-01T08:00:00.000Z'),
    player: {
      id: playerId,
      userId: null,
      lastName,
      firstName: 'Имя',
      middleName: null,
      birthYear: 1995,
      gender: 'MALE',
      city: 'Алматы',
      photoUrl: null,
      clubId: null,
      rating: new Prisma.Decimal('250.00'),
      ratedMatches: 0,
      isProvisional: true,
      createdAt: new Date('2026-09-01T08:00:00.000Z'),
    },
    ...overrides,
  } as unknown as RegistrationRecord;
}

function tournament(formatType: string): TournamentRecord {
  return {
    id: TOURNAMENT_ID,
    clubId: '44444444-4444-4444-8444-444444444444',
    name: 'Кубок клуба',
    startsAt: new Date('2026-09-02T10:00:00.000Z'),
    registrationEndsAt: null,
    status: 'RATED',
    entryFee: 0,
    maxParticipants: null,
    ratingCapMax: null,
    ratingCapMin: null,
    birthYearFrom: null,
    birthYearTo: null,
    genderLimit: null,
    level: 'CLUB',
    tableCount: 4,
    formatConfig:
      formatType === 'ROUND_ROBIN'
        ? { type: 'ROUND_ROBIN', rounds: 1, setsToWin: 2 }
        : {
            type: formatType,
            groupCount: 2,
            advancePerGroup: 1,
            groupSetsToWin: 2,
            koSetsToWin: 2,
            thirdPlace: false,
          },
    seedingConfig: null,
    description: null,
    prizeInfo: null,
    publicToken: 'token',
    createdAt: new Date('2026-09-01T08:00:00.000Z'),
    startedAt: new Date('2026-09-02T10:00:00.000Z'),
    finishedAt: new Date('2026-09-02T12:00:00.000Z'),
    ratedAt: new Date('2026-09-02T12:00:01.000Z'),
    _count: { registrations: 3 },
  } as unknown as TournamentRecord;
}

function event(
  playerId: string,
  matchId: string | null,
  before: string,
  delta: string,
  after: string,
): RatingEventRecord {
  return {
    playerId,
    matchId,
    ratingBefore: new Prisma.Decimal(before),
    delta: new Prisma.Decimal(delta),
    ratingAfter: new Prisma.Decimal(after),
  };
}

function build(
  stages: readonly StageRecord[],
  registrations: readonly RegistrationRecord[],
  formatType = 'ROUND_ROBIN',
  events: readonly RatingEventRecord[] = [],
) {
  return buildResults({
    tournament: tournament(formatType),
    stages,
    registrations,
    standings: buildStandings({ tournamentId: TOURNAMENT_ID, stages, withdrawn: [] }),
    events,
  });
}

describe('круговая', () => {
  const stages = [
    roundRobinStage([
      { a: 'a', b: 'b', setsA: 2, setsB: 0 },
      { a: 'a', b: 'c', setsA: 2, setsB: 0 },
      { a: 'b', b: 'c', setsA: 2, setsB: 0 },
    ]),
  ];
  const registrations = [
    registration('a', 'Ахметов'),
    registration('b', 'Сериков'),
    registration('c', 'Нурланов'),
  ];

  it('места из таблицы попадают в участников по возрастанию', () => {
    const results = build(stages, registrations);

    expect(results.participants.map((row) => [row.player.id, row.place])).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    expect(results.participants.every((row) => row.reason === 'TABLE')).toBe(true);
  });

  it('таблицы, этапы и встречи отдаются вместе с местами', () => {
    const results = build(stages, registrations);

    expect(results.standings.groups).toHaveLength(1);
    expect(results.stages).toHaveLength(1);
    expect(results.stages[0]?.matches).toHaveLength(3);
    expect(results.shared).toEqual([]);
    expect(results.unresolved).toEqual([]);
  });

  it('турнир отдаётся целиком, включая момент обсчёта', () => {
    const results = build(stages, registrations);

    expect(results.tournament.status).toBe('RATED');
    expect(results.tournament.ratedAt).toBe('2026-09-02T12:00:01.000Z');
  });
});

describe('изменение рейтинга', () => {
  const stages = [
    roundRobinStage([
      { id: 'm1', a: 'a', b: 'b', setsA: 2, setsB: 0, round: 1 },
      { id: 'm2', a: 'a', b: 'c', setsA: 2, setsB: 0, round: 2 },
      { id: 'm3', a: 'b', b: 'c', setsA: 2, setsB: 0, round: 3 },
    ]),
  ];
  const registrations = [
    registration('a', 'Ахметов'),
    registration('b', 'Сериков'),
    registration('c', 'Нурланов'),
  ];

  it('события упорядочены структурно, а не в порядке выдачи базы', () => {
    // База отдаёт журнал вперемешку: createdAt у всех одинаковый, порядка
    // в нём нет. Восстанавливается он по встречам.
    const results = build(stages, registrations, 'ROUND_ROBIN', [
      event('a', 'm2', '266.00', '16.00', '282.00'),
      event('a', 'm1', '250.00', '16.00', '266.00'),
    ]);

    const own = results.ratings.find((row) => row.playerId === 'a');

    expect(own?.events.map((item) => item.matchId)).toEqual(['m1', 'm2']);
    expect(own?.ratingAfter).toBe('282');
  });

  it('сумма дельт считается десятичной, а не плавающей точкой', () => {
    const results = build(stages, registrations, 'ROUND_ROBIN', [
      event('a', 'm1', '250.00', '0.10', '250.10'),
      event('a', 'm2', '250.10', '0.20', '250.30'),
    ]);

    expect(results.ratings.find((row) => row.playerId === 'a')?.totalDelta).toBe('0.3');
  });

  it('снимок на старте отдаётся строкой, участник без событий — нулём', () => {
    const results = build(stages, registrations);
    const own = results.ratings.find((row) => row.playerId === 'c');

    expect(own?.ratingAtStart).toBe('250');
    expect(own?.ratingAfter).toBeNull();
    expect(own?.totalDelta).toBe('0');
    expect(own?.events).toEqual([]);
  });

  it('ручная корректировка без встречи уезжает в конец', () => {
    const results = build(stages, registrations, 'ROUND_ROBIN', [
      event('a', null, '282.00', '5.00', '287.00'),
      event('a', 'm1', '250.00', '16.00', '266.00'),
    ]);

    expect(
      results.ratings.find((row) => row.playerId === 'a')?.events.map((item) => item.matchId),
    ).toEqual(['m1', null]);
  });

  it('участник без снимка на старте описывается пустым значением', () => {
    const results = build(
      stages,
      [registration('a', 'Ахметов', { ratingAtStart: null, matchesAtStart: null })],
      'ROUND_ROBIN',
    );

    expect(results.ratings[0]?.ratingAtStart).toBeNull();
  });
});

describe('группы плюс сетка', () => {
  const groups = {
    id: STAGE_ID,
    order: 0,
    type: 'GROUPS',
    name: 'Группы',
    config: { setsToWin: 2 },
    groups: [
      { id: GROUP_ID, label: 'Группа A', order: 0, tieDecisions: [] },
      { id: 'group-b', label: 'Группа B', order: 1, tieDecisions: [] },
    ],
    matches: [
      makeMatch(STAGE_ID, GROUP_ID, { a: 'a', b: 'c', setsA: 2, setsB: 0 }, 0),
      makeMatch(STAGE_ID, 'group-b', { a: 'b', b: 'd', setsA: 2, setsB: 0 }, 1),
    ],
  } as unknown as StageRecord;

  const registrations = [
    registration('a', 'Ахметов'),
    registration('b', 'Сериков'),
    registration('c', 'Нурланов'),
    registration('d', 'Жумабаев'),
  ];

  it('не вышедшие из группы получают причину GROUP_EXIT, а не место', () => {
    const stages = [groups, knockoutStage([{ a: 'a', b: 'b', setsA: 2, setsB: 0, round: 1 }])];
    const results = build(stages, registrations, 'GROUPS_KNOCKOUT');

    const byId = Object.fromEntries(
      results.participants.map((row) => [row.player.id, [row.place, row.reason]]),
    );

    expect(byId).toEqual({
      a: [1, 'BRACKET'],
      b: [2, 'BRACKET'],
      c: [null, 'GROUP_EXIT'],
      d: [null, 'GROUP_EXIT'],
    });
  });

  it('встреча за третье место узнаётся по источникам, а не по позиции', () => {
    // В базе `kind` движка не хранится. Встреча за третье место —
    // единственная в сетке, куда едут проигравшие.
    const stages = [
      groups,
      knockoutStage([
        { id: 'sf1', a: 'a', b: 'c', setsA: 2, setsB: 0, round: 1 },
        { id: 'sf2', a: 'b', b: 'd', setsA: 2, setsB: 0, round: 1 },
        { id: 'final', a: 'a', b: 'b', setsA: 2, setsB: 0, round: 2 },
        { id: 'third', a: 'c', b: 'd', setsA: 2, setsB: 0, round: 2, takesLosers: true },
      ]),
    ];

    const results = build(stages, registrations, 'GROUPS_KNOCKOUT');
    const byId = Object.fromEntries(results.participants.map((row) => [row.player.id, row.place]));

    expect(byId).toEqual({ a: 1, b: 2, c: 3, d: 4 });
    expect(results.shared).toEqual([]);
  });

  it('без встречи за третье полуфиналисты делят места', () => {
    const stages = [
      groups,
      knockoutStage([
        { id: 'sf1', a: 'a', b: 'c', setsA: 2, setsB: 0, round: 1 },
        { id: 'sf2', a: 'b', b: 'd', setsA: 2, setsB: 0, round: 1 },
        { id: 'final', a: 'a', b: 'b', setsA: 2, setsB: 0, round: 2 },
      ]),
    ];

    const results = build(stages, registrations, 'GROUPS_KNOCKOUT');

    expect(results.shared).toEqual([{ participants: ['c', 'd'], places: [3, 4] }]);
  });

  it('техническая победа определяет место, хотя рейтинг не двигает', () => {
    const stages = [
      groups,
      knockoutStage([{ id: 'final', a: 'a', b: 'b', setsA: 2, setsB: 0, round: 1 }]),
    ];
    const results = build(stages, registrations, 'GROUPS_KNOCKOUT');

    expect(results.participants.find((row) => row.player.id === 'a')?.place).toBe(1);
  });
});

describe('состав участников', () => {
  const stages = [roundRobinStage([{ a: 'a', b: 'b', setsA: 2, setsB: 0 }])];

  it('снявшийся до жеребьёвки остаётся в составе с пустым местом', () => {
    const results = build(stages, [
      registration('a', 'Ахметов'),
      registration('b', 'Сериков'),
      registration('z', 'Ямалов', { status: 'WITHDRAWN' }),
    ]);

    const withdrawn = results.participants.find((row) => row.player.id === 'z');

    expect(withdrawn?.status).toBe('WITHDRAWN');
    expect(withdrawn?.place).toBeNull();
    expect(withdrawn?.reason).toBe('UNDECIDED');
  });

  it('без мест участники идут по фамилии', () => {
    const results = build(
      [roundRobinStage([])],
      [registration('a', 'Ямалов'), registration('b', 'Абдиров')],
    );

    expect(results.participants.map((row) => row.player.lastName)).toEqual(['Абдиров', 'Ямалов']);
  });

  it('вне зачёта виден отдельным признаком', () => {
    const results = build(stages, [
      registration('a', 'Ахметов'),
      registration('b', 'Сериков', { isRated: false }),
    ]);

    expect(results.participants.find((row) => row.player.id === 'b')?.isRated).toBe(false);
  });
});
