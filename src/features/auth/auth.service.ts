import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import { PHONE_PATTERN, PRIVACY_POLICY_VERSION } from '@kttf/shared/types';
import type {
  AuthSession,
  AuthUserView,
  ChangePasswordInput,
  CoachRef,
  LoginInput,
  SignUpInput,
  TokenPair,
  UpdateAccountInput,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { REFRESH_REUSE_WINDOW_MS, SESSION_TTL_MS } from './auth.constants.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from './password.js';
import { LoginThrottle } from './login-throttle.js';
import { isDeletedPlayer } from '../players/deleted-player.js';
import { cityRefFields } from '../places/place.fields.js';
import { TokenService } from './token.service.js';

/** Пользователь с тем, что нужно для ответа. Форма выборки в одном месте. */
const userView = {
  player: { select: { id: true } },
  city: { select: cityRefFields },
  clubRoles: { select: { clubId: true, role: true } },
  // Своя страница тренера — ADR-059. Одна на профиль игрока, а профиль один
  // на аккаунт; порядок — на случай, если ссылок окажется больше.
  coaches: {
    select: { id: true, slug: true, status: true },
    orderBy: { createdAt: 'asc' },
    take: 1,
  },
} as const;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly throttle: LoginThrottle,
  ) {}

  /**
   * Вход — ТЗ 2.1, ADR-034.
   *
   * Логин или телефон одним полем: телефон узнаётся по формату, всё
   * остальное считается логином. Отказ один на оба случая — «неизвестный
   * логин» и «неверный пароль» обязаны выглядеть одинаково, иначе форма
   * входа превращается в проверку, есть ли такой человек на платформе.
   */
  async login(input: LoginInput, ip: string, userAgent?: string): Promise<AuthSession> {
    const identifier = input.identifier.trim();

    // До поиска и сверки: сверх предела отказ одинаков для любого пароля.
    this.throttle.assertAllowed(identifier, ip);

    const where = PHONE_PATTERN.test(identifier) ? { phone: identifier } : { login: identifier };

    const account = await this.prisma.user.findUnique({ where, include: userView });

    // Пароль сверяется всегда, даже когда пользователя нет: иначе ответ
    // приходит заметно быстрее для незнакомого логина, и перебор находит
    // существующие аккаунты по времени ответа.
    const stored = account?.passwordHash ?? DUMMY_HASH;
    const matches = verifyPassword(input.password, stored);

    if (account?.passwordHash == null || !matches) {
      this.throttle.recordFailure(identifier, ip);
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Login or password is wrong');
    }

    this.throttle.recordSuccess(identifier);

    // Блокировка — после сверки пароля (ADR-103): иначе отказ с причиной
    // выдал бы перебирающему, что такой аккаунт есть, без знания пароля.
    assertNotBlocked(account);

    return this.startSession(account, userAgent);
  }

  /**
   * Регистрация — ТЗ 2.1, ADR-034.
   *
   * Игроков заводит тренер, поэтому человек, придя сам, выбирает себя из
   * тех, у кого ещё нет кабинета, и привязывается к своей истории. Без
   * выбора аккаунт тоже заводится: у судьи и организатора профиля игрока
   * может не быть вовсе.
   */
  async signUp(input: SignUpInput, userAgent?: string): Promise<AuthSession> {
    const taken = await this.prisma.user.findFirst({
      where: { OR: [{ phone: input.phone }, { login: input.login }] },
      select: { phone: true, login: true },
    });

    if (taken !== null) {
      // Занятый телефон и занятый логин различаются: это не секрет, а
      // единственный способ объяснить человеку, что делать дальше.
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Phone or login already taken', {
        field: taken.phone === input.phone ? 'phone' : 'login',
      });
    }

    await this.assertCityAvailable(input.cityId);

    // Город не выбран гостем — берётся из профиля, к которому привязываются
    // (ADR-093): человек из него и играет.
    let cityId = input.cityId;

    if (input.playerId !== undefined) {
      const player = await this.prisma.player.findUnique({
        where: { id: input.playerId },
        select: { userId: true, confirmedAt: true, deletedAt: true, cityId: true },
      });

      // Удалённый игрок (ADR-092) — чужая спортивная история без хозяина:
      // привязаться к ней значило бы присвоить себе человека, которого нет.
      if (player === null || isDeletedPlayer(player)) {
        throw new AppError(ERROR_CODES.NOT_FOUND, 'Player not found', { id: input.playerId });
      }

      // Привязываются к игровому профилю, который завёл организатор (ADR-072).
      // Чужая анкета без рейтинга — не история, к которой стоит привязаться.
      if (player.confirmedAt === null) {
        throw new AppError(ERROR_CODES.PLAYER_CLAIM_INVALID, 'Player is not confirmed', {
          reason: 'NOT_CONFIRMED',
        });
      }

      if (player.userId !== null) {
        // Чужая история: у этого игрока кабинет уже есть.
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Player already has an account', {
          field: 'playerId',
        });
      }

      cityId ??= player.cityId;
    }

    const refreshToken = this.tokens.generateRefreshToken();
    const passwordHash = hashPassword(input.password);

    const account = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          phone: input.phone,
          login: input.login,
          passwordHash,
          // Согласие — ADR-091: схема пропускает только `consent: true`, а
          // редакцию пишет сервер, ссылки на сайте всегда ведут на неё.
          privacyConsentAt: new Date(),
          privacyConsentVersion: PRIVACY_POLICY_VERSION,
          ...(cityId === undefined ? {} : { cityId }),
        },
        include: userView,
      });

      if (input.playerId !== undefined) {
        // Привязка условием на пустоту: между проверкой выше и этой строкой
        // тем же игроком мог назваться кто-то ещё.
        const linked = await tx.player.updateMany({
          where: { id: input.playerId, userId: null, confirmedAt: { not: null }, deletedAt: null },
          data: { userId: created.id },
        });

        if (linked.count === 0) {
          throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Player already has an account', {
            field: 'playerId',
          });
        }
      }

      await tx.session.create({
        data: {
          userId: created.id,
          refreshToken: this.tokens.hashRefreshToken(refreshToken),
          expiresAt: new Date(Date.now() + SESSION_TTL_MS),
          ...(userAgent === undefined ? {} : { userAgent }),
        },
      });

      return created;
    });

    return {
      accessToken: this.tokens.issueAccessToken(account.id),
      refreshToken,
      // Профиль игрока привязан в той же транзакции, а `account` прочитан до
      // неё: перечитывать целиком незачем, известно ровно чего не хватает.
      user: { ...toView(account), playerId: input.playerId ?? null },
    };
  }

  /** Общее окончание входа: сессия в базе и пара токенов наружу. */
  private async startSession(
    account: UserRecord & { id: string },
    userAgent?: string,
  ): Promise<AuthSession> {
    const refreshToken = this.tokens.generateRefreshToken();

    await this.prisma.session.create({
      data: {
        userId: account.id,
        refreshToken: this.tokens.hashRefreshToken(refreshToken),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        ...(userAgent === undefined ? {} : { userAgent }),
      },
    });

    return {
      accessToken: this.tokens.issueAccessToken(account.id),
      refreshToken,
      user: toView(account),
    };
  }

  /**
   * Продление сессии.
   *
   * Refresh-токен заменяется на новый — ТЗ 2.1 требует продления при
   * активности, а заодно украденный токен перестаёт работать после первого же
   * обновления настоящим владельцем.
   *
   * Прежний токен ещё минуту даёт тот же новый (ADR-109): ответ на обновление
   * теряется, когда вкладку перезагружают, пока он в пути, — и без этого
   * человек оказывался не вошедшим после пары быстрых перезагрузок.
   */
  async refresh(refreshToken: string, userAgent?: string): Promise<TokenPair> {
    const hash = this.tokens.hashRefreshToken(refreshToken);
    const now = new Date();
    const session = await this.prisma.session.findFirst({
      where: {
        OR: [
          { refreshToken: hash },
          {
            previousRefreshToken: hash,
            rotatedAt: { gt: new Date(now.getTime() - REFRESH_REUSE_WINDOW_MS) },
          },
        ],
      },
    });

    if (session === null || session.expiresAt <= now) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Session not found or expired');
    }

    // Блокировка закрывает сессии сразу (ADR-103), но проверка здесь тоже
    // нужна: сессия, открытая между чтением и блокировкой, не продлится.
    assertNotBlocked(
      await this.prisma.user.findUnique({
        where: { id: session.userId },
        select: { blockedAt: true, blockedReason: true },
      }),
    );

    const next = this.tokens.successorRefreshToken(refreshToken);

    // Пришёл прежний токен: его замена уже записана, и `next` — тот самый
    // токен, что лежит в сессии. Запись не трогается — иначе прежний токен
    // продлевал бы своё окно бесконечно.
    if (session.refreshToken === hash) {
      // Два одновременных обновления одним токеном пишут одно и то же.
      await this.prisma.session.update({
        where: { id: session.id },
        data: {
          refreshToken: this.tokens.hashRefreshToken(next),
          previousRefreshToken: hash,
          rotatedAt: now,
          expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
          ...(userAgent === undefined ? {} : { userAgent }),
        },
      });
    }

    return { accessToken: this.tokens.issueAccessToken(session.userId), refreshToken: next };
  }

  /**
   * Выход. Молчит, если сессии уже нет: повторный выход и выход по чужому
   * токену обязаны выглядеть одинаково, иначе эндпоинт сообщает, существует
   * ли сессия.
   *
   * Прежний токен тоже закрывает сессию: вкладка, не получившая новый, иначе
   * не смогла бы выйти на сервере (ADR-109).
   */
  async logout(refreshToken: string): Promise<void> {
    const hash = this.tokens.hashRefreshToken(refreshToken);

    await this.prisma.session.deleteMany({
      where: { OR: [{ refreshToken: hash }, { previousRefreshToken: hash }] },
    });
  }

  async findUser(userId: string): Promise<AuthUserView> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: userView });

    if (user === null) {
      // Токен подписан нами, но пользователя нет: аккаунт удалён, пока токен
      // был действителен.
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'User no longer exists');
    }

    // Кабинет с ещё живым access-токеном узнаёт о блокировке сразу, а не
    // через 15 минут, когда токен истечёт (ADR-103).
    assertNotBlocked(user);

    return toView(user);
  }

  /**
   * Настройки аккаунта — ТЗ 2.1, ADR-035.
   *
   * Здесь меняется то, чем человек входит и как с ним связаться. Спортивная
   * анкета живёт отдельно, в профиле игрока: у судьи есть аккаунт без
   * профиля, у заведённого тренером игрока — профиль без аккаунта.
   *
   * Телефона тут нет намеренно: по ТЗ 2.1 «один телефон — один аккаунт», и
   * смена номера означала бы подтверждение владения новым, которого без
   * провайдера SMS взять неоткуда (ADR-034).
   */
  async updateAccount(userId: string, input: UpdateAccountInput): Promise<AuthUserView> {
    const conflicts: { login?: string; email?: string }[] = [];

    if (input.login !== undefined) conflicts.push({ login: input.login });
    if (input.email !== undefined && input.email !== null) conflicts.push({ email: input.email });

    if (conflicts.length > 0) {
      const taken = await this.prisma.user.findFirst({
        where: { OR: conflicts, NOT: { id: userId } },
        select: { login: true, email: true },
      });

      if (taken !== null) {
        // Различать занятый логин и занятую почту — не утечка, а
        // единственный способ объяснить человеку, что менять.
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Login or email already taken', {
          field: taken.login === input.login ? 'login' : 'email',
        });
      }
    }

    if (input.cityId !== undefined && input.cityId !== null) {
      const current = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { cityId: true },
      });
      await this.assertCityAvailable(input.cityId, current?.cityId ?? undefined);
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(input.cityId === undefined ? {} : { cityId: input.cityId }),
        ...(input.login === undefined ? {} : { login: input.login }),
        ...(input.email === undefined ? {} : { email: input.email }),
        ...(input.locale === undefined ? {} : { locale: input.locale }),
        ...(input.telegramId === undefined ? {} : { telegramId: input.telegramId }),
      },
      include: userView,
    });

    return toView(user);
  }

  /**
   * Смена пароля — ТЗ 2.1.
   *
   * Текущий пароль обязателен, даже когда человек уже вошёл: иначе доступ к
   * открытой вкладке означает возможность отобрать аккаунт у владельца.
   *
   * Остальные сессии обрываются: смену пароля затевают в том числе потому,
   * что старый узнали чужие, и оставить их сессии живыми значило бы не
   * сделать ничего. Взамен выдаётся новая пара токенов — вкладка, из которой
   * пароль сменили, остаётся рабочей, а не выбрасывает человека на вход.
   */
  async changePassword(
    userId: string,
    input: ChangePasswordInput,
    userAgent?: string,
  ): Promise<TokenPair> {
    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, passwordHash: true },
    });

    if (
      account?.passwordHash == null ||
      !verifyPassword(input.currentPassword, account.passwordHash)
    ) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Current password is wrong');
    }

    const refreshToken = this.tokens.generateRefreshToken();

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash: hashPassword(input.newPassword) },
      });

      await tx.session.deleteMany({ where: { userId } });

      await tx.session.create({
        data: {
          userId,
          refreshToken: this.tokens.hashRefreshToken(refreshToken),
          expiresAt: new Date(Date.now() + SESSION_TTL_MS),
          ...(userAgent === undefined ? {} : { userAgent }),
        },
      });
    });

    return { accessToken: this.tokens.issueAccessToken(userId), refreshToken };
  }

  /**
   * Город можно сделать своим — то же правило, что у `PlacesService`.
   *
   * Повторено, а не взято оттуда: модуль мест сам зависит от модуля входа
   * (охрана администратора), и обратная ссылка замкнула бы их в круг.
   */
  private async assertCityAvailable(cityId: string | undefined, current?: string): Promise<void> {
    if (cityId === undefined || cityId === current) return;

    const city = await this.prisma.city.findFirst({
      where: { id: cityId, isActive: true, country: { isActive: true } },
      select: { id: true },
    });

    if (city === null) {
      throw new AppError(ERROR_CODES.CITY_UNAVAILABLE, 'City is unknown or hidden', { cityId });
    }
  }
}

