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
   * Хранилище файлов — ADR-036.
   *
   * Ключи необязательны намеренно: без них поднимается всё, кроме загрузки
   * фото, и разработка идёт без MinIO под рукой. Отказ приходит на попытке
   * загрузить, а не на старте: неработающая загрузка — это одна страница
   * профиля, а не весь продукт.
   */
  S3_ENDPOINT: z.string().min(1).default('http://kttf-minio:9000'),
  S3_ACCESS_KEY: z.string().min(1).optional(),
  S3_SECRET_KEY: z.string().min(1).optional(),
  S3_BUCKET: z.string().min(1).default('kttf-media'),
  /** MinIO регион не проверяет, но подпись S3 без него не считается. */
  S3_REGION: z.string().min(1).default('us-east-1'),

  /**
   * Откуда импорт каталога вправе скачивать фото — ADR-058, `docs/10` 6.
   * Хосты через запятую, поддомены разрешены вместе с хостом. Не задано —
   * только `rttf.ru`: сервер не ходит по ссылкам из файла куда угодно.
   */
  /**
   * Напоминания о дуэлях за 3 часа — ADR-068. Фоновая задача процесса;
   * `off` выключает её (например, на втором экземпляре, хотя захват строки
   * и так не даст отправить дважды). В тестах не запускается никогда.
   */
  DUEL_REMINDERS: z.enum(['on', 'off']).optional(),

  CATALOG_IMPORT_HOSTS: z
    .string()
    .regex(/^[a-z0-9.-]+(?:,[a-z0-9.-]+)*$/)
    .optional(),
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
