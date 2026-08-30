import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ERROR_CODES, type ErrorCode, isAppError } from '@kttf/shared/errors';
import type { Response } from 'express';

/** Тело ответа об ошибке. Формат задан ТС 7.8 и одинаков для всех эндпоинтов. */
export interface ErrorResponseBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

const STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: HttpStatus.BAD_REQUEST,
  UNAUTHORIZED: HttpStatus.UNAUTHORIZED,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
  INTERNAL_ERROR: HttpStatus.INTERNAL_SERVER_ERROR,

  // Встречи — ТС 7.6. Отказ по состоянию турнира или встречи — это конфликт,
  // а не кривой запрос: тело верное, изменилось положение дел.
  TOURNAMENT_NOT_RUNNING: HttpStatus.CONFLICT,
  MATCH_NOT_READY: HttpStatus.CONFLICT,
  MATCH_ALREADY_FINISHED: HttpStatus.CONFLICT,
  MATCH_HAS_NO_RESULT: HttpStatus.CONFLICT,
  DOWNSTREAM_MATCH_PLAYED: HttpStatus.CONFLICT,
  INVALID_SCORE: HttpStatus.BAD_REQUEST,
  TIE_DECISION_INVALID: HttpStatus.BAD_REQUEST,
};

const CODE_BY_STATUS: Readonly<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: ERROR_CODES.VALIDATION_FAILED,
  [HttpStatus.UNAUTHORIZED]: ERROR_CODES.UNAUTHORIZED,
  [HttpStatus.FORBIDDEN]: ERROR_CODES.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ERROR_CODES.NOT_FOUND,
  [HttpStatus.TOO_MANY_REQUESTS]: ERROR_CODES.RATE_LIMITED,
};

/**
 * Единственное место, где исключение превращается в ответ.
 *
 * Три источника отказов сходятся к одному формату: доменные `AppError`,
 * собственные исключения Nest (несуществующий маршрут, неверный метод) и всё
 * остальное. Последнее наружу не выносит ничего, кроме кода: в необработанном
 * исключении может оказаться строка подключения или персональные данные.
 *
 * Текст `message` диагностический. Пользователь видит то, что клиент подобрал
 * по `code`, — бриф 3.4 запрещает показывать захардкоженные строки.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.describe(exception);

    response.status(status).json(body);
  }

  private describe(exception: unknown): { status: number; body: ErrorResponseBody } {
    if (isAppError(exception)) {
      return {
        status: STATUS_BY_CODE[exception.code],
        body: {
          error: {
            code: exception.code,
            message: exception.message,
            ...(exception.details === undefined ? {} : { details: exception.details }),
          },
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();

      return {
        status,
        body: {
          error: {
            code: CODE_BY_STATUS[status] ?? ERROR_CODES.INTERNAL_ERROR,
            message: exception.message,
          },
        },
      };
    }

    // Сюда попадает то, чего никто не предусмотрел. Логируется целиком,
    // отдаётся наружу без подробностей.
    this.logger.error('Необработанное исключение', exception);

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'Internal error' } },
    };
  }
}
