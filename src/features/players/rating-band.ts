/**
 * Рейтинг «от» и «до» по числу на экране — ADR-054.
 *
 * Рейтинг показывается целым до ближайшего (ADR-053), поэтому «до 384»
 * обязано найти и 384.10, а «от 385» — 384.50. Граница сдвигается на
 * половину: показанное n — это [n − 0.5; n + 0.5).
 *
 * Одно правило на список игроков и на «Выбор игроков» маркета (ADR-058):
 * «чем играют 400+» обязано считать ровно тех, кого покажет список «от 400».
 */
export interface RatingBounds {
  readonly gte?: number;
  readonly lt?: number;
}

export function ratingBounds(from: number | undefined, to: number | undefined): RatingBounds {
  return {
    ...(from === undefined ? {} : { gte: from - 0.5 }),
    ...(to === undefined ? {} : { lt: to + 0.5 }),
  };
}
