import { describe, expect, it } from 'vitest';

import { toMatchView, toRegistrationCoach } from './tournaments.mapper.js';
import type { MatchRecord } from './tournaments.select.js';

const COACH = '99999999-9999-4999-8999-999999999999';

function coachPlayer(status: 'APPROVED' | 'PENDING', hiddenAt: Date | null = null) {
  return {
    lastName: 'Петров',
    firstName: 'Иван',
    coachPage: { slug: 'ivan-petrov', status, hiddenAt },
  };
}

describe('тренер участника на турнире (ADR-059, T3)', () => {
  it('выбранный из списка — «Фамилия Имя» по связи и ссылка на опубликованную страницу', () => {
    expect(
      toRegistrationCoach({
        coachPlayerId: COACH,
        coachName: null,
        coachPlayer: coachPlayer('APPROVED'),
      }),
    ).toEqual({ playerId: COACH, name: 'Петров Иван', slug: 'ivan-petrov' });
  });

  it('страница не опубликована или скрыта — без ссылки', () => {
    expect(
      toRegistrationCoach({
        coachPlayerId: COACH,
        coachName: null,
        coachPlayer: coachPlayer('PENDING'),
      })?.slug,
    ).toBeNull();
    expect(
      toRegistrationCoach({
        coachPlayerId: COACH,
        coachName: null,
        coachPlayer: coachPlayer('APPROVED', new Date('2026-10-01T00:00:00.000Z')),
      })?.slug,
    ).toBeNull();
    expect(
      toRegistrationCoach({
        coachPlayerId: COACH,
        coachName: null,
        coachPlayer: { lastName: 'Петров', firstName: 'Иван', coachPage: null },
      }),
    ).toEqual({ playerId: COACH, name: 'Петров Иван', slug: null });
  });

  it('вписанный строкой — как есть, без игрока и ссылки', () => {
    expect(
      toRegistrationCoach({ coachPlayerId: null, coachName: 'Сидоров', coachPlayer: null }),
    ).toEqual({ playerId: null, name: 'Сидоров', slug: null });
  });

  it('без тренера — null', () => {
    expect(
      toRegistrationCoach({ coachPlayerId: null, coachName: null, coachPlayer: null }),
    ).toBeNull();
  });
});

describe('встреча в ответе', () => {
  const record = {
    id: 'm1',
    stageId: 's1',
    groupId: null,
    playerAId: 'a',
    playerBId: 'b',
    sourceA: null,
    sourceB: null,
    status: 'FINISHED',
    tableNumber: 2,
    setsA: 2,
    setsB: 1,
    setScores: [
      [11, 7],
      [9, 11],
      [11, 5],
    ],
    resultType: 'NORMAL',
    bracketRound: 1,
    bracketSlot: 0,
    startedAt: null,
    finishedAt: null,
  } as unknown as MatchRecord;

  it('несёт счёт по партиям, если судья его вводил', () => {
    expect(toMatchView(record).setScores).toEqual([
      [11, 7],
      [9, 11],
      [11, 5],
    ]);
  });

  it('без счёта по партиям — null', () => {
    expect(toMatchView({ ...record, setScores: null }).setScores).toBeNull();
  });
});
