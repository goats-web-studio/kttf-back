import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../infra/config/env.js';
import {
  REQUESTS_PER_ADDRESS,
  REQUESTS_PER_USER,
  RateLimitInterceptor,
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
let interceptor: RateLimitInterceptor;

beforeEach(() => {
  skip = undefined;
  const reflector = { getAllAndOverride: vi.fn(() => skip) } as unknown as Reflector;
  const tokens = {
    verifyAccessToken: vi.fn((token: string) => (token === 'good' ? 'user-1' : null)),
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
