import { createHmac } from 'node:crypto';

import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import { Inject, Injectable } from '@nestjs/common';

import { WindowCounter } from '../../common/rate-limit/window-counter.js';
import { ENV, type Env } from '../../infra/config/env.js';

const WINDOW_MS = 15 * 60 * 1000;

/**
 * Неудачных входов на один логин или телефон за окно.
 *
 * Десять — больше, чем человек ошибается, вспоминая пароль, и на порядки
 * меньше, чем нужно перебору. Цена — злоумышленник может на четверть часа
 * закрыть вход чужому логину; с одного адреса он упрётся во второй предел.
 */
export const LOGIN_FAILURES_PER_ACCOUNT = 10;

/** Неудачных входов с одного адреса за окно — по всем логинам сразу. */
export const LOGIN_FAILURES_PER_ADDRESS = 20;

/**
 * Защита входа от перебора — ТС 8.3, ADR-056.
 *
 * Считаются только неудачи: человек, который вошёл, предела не расходует.
 * Сверх предела вход отвергается сразу, пароль не сверяется — иначе отказ
 * по пределу и отказ по паролю различались бы, и перебор шёл бы дальше.
 * Успешный вход обнуляет счёт логина: хозяин, вспомнивший пароль, не ждёт
 * четверть часа из-за чужих попыток. Счёт адреса не обнуляется — иначе один
 * свой аккаунт открывал бы перебор чужих.
 */
@Injectable()
export class LoginThrottle {
  private readonly accounts = new WindowCounter(LOGIN_FAILURES_PER_ACCOUNT, WINDOW_MS);
  private readonly addresses = new WindowCounter(LOGIN_FAILURES_PER_ADDRESS, WINDOW_MS);

  constructor(@Inject(ENV) private readonly env: Env) {}

  assertAllowed(identifier: string, ip: string, now = Date.now()): void {
    const account = this.accounts.check(accountKey(identifier), now);
    const address = this.addresses.check(this.addressKey(ip), now);

    if (!account.allowed || !address.allowed) {
      throw new AppError(ERROR_CODES.RATE_LIMITED, 'Too many failed logins', {
        retryAfterSeconds: Math.ceil(Math.max(account.retryAfterMs, address.retryAfterMs) / 1000),
      });
    }
  }

  recordFailure(identifier: string, ip: string, now = Date.now()): void {
    this.accounts.hit(accountKey(identifier), now);
    this.addresses.hit(this.addressKey(ip), now);
  }

  recordSuccess(identifier: string): void {
    this.accounts.reset(accountKey(identifier));
  }

  /** Адрес — HMAC, а не сам адрес: даже в памяти это персональные данные (ADR-047). */
  private addressKey(ip: string): string {
    return createHmac('sha256', this.env.JWT_SECRET).update(ip).digest('base64url');
  }
}

/** Логин без регистра и пробелов по краям: «Owner» и «owner » — одна цель перебора. */
function accountKey(identifier: string): string {
  return identifier.trim().toLowerCase();
}
