/**
 * Выдать или снять роль администратора платформы — ADR-046.
 *
 * Живёт скриптом, а не маршрутом, по той же причине, что set-password:
 * маршрут, который делает человека администратором, — это дверь, которую
 * пришлось бы стеречь. Администраторов единицы, и назначает их владелец
 * продукта руками.
 *
 * Использование: node scripts/set-admin.mjs <телефон|логин> [--revoke]
 */
import { existsSync } from 'node:fs';

// Клиент берётся из сборки: сгенерированный Prisma код лежит в TypeScript,
// а скрипт исполняется голым Node.
const CLIENT = new URL('../dist/generated/prisma/client.js', import.meta.url);

if (!existsSync(CLIENT)) {
  console.error('Сначала pnpm build: скрипт работает с собранным клиентом Prisma.');
  process.exit(1);
}

const { PrismaClient } = await import(CLIENT.href);
const { PrismaPg } = await import('@prisma/adapter-pg');

const [identifier, flag] = process.argv.slice(2);

if (identifier === undefined || (flag !== undefined && flag !== '--revoke')) {
  console.error('Использование: node scripts/set-admin.mjs <телефон|логин> [--revoke]');
  process.exit(1);
}

const isAdmin = flag !== '--revoke';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

try {
  const where = /^\+7\d{10}$/.test(identifier) ? { phone: identifier } : { login: identifier };
  const user = await prisma.user.findUnique({ where, select: { id: true, phone: true } });

  if (user === null) {
    console.error(`Пользователь не найден: ${identifier}`);
    process.exit(1);
  }

  await prisma.user.update({ where: { id: user.id }, data: { isAdmin } });

  console.log(`${isAdmin ? 'Администратор' : 'Больше не администратор'}: ${user.phone}`);
} finally {
  await prisma.$disconnect();
}
