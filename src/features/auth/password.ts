import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Хранение паролей — ADR-034.
 *
 * `scrypt` из `node:crypto`, а не argon2 или bcrypt из npm: новых
 * зависимостей проект не заводит без нужды, а scrypt — тот же класс
 * функций, устойчивых к перебору на видеокартах, и он есть в рантайме.
 *
 * Соль своя на каждый пароль: с общей солью одна радужная таблица вскрывает
 * всю базу разом. Хеш и соль лежат в одной строке — отдельной колонки под
 * соль не нужно, а формат самодостаточен и переживёт смену параметров.
 */

/** Стоимость: 2^16 итераций. Около 100 мс на вход — дорого перебирать, терпимо ждать. */
const COST = 65_536;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

/** Память под `scrypt` при такой стоимости: без запаса он падает на пределе. */
const MAX_MEMORY = 256 * 1024 * 1024;

const OPTIONS = {
  N: COST,
  r: BLOCK_SIZE,
  p: PARALLELIZATION,
  maxmem: MAX_MEMORY,
} as const;

/** Формат строки в `User.passwordHash`: параметры, соль и ключ через `$`. */
const PREFIX = 'scrypt';

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(password.normalize('NFKC'), salt, KEY_LENGTH, OPTIONS);

  return [
    PREFIX,
    COST,
    BLOCK_SIZE,
    PARALLELIZATION,
    salt.toString('hex'),
    key.toString('hex'),
  ].join('$');
}

/**
 * Сверка пароля с хранимым хешем.
 *
 * Ложь при любом непонятном формате: чужой или испорченный хеш — это отказ
 * во входе, а не исключение на весь запрос.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  const [prefix, cost, blockSize, parallelization, salt, key] = parts;

  if (parts.length !== 6 || prefix !== PREFIX || salt === undefined || key === undefined) {
    return false;
  }

  const parameters = {
    N: Number(cost),
    r: Number(blockSize),
    p: Number(parallelization),
    maxmem: MAX_MEMORY,
  };

  if (!Number.isInteger(parameters.N) || !Number.isInteger(parameters.r)) return false;

  const expected = Buffer.from(key, 'hex');
  const actual = scryptSync(
    password.normalize('NFKC'),
    Buffer.from(salt, 'hex'),
    expected.length,
    parameters,
  );

  // Постоянное время: обычное `===` выдаёт длину совпадения.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
