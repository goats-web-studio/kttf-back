import { createHmac } from 'node:crypto';

import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Observable } from 'rxjs';

import { clientIp } from '../../common/client-ip.js';
import { WindowCounter } from '../../common/rate-limit/window-counter.js';
import { ENV, type Env } from '../../infra/config/env.js';
import { TokenService } from './token.service.js';

/** ТС 8.3: сто запросов в минуту на пользователя. */
export const REQUESTS_PER_USER = 100;

/**
 * Без входа предел — на адрес, и он шире: в зале весь турнир сидит за одним
 * Wi-Fi, и три десятка игроков, листающих таблицы, — один адрес.
 */
export const REQUESTS_PER_ADDRESS = 600;

const MINUTE_MS = 60_000;

const SKIP = 'kttf:skip-rate-limit';

/**
 * Маршрут вне общего предела: картинки (страница клуба тянет их десятками,
 * и они неизменяемы), поток экрана зала, проверка здоровья.
 */
export const SkipRateLimit = (): MethodDecorator & ClassDecorator => SetMetadata(SKIP, true);

/**
 * Общий предел запросов — ТС 8.3, ADR-056.
 *
 * Пользователь узнаётся по токену прямо здесь, а не по guard'у маршрута:
 * публичные маршруты guard'а не имеют, и вошедший человек на них иначе
 * считался бы по адресу вместе со всем залом. Подпись токена проверяется
 * той же функцией, что в guard'ах, — это HMAC, без запроса к базе.
 */
@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  private readonly users = new WindowCounter(REQUESTS_PER_USER, MINUTE_MS);
  private readonly addresses = new WindowCounter(REQUESTS_PER_ADDRESS, MINUTE_MS);

  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const skip = this.reflector.getAllAndOverride<boolean | undefined>(SKIP, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (skip === true) return next.handle();

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    const bearer = typeof header === 'string' ? /^Bearer (.+)$/.exec(header)?.[1] : undefined;
    const userId = bearer === undefined ? null : this.tokens.verifyAccessToken(bearer);
    const now = Date.now();

    const verdict =
      userId === null
        ? this.addresses.hit(this.addressKey(clientIp(request)), now)
        : this.users.hit(userId, now);

    if (!verdict.allowed) {
      throw new AppError(ERROR_CODES.RATE_LIMITED, 'Too many requests', {
        retryAfterSeconds: Math.ceil(verdict.retryAfterMs / 1000),
      });
    }

    return next.handle();
  }

  private addressKey(ip: string): string {
    return createHmac('sha256', this.env.JWT_SECRET).update(ip).digest('base64url');
  }
}
