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
  // Игрока нет в расстановке: тело запроса верное, состав турнира — другой.
  DRAW_POSITION_NOT_FOUND: HttpStatus.CONFLICT,
  // Стола нет в зале — запрос неверен; стол занят или длину не сменить —
  // запрос верный, мешает положение дел в зале (ADR-061).
  TABLE_OUT_OF_RANGE: HttpStatus.BAD_REQUEST,
  TABLE_BUSY: HttpStatus.CONFLICT,
  MATCH_LENGTH_LOCKED: HttpStatus.CONFLICT,

  // Завершение турнира — ТС 7.5. Тоже конфликт состояния: запрос верный,
  // турнир к нему не готов. Отсутствие снимка — не вина запроса вовсе.
  TOURNAMENT_NOT_COMPLETE: HttpStatus.CONFLICT,
  TIES_UNRESOLVED: HttpStatus.CONFLICT,
  RATING_SNAPSHOT_MISSING: HttpStatus.CONFLICT,

  // Справочник — ADR-046. Недоступный город — изъян запроса: выбирать
  // предлагалось из открытого списка. Дубликат — конфликт с тем, что уже есть.
  CITY_UNAVAILABLE: HttpStatus.BAD_REQUEST,
  PLACE_ALREADY_EXISTS: HttpStatus.CONFLICT,

  // Страница клуба — ADR-055. Предел тарифа — конфликт состояния: запрос
  // верный, в галерее больше нет места. Чужая ссылка вместо ролика — ошибка тела.
  CLUB_PLAN_LIMIT: HttpStatus.CONFLICT,
  VIDEO_NOT_FOUND: HttpStatus.BAD_REQUEST,

  // Маркет — ADR-058. Второй производитель с тем же названием — конфликт с тем, что уже есть.
  BRAND_ALREADY_EXISTS: HttpStatus.CONFLICT,

  // Страница тренера — ADR-059. Вторая страница и действие не по статусу
  // заявки — конфликт с тем, что уже есть. Неполная страница — тоже
  // конфликт состояния, как незавершённый турнир: запрос верный, страница
  // к отправке не готова.
  COACH_ALREADY_EXISTS: HttpStatus.CONFLICT,
  COACH_INCOMPLETE: HttpStatus.CONFLICT,
  COACH_STATUS_INVALID: HttpStatus.CONFLICT,
  // Ответ на связь, которая этого ответа не ждёт, — тоже конфликт состояния.
  TRAINING_LINK_INVALID: HttpStatus.CONFLICT,
  // Штаб клуба — T2: подтверждение не той стороной, повтор приглашения.
  CLUB_COACH_INVALID: HttpStatus.CONFLICT,
  // Фото, видео и записи тренера — T2.2: предел тарифа, как у клуба.
  COACH_PLAN_LIMIT: HttpStatus.CONFLICT,
  // Тренер участника после старта турнира — T3: запрос верный, турнир уже идёт.
  REGISTRATION_COACH_LOCKED: HttpStatus.CONFLICT,
  // Заявка на пробную — T3: повтор и действие не по статусу — конфликт с тем,
  // что уже есть. Предел за сутки — как предел тарифа, а не RATE_LIMITED:
  // повтор через минуту ничего не изменит, ждать надо сутки.
  TRIAL_REQUEST_EXISTS: HttpStatus.CONFLICT,
  TRIAL_REQUEST_LIMIT: HttpStatus.CONFLICT,
  TRIAL_REQUEST_INVALID: HttpStatus.CONFLICT,
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
