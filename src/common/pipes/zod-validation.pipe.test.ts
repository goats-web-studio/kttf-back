import { isAppError } from '@kttf/shared/errors';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ZodValidationPipe } from './zod-validation.pipe.js';

const schema = z.object({
  page: z.coerce.number().int().positive(),
  search: z.string().min(1),
});

describe('ZodValidationPipe', () => {
  it('возвращает приведённое значение, а не исходное', () => {
    // Номер страницы приходит строкой. Дальше по коду обязано ехать число,
    // иначе тип обманывает: в сигнатуре number, в рантайме строка.
    const result = new ZodValidationPipe(schema).transform({ page: '2', search: 'ivanov' });

    expect(result).toEqual({ page: 2, search: 'ivanov' });
  });

  it('бросает доменную ошибку с кодом VALIDATION_FAILED', () => {
    const pipe = new ZodValidationPipe(schema);

    try {
      pipe.transform({ page: 0, search: '' });
      expect.unreachable('пайп обязан был отказать');
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      if (!isAppError(error)) return;
      expect(error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('перечисляет все негодные поля разом', () => {
    const pipe = new ZodValidationPipe(schema);

    try {
      pipe.transform({ page: 0, search: '' });
      expect.unreachable('пайп обязан был отказать');
    } catch (error) {
      if (!isAppError(error)) throw error;
      // details пересекает границу как unknown — сужаем явно, бриф 3.1.
      const fields = error.details?.fields as { path: string; message: string }[] | undefined;

      expect(fields?.map((field) => field.path)).toEqual(['page', 'search']);
      expect(fields?.every((field) => field.message.length > 0)).toBe(true);
    }
  });

  it('убирает невидимые символы из строк на любой глубине, эмодзи не ломает (DEV-77)', () => {
    const pipe = new ZodValidationPipe(
      z.object({
        address: z.string().trim(),
        contacts: z.array(z.object({ name: z.string() })),
        text: z.string(),
      }),
    );

    expect(
      pipe.transform({
        address: '\u200BПроспект Богенбай батыра, 2, \u200B3 этаж\uFEFF',
        contacts: [{ name: 'Win\u2060ners' }],
        text: 'Семья 👨\u200D👩\u200D👧',
      }),
    ).toEqual({
      address: 'Проспект Богенбай батыра, 2, 3 этаж',
      contacts: [{ name: 'Winners' }],
      text: 'Семья 👨\u200D👩\u200D👧',
    });
  });
});
