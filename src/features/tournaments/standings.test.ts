import { describe, expect, it } from 'vitest';

import { buildStandings } from './standings.js';
import type { StageRecord } from './tournaments.select.js';

const STAGE_ID = '11111111-1111-4111-8111-111111111111';
const GROUP_ID = '22222222-2222-4222-8222-222222222222';

interface MatchSeed {
  readonly a: string;
  readonly b: string;
  readonly setsA?: number;
  readonly setsB?: number;
  readonly setScores?: [number, number][];
}

/** Этап с одной группой. Форма записи повторяет выборку `stageFields`. */
function makeStage(matches: readonly MatchSeed[], orderedIds?: string[]): StageRecord {
  return {
    id: STAGE_ID,
    order: 0,
    type: 'ROUND_ROBIN',
    name: 'Круговая',
    config: { setsToWin: 3 },
    groups: [
      {
        id: GROUP_ID,
        label: 'Круговая',
        order: 0,
        tieDecisions: orderedIds === undefined ? [] : [{ orderedIds }],
      },
    ],
    matches: matches.map((match, index) => ({
      id: `match-${String(index)}`,
      stageId: STAGE_ID,
      groupId: GROUP_ID,
      playerAId: match.a,
      playerBId: match.b,
      sourceA: null,
      sourceB: null,
      status: match.setsA === undefined ? 'PENDING' : 'FINISHED',
      tableNumber: null,
      setsA: match.setsA ?? null,
      setsB: match.setsB ?? null,
      setScores: match.setScores ?? null,
      resultType: match.setsA === undefined ? null : 'NORMAL',
      bracketRound: 1,
      bracketSlot: null,
    })),
  } as unknown as StageRecord;
}

describe('групповая таблица', () => {
  it('считается по сыгранным встречам', () => {
    const result = buildStandings({
      tournamentId: STAGE_ID,
      stages: [
        makeStage([
          { a: 'x', b: 'y', setsA: 3, setsB: 0 },
          { a: 'y', b: 'z', setsA: 3, setsB: 1 },
          { a: 'x', b: 'z', setsA: 3, setsB: 2 },
        ]),
      ],
      withdrawn: [],
    });

    const rows = new Map(result.groups[0]?.rows.map((row) => [row.participant, row]));

    expect(rows.get('x')?.place).toBe(1);
    expect(rows.get('x')?.wins).toBe(2);
    expect(rows.get('z')?.place).toBe(3);
  });

  it('несыгранные встречи ещё не считаются', () => {
    const result = buildStandings({
      tournamentId: STAGE_ID,
      stages: [makeStage([{ a: 'x', b: 'y' }])],
      withdrawn: [],
    });

    expect(result.groups[0]?.rows.every((row) => row.played === 0)).toBe(true);
  });

  it('несыгранные встречи снявшегося уходят сопернику', () => {
    // ТЗ 4.4 и ADR-009: сыгранное остаётся, несыгранное — техническая победа.
    const result = buildStandings({
      tournamentId: STAGE_ID,
      stages: [
        makeStage([
          { a: 'x', b: 'y', setsA: 3, setsB: 0 },
          { a: 'y', b: 'z' },
          { a: 'x', b: 'z', setsA: 3, setsB: 1 },
        ]),
      ],
      withdrawn: ['y'],
    });

    const rows = new Map(result.groups[0]?.rows.map((row) => [row.participant, row]));

    expect(rows.get('z')?.wins).toBe(1);
    // Снявшийся из таблицы не исчезает, но за неявку очков не получает.
    expect(rows.get('y')?.points).toBe(1);
  });

  it('снявшийся остаётся в составе группы', () => {
    const result = buildStandings({
      tournamentId: STAGE_ID,
      stages: [makeStage([{ a: 'x', b: 'y' }])],
      withdrawn: ['y'],
    });

    expect(result.groups[0]?.rows).toHaveLength(2);
  });

  it('неразрешённое равенство возвращается судье', () => {
    // Круг из трёх побед: правила 1–5 не разделяют, шестое — жребий,
    // и его бросает судья, а не движок (ADR-008).
    const result = buildStandings({
      tournamentId: STAGE_ID,
      stages: [
        makeStage([
          { a: 'x', b: 'y', setsA: 3, setsB: 2 },
          { a: 'y', b: 'z', setsA: 3, setsB: 2 },
          { a: 'z', b: 'x', setsA: 3, setsB: 2 },
        ]),
      ],
      withdrawn: [],
    });

    expect(result.groups[0]?.unresolved).toHaveLength(1);
    expect(result.groups[0]?.rows.every((row) => row.place === null)).toBe(true);
  });

  it('решение судьи расставляет места', () => {
    const result = buildStandings({
      tournamentId: STAGE_ID,
      stages: [
        makeStage(
          [
            { a: 'x', b: 'y', setsA: 3, setsB: 2 },
            { a: 'y', b: 'z', setsA: 3, setsB: 2 },
            { a: 'z', b: 'x', setsA: 3, setsB: 2 },
          ],
          ['z', 'x', 'y'],
        ),
      ],
      withdrawn: [],
    });

    const rows = new Map(result.groups[0]?.rows.map((row) => [row.participant, row]));

    expect(result.groups[0]?.unresolved).toHaveLength(0);
    expect(rows.get('z')?.place).toBe(1);
    expect(rows.get('y')?.place).toBe(3);
  });

  it('этап без групп таблиц не даёт', () => {
    // Олимпийская сетка — не таблица: там места определяет сама сетка.
    const stage = { ...makeStage([]), groups: [] } as unknown as StageRecord;

    expect(
      buildStandings({ tournamentId: STAGE_ID, stages: [stage], withdrawn: [] }).groups,
    ).toEqual([]);
  });
});
