/** Роль в клубе, как она лежит в `ClubMember`. */
export interface ClubRoleView {
  readonly clubId: string;
  readonly role: string;
}

/**
 * Пользователь в ответах аутентификации.
 *
 * Состав ТС 7.1 не задаёт, поэтому здесь только то, что нужно клиенту сразу
 * после входа: кто вошёл, есть ли у него профиль игрока и что он может делать
 * в клубах. Рейтинг и остальной профиль берутся отдельным запросом к 7.2 —
 * они меняются независимо от сессии, и класть их сюда значило бы отдавать
 * устаревшие данные при каждом обновлении токена.
 */
export interface AuthUserView {
  readonly id: string;
  readonly phone: string;
  readonly email: string | null;
  readonly locale: string;
  readonly createdAt: string;
  /** `null`, пока профиль игрока не заведён — ТЗ 2.2 заполняется отдельно. */
  readonly playerId: string | null;
  readonly clubRoles: readonly ClubRoleView[];
}

export interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
}

export interface AuthSession extends TokenPair {
  readonly user: AuthUserView;
}
