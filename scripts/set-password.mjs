/**
 * Задать пароль существующему аккаунту — ADR-034.
 *
 * Нужен для тех, кто заведён до перехода на пароль: регистрация им не
 * поможет, их телефон уже занят ими самими. Живёт скриптом, а не маршрутом:
 * это разовая операция обслуживания, и наружу её открывать незачем.
 *
 * Использование: node scripts/set-password.mjs <телефон|логин> <пароль> [логин]
 */
import { randomBytes, scryptSync } from 'node:crypto';

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

const [identifier, password, newLogin] = process.argv.slice(2);

if (identifier === undefined || password === undefined) {
  console.error('Использование: node scripts/set-password.mjs <телефон|логин> <пароль> [логин]');
  process.exit(1);
}

if (password.length < 8) {
  console.error('Пароль короче восьми знаков — столько же требует регистрация.');
  process.exit(1);
}

/** Тот же формат, что в src/features/auth/password.ts. */
function hashPassword(value) {
  const salt = randomBytes(16);
  const options = { N: 65_536, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
  const key = scryptSync(value.normalize('NFKC'), salt, 64, options);

  return ['scrypt', options.N, options.r, options.p, salt.toString('hex'), key.toString('hex')].join(
    '$',
  );
}

// Тот же драйвер, что у приложения: клиент Prisma 7 без адаптера не
// подключается вовсе.
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

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: hashPassword(password),
      ...(newLogin === undefined ? {} : { login: newLogin }),
    },
  });

  console.log(`Пароль задан: ${user.phone}${newLogin === undefined ? '' : ` (логин ${newLogin})`}`);
} finally {
  await prisma.$disconnect();
}