/**
 * Заблокированный аккаунт — ADR-103. Причину человек видит: без неё он не
 * поймёт, к кому идти. Нет полей — не заблокирован: у выборок, которые их
 * не просили, блокировки быть не может.
 */
function assertNotBlocked(
  user: { blockedAt?: Date | null; blockedReason?: string | null } | null,
): void {
  if (user?.blockedAt instanceof Date) {
    throw new AppError(ERROR_CODES.ACCOUNT_BLOCKED, 'Account is blocked', {
      reason: user.blockedReason ?? null,
    });
  }
}

interface UserRecord {
  id: string;
  phone: string;
  login: string | null;
  passwordHash?: string | null;
  email: string | null;
  locale: string;
  telegramId: string | null;
  isAdmin: boolean;
  createdAt: Date;
  privacyConsentAt: Date | null;
  privacyConsentVersion: string | null;
  player: { id: string } | null;
  city: { id: string; name: string; nameKk: string | null } | null;
  clubRoles: { clubId: string; role: string }[];
  coaches: CoachRef[];
}

function toView(user: UserRecord): AuthUserView {
  return {
    id: user.id,
    phone: user.phone,
    login: user.login,
    email: user.email,
    locale: user.locale,
    telegramId: user.telegramId,
    createdAt: user.createdAt.toISOString(),
    playerId: user.player?.id ?? null,
    clubRoles: user.clubRoles.map((member) => ({ clubId: member.clubId, role: member.role })),
    isAdmin: user.isAdmin,
    coach: user.coaches[0] ?? null,
    privacyConsentAt: user.privacyConsentAt?.toISOString() ?? null,
    privacyConsentVersion: user.privacyConsentVersion,
    city: user.city,
  };
}
