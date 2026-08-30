import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import type { AuthSession, AuthUserView, TokenPair } from '@kttf/shared/types';
import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service.js';
import {
  CODE_MAX_ATTEMPTS,
  CODE_RATE_WINDOW_MS,
  CODE_REQUESTS_PER_HOUR,
  CODE_TTL_MS,
  SESSION_TTL_MS,
} from './auth.constants.js';
import { CODE_SENDER, type CodeSender } from './code-sender.js';
import { TokenService } from './token.service.js';

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
    @Inject(CODE_SENDER) private readonly sender: CodeSender,
  ) {}

  /**
   * Запрос кода.
   *
   * Ответ одинаков и для существующего номера, и для незнакомого: иначе
   * эндпоинт превращается в проверку «есть ли такой человек на платформе».
   */
  async requestCode(phone: string): Promise<{ expiresInSeconds: number }> {
    const since = new Date(Date.now() - CODE_RATE_WINDOW_MS);
    const recent = await this.prisma.authCode.count({ where: { phone, createdAt: { gt: since } } });

    if (recent >= CODE_REQUESTS_PER_HOUR) {
      throw new AppError(ERROR_CODES.RATE_LIMITED, 'Too many code requests for this phone', {
        retryAfterSeconds: Math.ceil(CODE_RATE_WINDOW_MS / 1000),
      });
    }

    const code = this.tokens.generateCode();

    await this.prisma.authCode.create({
      data: {
        phone,
        codeHash: this.tokens.hashCode(code),
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
    });

    await this.sender.send(phone, code);

    return { expiresInSeconds: Math.floor(CODE_TTL_MS / 1000) };
  }

  /**
   * Проверка кода и вход.
   *
   * Первый успешный вход заводит аккаунт: в контракте ТС 7.1 нет отдельной
   * регистрации, а ТЗ 2.1 не знает пароля — «повторный вход снова по коду».
   * Профиль игрока (ТЗ 2.2) при этом не создаётся: он заполняется отдельно и
   * до тех пор `playerId` пуст.
   */
  async verifyCode(phone: string, code: string, userAgent?: string): Promise<AuthSession> {
    const candidate = await this.prisma.authCode.findFirst({
      where: { phone, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });

    if (candidate === null) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Code not found or expired');
    }

    if (candidate.attempts >= CODE_MAX_ATTEMPTS) {
      throw new AppError(ERROR_CODES.RATE_LIMITED, 'Too many attempts for this code');
    }

    if (!this.tokens.matchesCode(code, candidate.codeHash)) {
      await this.prisma.authCode.update({
        where: { id: candidate.id },
        data: { attempts: { increment: 1 } },
      });

      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Code does not match');
    }

    const refreshToken = this.tokens.generateRefreshToken();

    // Одной транзакцией: код обязан погаситься ровно тогда, когда появилась
    // сессия. Иначе отказ посередине оставляет либо использованный код без
    // входа, либо действующий код после входа.
    const user = await this.prisma.$transaction(async (tx) => {
      await tx.authCode.update({ where: { id: candidate.id }, data: { usedAt: new Date() } });

      const account = await tx.user.upsert({
        where: { phone },
        create: { phone, phoneVerified: true },
        update: { phoneVerified: true },
        include: userView,
      });

      await tx.session.create({
        data: {
          userId: account.id,
          refreshToken: this.tokens.hashRefreshToken(refreshToken),
          expiresAt: new Date(Date.now() + SESSION_TTL_MS),
          ...(userAgent === undefined ? {} : { userAgent }),
        },
      });

      return account;
    });

    return {
      accessToken: this.tokens.issueAccessToken(user.id),
      refreshToken,
      user: toView(user),
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
}

interface UserRecord {
  id: string;
  phone: string;
  email: string | null;
  locale: string;
  createdAt: Date;
  player: { id: string } | null;
  clubRoles: { clubId: string; role: string }[];
}

function toView(user: UserRecord): AuthUserView {
  return {
    id: user.id,
    phone: user.phone,
    email: user.email,
    locale: user.locale,
    createdAt: user.createdAt.toISOString(),
    playerId: user.player?.id ?? null,
    clubRoles: user.clubRoles.map((member) => ({ clubId: member.clubId, role: member.role })),
  };
}
