import {
  type ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import { describe, expect, it, vi } from 'vitest';

import { AllExceptionsFilter, type ErrorResponseBody } from './all-exceptions.filter.js';

/** Ответ Express в объёме, который использует фильтр. */
function makeHost(): { host: ArgumentsHost; sent: () => { status: number; body: unknown } } {
  let status = 0;
  let body: unknown;

  const response = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
  };

  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;

  return { host, sent: () => ({ status, body }) };
}

function bodyOf(value: unknown): ErrorResponseBody {
  return value as ErrorResponseBody;
}

describe('AllExceptionsFilter', () => {
  it('доменная ошибка отдаёт свой код и статус по коду', () => {
    const { host, sent } = makeHost();

    new AllExceptionsFilter().catch(
      new AppError(ERROR_CODES.NOT_FOUND, 'player not found', { id: 'p-1' }),
      host,
    );

    expect(sent().status).toBe(HttpStatus.NOT_FOUND);
    expect(bodyOf(sent().body)).toEqual({
      error: { code: 'NOT_FOUND', message: 'player not found', details: { id: 'p-1' } },
    });
  });

  it('без подробностей поле details не появляется пустым', () => {
    const { host, sent } = makeHost();

    new AllExceptionsFilter().catch(new AppError(ERROR_CODES.FORBIDDEN, 'not your club'), host);

    expect(bodyOf(sent().body).error).not.toHaveProperty('details');
  });

  it('каждому коду соответствует свой статус', () => {
    const expected: Record<string, number> = {
      VALIDATION_FAILED: 400,
      UNAUTHORIZED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      RATE_LIMITED: 429,
      INTERNAL_ERROR: 500,
      TOURNAMENT_NOT_RUNNING: 409,
      MATCH_NOT_READY: 409,
      MATCH_ALREADY_FINISHED: 409,
      MATCH_HAS_NO_RESULT: 409,
      DOWNSTREAM_MATCH_PLAYED: 409,
      INVALID_SCORE: 400,
      TIE_DECISION_INVALID: 400,
      TOURNAMENT_NOT_COMPLETE: 409,
      TIES_UNRESOLVED: 409,
      RATING_SNAPSHOT_MISSING: 409,
    };

    for (const code of Object.values(ERROR_CODES)) {
      const { host, sent } = makeHost();
      new AllExceptionsFilter().catch(new AppError(code, 'boom'), host);
      expect(sent().status, `код ${code}`).toBe(expected[code]);
    }
  });

  it('исключение Nest переводится в тот же формат', () => {
    // Несуществующий маршрут — самый частый отказ, и он обязан выглядеть
    // так же, как доменный, иначе клиенту нужны два разбора ответа.
    const { host, sent } = makeHost();

    new AllExceptionsFilter().catch(new NotFoundException('Cannot GET /api/v1/nope'), host);

    expect(sent().status).toBe(HttpStatus.NOT_FOUND);
    expect(bodyOf(sent().body).error.code).toBe('NOT_FOUND');
  });

  it('статус Nest без своего кода становится INTERNAL_ERROR', () => {
    const { host, sent } = makeHost();

    new AllExceptionsFilter().catch(new HttpException('teapot', 418), host);

    expect(sent().status).toBe(418);
    expect(bodyOf(sent().body).error.code).toBe('INTERNAL_ERROR');
  });

  it('необработанное исключение наружу ничего не выносит', () => {
    // В сообщении может оказаться строка подключения или персональные данные.
    const { host, sent } = makeHost();
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    new AllExceptionsFilter().catch(
      new Error('connection string: postgres://user:secret@db'),
      host,
    );

    expect(sent().status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(bodyOf(sent().body)).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal error' },
    });
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });
});
