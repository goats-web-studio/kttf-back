import 'dotenv/config';

import { defineConfig, env } from 'prisma/config';

/**
 * Конфигурация Prisma.
 *
 * Начиная с 7-й версии строка подключения не живёт в схеме: миграции берут её
 * отсюда, а клиент подключается через адаптер драйвера. Разделение полезное —
 * схема перестала быть местом, куда случайно попадают секреты.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
});
