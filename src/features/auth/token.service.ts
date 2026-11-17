import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { ENV, type Env } from '../../infra/config/env.js';
import { ACCESS_TOKEN_TTL_SECONDS } from './auth.constants.js';

/** Полезная нагрузка access-токена. Ролей здесь нет: они меняются чаще токена. */
export interface AccessTokenPayload {
  /** Идентификатор пользователя. Имя `sub` — общепринятое для субъекта токена. */
  readonly sub: string;
}

/**
 * Всё, что касается секретов аутентификации: выпуск токенов и хеширование
 * refresh-токенов.
 *
 * Вынесено из `AuthService` отдельно, потому что здесь легко ошибиться
 * незаметно. Сравнение хешей обычным `===` или код из `Math.random()` не
 * ломают ни один функциональный тест — они ломают безопасность молча.
 */
@Injectable()
export class TokenService {
  /**
   * Отозванные пользователи — ADR-092: id и момент, когда истекут их
   * последние access-токены. Токен проверяется без базы, и без этого
   * удалённый аккаунт работал бы ещё до 15 минут. В памяти, как и
   * `LoginThrottle`: API живёт одним процессом. После перезапуска токен
   * удалённого доходит лишь до маршрутов, где отсутствие пользователя даёт
   * 401 или 404.
   */
  private readonly revoked = new Map<string, number>();

  constructor(
    @Inject(ENV) _env: Env,
    private readonly jwt: JwtService,
  ) {}

  issueAccessToken(userId: string): string {
    return this.jwt.sign({ sub: userId } satisfies AccessTokenPayload, {
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    });
  }

  /** Возвращает идентификатор пользователя или `null`, если токен негоден. */
  /** Обрывает все выданные пользователю access-токены — ADR-092. */
  revokeUser(userId: string, now = Date.now()): void {
    for (const [id, until] of this.revoked) {
      if (until <= now) this.revoked.delete(id);
    }

    this.revoked.set(userId, now + ACCESS_TOKEN_TTL_SECONDS * 1000);
  }

  verifyAccessToken(token: string, now = Date.now()): string | null {
    try {
      const payload = this.jwt.verify<AccessTokenPayload>(token);
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null;

      const until = this.revoked.get(payload.sub);
      return until !== undefined && until > now ? null : payload.sub;
    } catch {
      // Истёк, подделан, обрезан — для вызывающего это один и тот же ответ.
      // Пустой catch запрещён брифом 3.5, поэтому исход возвращается явно.
      return null;
    }
  }

  /**
   * Refresh-токен: 256 бит случайности в hex.
   *
   * В отличие от access-токена это не JWT, а непрозрачная строка. Смысл в том,
   * что её можно отозвать: сессия живёт в базе, удаление строки прекращает
   * доступ немедленно.
   */
  generateRefreshToken(): string {
    return randomBytes(32).toString('hex');
  }

  /**
   * Хеш refresh-токена для хранения в `Session.refreshToken`.
   *
   * В колонке лежит хеш, а не сам токен: с ним, попади база в чужие руки,
   * входить было бы некуда. Ключ здесь не нужен — токен и так содержит 256 бит
   * случайности, перебирать нечего. Схема при этом не меняется: колонка как
   * была строкой с ограничением уникальности, так и осталась.
   */
  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
