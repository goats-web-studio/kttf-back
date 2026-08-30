import { describe, expect, it } from 'vitest';

import { checkEligibility, type EligibilityLimits } from './eligibility.js';

const NO_LIMITS: EligibilityLimits = {
  ratingCapMax: null,
  ratingCapMin: null,
  birthYearFrom: null,
  birthYearTo: null,
  genderLimit: null,
};

const player = { rating: 300, birthYear: 2000, gender: 'MALE' };

describe('допуск на турнир', () => {
  it('без ограничений допускается кто угодно', () => {
    expect(checkEligibility(player, NO_LIMITS)).toEqual([]);
  });

  it('планка сверху отсекает сильных', () => {
    // ТЗ 4.2: «допускаются игроки с рейтингом ниже значения».
    expect(checkEligibility(player, { ...NO_LIMITS, ratingCapMax: 250 })).toEqual([
      'RATING_TOO_HIGH',
    ]);
    expect(checkEligibility(player, { ...NO_LIMITS, ratingCapMax: 350 })).toEqual([]);
  });

  it('равенство планке допускается', () => {
    expect(checkEligibility(player, { ...NO_LIMITS, ratingCapMax: 300 })).toEqual([]);
    expect(checkEligibility(player, { ...NO_LIMITS, ratingCapMin: 300 })).toEqual([]);
  });

  it('планка снизу отсекает слабых', () => {
    expect(checkEligibility(player, { ...NO_LIMITS, ratingCapMin: 400 })).toEqual([
      'RATING_TOO_LOW',
    ]);
  });

  it('возрастной диапазон работает с обеих сторон', () => {
    expect(checkEligibility(player, { ...NO_LIMITS, birthYearFrom: 2005 })).toEqual([
      'BIRTH_YEAR_OUT_OF_RANGE',
    ]);
    expect(checkEligibility(player, { ...NO_LIMITS, birthYearTo: 1995 })).toEqual([
      'BIRTH_YEAR_OUT_OF_RANGE',
    ]);
    expect(
      checkEligibility(player, { ...NO_LIMITS, birthYearFrom: 1995, birthYearTo: 2005 }),
    ).toEqual([]);
  });

  it('ограничение по полу', () => {
    expect(checkEligibility(player, { ...NO_LIMITS, genderLimit: 'FEMALE' })).toEqual([
      'GENDER_NOT_ALLOWED',
    ]);
    expect(checkEligibility(player, { ...NO_LIMITS, genderLimit: 'MALE' })).toEqual([]);
  });

  it('называются все причины сразу, а не первая', () => {
    // Иначе человек узнаёт о следующем препятствии только после того, как
    // разберётся с предыдущим.
    expect(
      checkEligibility(player, {
        ratingCapMax: 250,
        ratingCapMin: null,
        birthYearFrom: 2010,
        birthYearTo: null,
        genderLimit: 'FEMALE',
      }),
    ).toEqual(['RATING_TOO_HIGH', 'BIRTH_YEAR_OUT_OF_RANGE', 'GENDER_NOT_ALLOWED']);
  });
});
