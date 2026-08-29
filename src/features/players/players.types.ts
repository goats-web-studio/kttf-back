/** Игрок в ответах API. Состав — ТЗ 2.2 в пределах модели `Player`. */
export interface PlayerView {
  readonly id: string;
  /** `null` — заведён организатором, аккаунта нет. */
  readonly userId: string | null;
  readonly lastName: string;
  readonly firstName: string;
  readonly middleName: string | null;
  readonly birthYear: number;
  readonly gender: string;
  readonly city: string;
  readonly photoUrl: string | null;
  readonly clubId: string | null;
  /**
   * Рейтинг строкой, а не числом.
   *
   * В базе это `Decimal(8,2)`. Число с плавающей точкой хранит не все такие
   * значения точно, и разница вылезет при сравнении локального расчёта
   * консоли с серверным — ровно то, что запрещает бриф, запрет №2.
   */
  readonly rating: string;
  readonly ratedMatches: number;
  readonly isProvisional: boolean;
  readonly createdAt: string;
}
