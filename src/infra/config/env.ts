import { z } from 'zod';

/**
 * Схема окружения.
 *
 * Приложение обязано падать на старте, если окружение неверно, а не в момент
 * первого запроса к базе. Отказ при запуске виден сразу и в логе, и в
 * оркестраторе; отказ на первом запросе выглядит как случайная ошибка API.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  /** Строка подключения PostgreSQL. Значение секретное, в репозитории его нет. */
  DATABASE_URL: z.string().min(1),

  /**
   * Ключ подписи access-токенов.
   *
   * Минимум 32 символа: короткий ключ HS256 подбирается перебором, а подделка
   * токена означает вход в любой аккаунт.
   */
  JWT_SECRET: z.string().min(32),

  /**
   * Ключ, которым хешируются одноразовые коды.
   *
   * Отдельный от JWT_SECRET намеренно. Ключи с разным назначением не смешивают:
   * утечка одного не должна давать возможностей другого, а ротировать их
   * приходится по разным поводам.
   */
  AUTH_CODE_SECRET: z.string().min(32),
});

export type Env = Readonly<z.infer<typeof envSchema>>;

/** Токен внедрения: строка, потому что Env — тип, а не значение. */
export const ENV = 'KTTF_ENV';

/**
 * Разбирает окружение или бросает исключение с перечнем всех проблем сразу.
 *
 * Именно всех: показывать их по одной означает заставить человека
 * перезапускать приложение столько раз, сколько переменных он не задал.
 */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(корень)'}: ${issue.message}`)
      .join('\n');

    throw new Error(`Окружение задано неверно:\n${problems}`);
  }

  return Object.freeze(result.data);
}
