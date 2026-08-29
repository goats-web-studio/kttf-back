import { z } from 'zod';

import { CODE_LENGTH, PHONE_PATTERN } from './auth.constants.js';

/**
 * Схемы запросов аутентификации.
 *
 * Живут в приложении, а не в общем коде: положить их в `kttf-shared` мешает
 * противоречие между брифом 3.1 и ADR-тестом на ноль зависимостей — ОВ-10 в
 * `docs/05-state.md`. Переезжают туда, когда вопрос будет решён.
 */

const phone = z.string().trim().regex(PHONE_PATTERN, 'Телефон ожидается в формате +7XXXXXXXXXX');

export const requestCodeSchema = z.object({ phone });
export type RequestCodeInput = z.infer<typeof requestCodeSchema>;

export const verifyCodeSchema = z.object({
  phone,
  code: z.string().trim().length(CODE_LENGTH).regex(/^\d+$/, 'Код состоит только из цифр'),
});
export type VerifyCodeInput = z.infer<typeof verifyCodeSchema>;

export const refreshSchema = z.object({ refreshToken: z.string().min(1) });
export type RefreshInput = z.infer<typeof refreshSchema>;
