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
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);

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
