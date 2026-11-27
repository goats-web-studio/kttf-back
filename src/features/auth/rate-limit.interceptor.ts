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

/**
 * ТС 8.3, ADR-110: шестьсот запросов в минуту на пользователя — как на адрес.
 * Сто кончались за четыре перезагрузки главной: она одна шлёт два десятка
 * запросов (DEV-66).
 */
export const REQUESTS_PER_USER = 600;

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
 * Загрузок картинок за час на пользователя — ADR-131.
 *
 * Каждая загрузка — разбор и пережатие sharp в общем пуле потоков (ADR-129),
 * поэтому у них свой предел внутри общего. Сто в час — с запасом на
 * владельца клуба, заполняющего галерею, и на запись с несколькими фото.
 */
export const UPLOADS_PER_USER = 100;

/**
 * Загрузок картинок за час с одного адреса — по всем аккаунтам сразу: иначе
 * пачка свежих аккаунтов обходила бы предел пользователя. Втрое шире, чтобы
 * несколько сотрудников клуба за одним Wi-Fi не мешали друг другу.
 */
export const UPLOADS_PER_ADDRESS = 300;

const HOUR_MS = 60 * MINUTE_MS;

const UPLOAD = 'kttf:upload';

/**
 * Маршрут, где сервер принимает или сам скачивает картинку и пережимает её:
 * считается и в общем пределе, и в пределе загрузок (ADR-131). Перехватчик
 * общий и стоит раньше `FileInterceptor`, поэтому отказ приходит до того,
 * как multer прочитает файл.
 */
export const CountsAsUpload = (): MethodDecorator => SetMetadata(UPLOAD, true);

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
  private readonly uploadsByUser = new WindowCounter(UPLOADS_PER_USER, HOUR_MS);
  private readonly uploadsByAddress = new WindowCounter(UPLOADS_PER_ADDRESS, HOUR_MS);

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

    const upload = this.reflector.getAllAndOverride<boolean | undefined>(UPLOAD, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (upload === true) this.countUpload(userId, clientIp(request), now);

    return next.handle();
  }

  /** Загрузка засчитывается и пользователю, и адресу; отказ — по любому из пределов. */
  private countUpload(userId: string | null, ip: string, now: number): void {
    const byAddress = this.uploadsByAddress.hit(this.addressKey(ip), now);
    // Без входа загрузку отвергнет guard маршрута ещё до перехватчика;
    // здесь пользователь есть всегда, а проверка — на всякий случай.
    const byUser =
      userId === null ? { allowed: true, retryAfterMs: 0 } : this.uploadsByUser.hit(userId, now);

    if (!byAddress.allowed || !byUser.allowed) {
      throw new AppError(ERROR_CODES.RATE_LIMITED, 'Too many uploads', {
        retryAfterSeconds: Math.ceil(Math.max(byAddress.retryAfterMs, byUser.retryAfterMs) / 1000),
      });
    }
  }

  private addressKey(ip: string): string {
    return createHmac('sha256', this.env.JWT_SECRET).update(ip).digest('base64url');
  }
}
