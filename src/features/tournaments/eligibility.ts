/**
 * Допуск игрока на турнир — ТЗ 4.3, шаг 2.
 *
 * Чистая функция: правила допуска нужны и серверу при записи, и интерфейсу,
 * чтобы объяснить человеку отказ до нажатия. Ни базы, ни Prisma здесь нет.
 *
 * Рейтинг приходит числом, а не строкой: сравнение с планкой — единственное,
 * что с ним здесь делают, и результат сравнения от последнего знака после
 * запятой не зависит. Хранение и передача остаются десятичными (ADR-014).
 */

export type EligibilityProblem =
  'RATING_TOO_HIGH' | 'RATING_TOO_LOW' | 'BIRTH_YEAR_OUT_OF_RANGE' | 'GENDER_NOT_ALLOWED';

export interface EligibilityLimits {
  readonly ratingCapMax: number | null;
  readonly ratingCapMin: number | null;
  readonly birthYearFrom: number | null;
  readonly birthYearTo: number | null;
  readonly genderLimit: string | null;
}

export interface EligibilityCandidate {
  readonly rating: number;
  readonly birthYear: number;
  readonly gender: string;
}

/**
 * Все причины отказа сразу, а не первая попавшаяся.
 *
 * Показывать их по одной означает заставить человека узнавать о следующем
 * препятствии только после того, как он разберётся с предыдущим.
 */
export function checkEligibility(
  candidate: EligibilityCandidate,
  limits: EligibilityLimits,
): EligibilityProblem[] {
  const problems: EligibilityProblem[] = [];

  // ТЗ 4.2: «допускаются игроки с рейтингом ниже значения». Планка сверху
  // отсекает сильных, снизу — слабых; равенство планке допускается.
  if (limits.ratingCapMax !== null && candidate.rating > limits.ratingCapMax) {
    problems.push('RATING_TOO_HIGH');
  }

  if (limits.ratingCapMin !== null && candidate.rating < limits.ratingCapMin) {
    problems.push('RATING_TOO_LOW');
  }

  const tooOld = limits.birthYearFrom !== null && candidate.birthYear < limits.birthYearFrom;
  const tooYoung = limits.birthYearTo !== null && candidate.birthYear > limits.birthYearTo;

  if (tooOld || tooYoung) {
    problems.push('BIRTH_YEAR_OUT_OF_RANGE');
  }

  if (limits.genderLimit !== null && candidate.gender !== limits.genderLimit) {
    problems.push('GENDER_NOT_ALLOWED');
  }

  return problems;
}
