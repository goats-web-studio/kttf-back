import { randomBytes } from 'node:crypto';

import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import { PHONE_PATTERN } from '@kttf/shared/types';
import type {
  AuthSession,
  AuthUserView,
  ChangePasswordInput,
  LoginInput,
  SignUpInput,
  TokenPair,
  UpdateAccountInput,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { SESSION_TTL_MS } from './auth.constants.js';
import { hashPassword, verifyPassword } from './password.js';
import { TokenService } from './token.service.js';

/**
 * Хеш, с которым сверяется пароль несуществующего пользователя.
 *
 * Считается один раз при загрузке модуля: сверка обязана занимать одинаковое
 * время и для знакомого логина, и для незнакомого, иначе перебор находит
 * существующие аккаунты по времени ответа.
 */
const DUMMY_HASH = hashPassword(randomBytes(32).toString('hex'));

/** Пользователь с тем, что нужно для ответа. Форма выборки в одном месте. */
const userView = {
  player: { select: { id: true } },
  clubRoles: { select: { clubId: true, role: true } },
} as const;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  /**
   * Вход — ТЗ 2.1, ADR-034.
   *
   * Логин или телефон одним полем: телефон узнаётся по формату, всё
   * остальное считается логином. Отказ один на оба случая — «неизвестный
   * логин» и «неверный пароль» обязаны выглядеть одинаково, иначе форма
   * входа превращается в проверку, есть ли такой человек на платформе.
   */
  async login(input: LoginInput, userAgent?: string): Promise<AuthSession> {
    const identifier = input.identifier.trim();
    const where = PHONE_PATTERN.test(identifier) ? { phone: identifier } : { login: identifier };

    const account = await this.prisma.user.findUnique({ where, include: userView });

    // Пароль сверяется всегда, даже когда пользователя нет: иначе ответ
    // приходит заметно быстрее для незнакомого логина, и перебор находит
    // существующие аккаунты по времени ответа.
    const stored = account?.passwordHash ?? DUMMY_HASH;
    const matches = verifyPassword(input.password, stored);

    if (account?.passwordHash == null || !matches) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Login or password is wrong');
    }

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

    if (input.playerId !== undefined) {
      const player = await this.prisma.player.findUnique({
        where: { id: input.playerId },
        select: { userId: true },
      });

      if (player === null) {
        throw new AppError(ERROR_CODES.NOT_FOUND, 'Player not found', { id: input.playerId });
      }

      if (player.userId !== null) {
        // Чужая история: у этого игрока кабинет уже есть.
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Player already has an account', {
          field: 'playerId',
        });
      }
    }

    const refreshToken = this.tokens.generateRefreshToken();
    const passwordHash = hashPassword(input.password);

    const account = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { phone: input.phone, login: input.login, passwordHash },
        include: userView,
      });

      if (input.playerId !== undefined) {
        // Привязка условием на пустоту: между проверкой выше и этой строкой
        // тем же игроком мог назваться кто-то ещё.
        const linked = await tx.player.updateMany({
          where: { id: input.playerId, userId: null },
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
   */
  async refresh(refreshToken: string, userAgent?: string): Promise<TokenPair> {
    const session = await this.prisma.session.findUnique({
      where: { refreshToken: this.tokens.hashRefreshToken(refreshToken) },
    });

    if (session === null || session.expiresAt <= new Date()) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Session not found or expired');
    }

    const next = this.tokens.generateRefreshToken();

    await this.prisma.session.update({
      where: { id: session.id },
      data: {
        refreshToken: this.tokens.hashRefreshToken(next),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        ...(userAgent === undefined ? {} : { userAgent }),
      },
    });

    return { accessToken: this.tokens.issueAccessToken(session.userId), refreshToken: next };
  }

  /**
   * Выход. Молчит, если сессии уже нет: повторный выход и выход по чужому
   * токену обязаны выглядеть одинаково, иначе эндпоинт сообщает, существует
   * ли сессия.
   */
  async logout(refreshToken: string): Promise<void> {
    await this.prisma.session.deleteMany({
      where: { refreshToken: this.tokens.hashRefreshToken(refreshToken) },
    });
  }

  async findUser(userId: string): Promise<AuthUserView> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: userView });

    if (user === null) {
      // Токен подписан нами, но пользователя нет: аккаунт удалён, пока токен
      // был действителен.
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'User no longer exists');
    }

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

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
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
}

interface UserRecord {
  id: string;
  phone: string;
  login: string | null;
  passwordHash?: string | null;
  email: string | null;
  locale: string;
  telegramId: string | null;
  createdAt: Date;
  player: { id: string } | null;
  clubRoles: { clubId: string; role: string }[];
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
  };
}
