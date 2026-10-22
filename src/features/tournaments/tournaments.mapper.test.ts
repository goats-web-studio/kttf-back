import { describe, expect, it } from 'vitest';

import { toRegistrationCoach } from './tournaments.mapper.js';

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
