import { type PipeTransform } from '@nestjs/common';
import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import type { ZodType } from 'zod';

/**
 * Проверка входа схемой Zod.
 *
 * Возвращается разобранное значение, а не исходное: схема приводит типы
 * (номер страницы из строки запроса — число), и дальше по коду обязано ехать
 * приведённое. Иначе типы обманывают — в них `number`, в рантайме строка.
 *
 * Пайп собирается на схему, а не вешается глобально: у каждого эндпоинта
 * своя схема, а глобальный пайп нечему было бы применять.
 */
/**
 * Невидимые символы, которые приносит копирование из 2ГИС, WhatsApp и
 * Word: пробел нулевой ширины, соединитель слов, BOM. `trim()` их не
 * считает пробелами, и адрес « Проспект…» с U+200B впереди так и ложился
 * в базу (DEV-77). Соединители эмодзи (U+200C, U+200D) не трогаем: без них
 * рассыпаются составные эмодзи в постах.
 */
const INVISIBLE = /[\u200B\u2060\uFEFF]/g;

/** Чистит строки входа на любой глубине; остальное возвращает как есть. */
export function stripInvisible(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(INVISIBLE, '');
  if (Array.isArray(value)) return value.map(stripInvisible);

  if (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, stripInvisible(item)]),
    );
  }

  return value;
}

export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(stripInvisible(value));

    if (!result.success) {
      // Все проблемы разом: чинить ввод по одной ошибке за запрос — мучение.
      const fields = result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));

      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Request failed schema validation', {
        fields,
      });
    }

    return result.data;
  }
}
