import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../infra/config/env.js';
import {
  REQUESTS_PER_ADDRESS,
  REQUESTS_PER_USER,
  RateLimitInterceptor,
  UPLOADS_PER_ADDRESS,
  UPLOADS_PER_USER,
} from './rate-limit.interceptor.js';
import type { TokenService } from './token.service.js';

const next: CallHandler = { handle: () => of('ok') };

function contextOf(headers: Record<string, string>, ip = '1.2.3.4'): ExecutionContext {
  const request = { headers, socket: { remoteAddress: ip } };

  return {
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => Object,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

let skip: boolean | undefined;
let upload: boolean | undefined;
let interceptor: RateLimitInterceptor;

beforeEach(() => {
  skip = undefined;
  upload = undefined;
  const reflector = {
    getAllAndOverride: vi.fn((key: string) => (key === 'kttf:upload' ? upload : skip)),
  } as unknown as Reflector;
  const tokens = {
    // «good» — один и тот же человек; «user-N» — разные аккаунты.
    verifyAccessToken: vi.fn((token: string) =>
      token === 'good' ? 'user-1' : token.startsWith('user-') ? token : null,
    ),
  } as unknown as TokenService;
  interceptor = new RateLimitInterceptor(reflector, tokens, { JWT_SECRET: 'x'.repeat(32) } as Env);
});

describe('общий предел запросов — ТС 8.3', () => {
  it('вошедшему — сто в минуту, сто первый отвергается', () => {
    const context = contextOf({ authorization: 'Bearer good' });

    for (let index = 0; index < REQUESTS_PER_USER; index += 1) {
      interceptor.intercept(context, next);
    }

    expect(() => interceptor.intercept(context, next)).toThrow(
      expect.objectContaining({ code: 'RATE_LIMITED' }) as Error,
    );
  });

  it('вошедший считается отдельно от своего адреса', () => {
    for (let index = 0; index < REQUESTS_PER_USER; index += 1) {
      interceptor.intercept(contextOf({ authorization: 'Bearer good' }), next);
    }

    // Тот же адрес без токена — свой, более широкий предел.
    expect(() => interceptor.intercept(contextOf({}), next)).not.toThrow();
  });

  it('без входа и с поддельным токеном — по адресу, предел шире', () => {
    for (let index = 0; index < REQUESTS_PER_ADDRESS; index += 1) {
      interceptor.intercept(contextOf({ authorization: 'Bearer fake' }), next);
    }

    expect(() => interceptor.intercept(contextOf({}), next)).toThrow();
    expect(() => interceptor.intercept(contextOf({}, '5.6.7.8'), next)).not.toThrow();
  });

  it('помеченные маршруты и не-HTTP вне предела', () => {
    skip = true;

    for (let index = 0; index < REQUESTS_PER_ADDRESS + 10; index += 1) {
      interceptor.intercept(contextOf({}), next);
    }

    skip = undefined;
    const ws = { getType: () => 'ws' } as unknown as ExecutionContext;
    expect(() => interceptor.intercept(ws, next)).not.toThrow();
    expect(() => interceptor.intercept(contextOf({}), next)).not.toThrow();
  });
});

describe('предел загрузок — ADR-131', () => {
  it('сто загрузок в час на пользователя, сто первая — отказ, обычные запросы проходят', () => {
    const context = contextOf({ authorization: 'Bearer good' });
    upload = true;

    for (let index = 0; index < UPLOADS_PER_USER; index += 1) {
      interceptor.intercept(context, next);
    }

    expect(() => interceptor.intercept(context, next)).toThrow(
      expect.objectContaining({ code: 'RATE_LIMITED', message: 'Too many uploads' }) as Error,
    );

    // Предел загрузок не трогает остальную работу того же человека.
    upload = undefined;
    expect(() => interceptor.intercept(context, next)).not.toThrow();
  });

  it('с одного адреса — триста загрузок в час по всем аккаунтам', () => {
    upload = true;

    for (let index = 0; index < UPLOADS_PER_ADDRESS; index += 1) {
      interceptor.intercept(contextOf({ authorization: `Bearer user-${String(index)}` }), next);
    }

    // Свежий аккаунт с того же адреса упирается в предел адреса…
    expect(() =>
      interceptor.intercept(contextOf({ authorization: 'Bearer user-new' }), next),
    ).toThrow(expect.objectContaining({ code: 'RATE_LIMITED' }) as Error);
    // …а с другого адреса проходит.
    expect(() =>
      interceptor.intercept(contextOf({ authorization: 'Bearer user-new' }, '5.6.7.8'), next),
    ).not.toThrow();
  });

  it('маршрут без отметки загрузкой не считается', () => {
    const context = contextOf({ authorization: 'Bearer good' });

    for (let index = 0; index < UPLOADS_PER_USER + 1; index += 1) {
      interceptor.intercept(context, next);
    }

    upload = true;
    expect(() => interceptor.intercept(context, next)).not.toThrow();
  });
});
