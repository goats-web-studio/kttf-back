import { z } from 'zod';

import { pageQuerySchema } from '../../common/pagination.js';

/**
 * Схемы игроков.
 *
 * Состав полей — ТЗ 2.2 в пределах модели `Player`. Трёх необязательных полей
 * из ТЗ 2.2 в схеме базы нет: игровой руки, хвата и инвентаря. Здесь их тоже
 * нет — колонки самостоятельно не заводятся, бриф 4.1. Расхождение записано
 * как ОВ-12.
 *
 * Рейтинг в схемах отсутствует намеренно: он проекция журнала `RatingEvent`
 * (ТС 1.4), полем его не задают. Вопрос о стартовом значении открыт (ОВ-2),
 * до его решения действует умолчание схемы.
 */

/** Верхняя граница года рождения — текущий год: игроков из будущего нет. */
const currentYear = new Date().getFullYear();

const name = z.string().trim().min(1).max(100);

const profile = {
  lastName: name,
  firstName: name,
  // Отчество не обязательно — бриф, запрет №6.
  middleName: name.optional(),
  birthYear: z.number().int().min(1900).max(currentYear),
  gender: z.enum(['MALE', 'FEMALE']),
  city: z.string().trim().min(1).max(100),
  photoUrl: z.url().max(500).optional(),
  clubId: z.uuid().optional(),
};

export const createPlayerSchema = z.object(profile);
export type CreatePlayerInput = z.infer<typeof createPlayerSchema>;

export const updatePlayerSchema = z
  .object(profile)
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'Нужно указать хотя бы одно поле' });
export type UpdatePlayerInput = z.infer<typeof updatePlayerSchema>;

export const listPlayersSchema = pageQuerySchema.extend({
  search: z.string().trim().min(1).max(100).optional(),
  city: z.string().trim().min(1).max(100).optional(),
  clubId: z.uuid().optional(),
});
export type ListPlayersQuery = z.infer<typeof listPlayersSchema>;
