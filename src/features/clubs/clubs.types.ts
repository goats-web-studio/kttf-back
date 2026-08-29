/** Клуб в ответах API. Состав полей — ТЗ 3.1 в пределах модели `Club`. */
export interface ClubView {
  readonly id: string;
  readonly name: string;
  readonly shortName: string | null;
  readonly city: string;
  readonly address: string | null;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly tableCount: number;
  readonly phone: string | null;
  readonly whatsapp: string | null;
  readonly instagram: string | null;
  readonly logoUrl: string | null;
  readonly description: string | null;
  readonly createdAt: string;
}

/** Участник состава клуба — ТЗ 3.2. */
export interface ClubMemberView {
  readonly userId: string;
  readonly role: string;
  readonly playerId: string | null;
  /** `null`, пока профиль игрока не заполнен. */
  readonly name: string | null;
}
