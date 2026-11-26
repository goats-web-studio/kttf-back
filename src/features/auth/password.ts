import { randomBytes, scrypt, scryptSync, timingSafeEqual, type ScryptOptions } from 'node:crypto';

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
 *
 * Хеш считается в пуле потоков, а не в потоке запросов (ADR-128): синхронный
 * `scryptSync` на ~100 мс останавливал весь API, и серия регистраций с одного
 * адреса держала сайт занятым для всех.
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

/**
 * Сколько хешей считается одновременно.
 *
 * В пуле потоков libuv по умолчанию четыре потока, и там же работают sharp
 * (картинки) и поиск адресов при новых подключениях к базе и хранилищу. Два
 * потока под пароли оставляют место остальным, а память — 64 МБ на хеш —
 * не растёт с числом запросов: лишние ждут в очереди.
 */
export const PASSWORD_HASHES_IN_PARALLEL = 2;

let running = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (running < PASSWORD_HASHES_IN_PARALLEL) {
    running += 1;
    return;
  }

  // Место передаётся из рук в руки в `release`: счётчик между ними не
  // опускается, и новый запрос не проскочит мимо очереди.
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();

  if (next === undefined) {
    running -= 1;
  } else {
    next();
  }
}

async function derive(
  password: string,
  salt: Buffer,
  length: number,
  options: ScryptOptions,
): Promise<Buffer> {
  await acquire();

  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password.normalize('NFKC'), salt, length, options, (error, key) => {
        if (error === null) {
          resolve(key);
        } else {
          reject(error);
        }
      });
    });
  } finally {
    release();
  }
}

function format(salt: Buffer, key: Buffer): string {
  return [
    PREFIX,
    COST,
    BLOCK_SIZE,
    PARALLELIZATION,
    salt.toString('hex'),
    key.toString('hex'),
  ].join('$');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);

  return format(salt, await derive(password, salt, KEY_LENGTH, OPTIONS));
}

/**
 * Сверка пароля с хранимым хешем.
 *
 * Ложь при любом непонятном формате: чужой или испорченный хеш — это отказ
 * во входе, а не исключение на весь запрос.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
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

  // Пустой ключ совпал бы с любым паролем: два пустых буфера равны.
  if (expected.length === 0) return false;

  let actual: Buffer;

  try {
    actual = await derive(password, Buffer.from(salt, 'hex'), expected.length, parameters);
  } catch {
    // Негодные параметры в строке (N не степень двойки, память сверх
    // предела) — тот же отказ, что и неверный пароль.
    return false;
  }

  // Постоянное время: обычное `===` выдаёт длину совпадения.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Хеш, с которым сверяется пароль несуществующего пользователя.
 *
 * Считается один раз при загрузке модуля: сверка обязана занимать одинаковое
 * время и для знакомого логина, и для незнакомого, иначе перебор находит
 * существующие аккаунты по времени ответа. Синхронно можно: при загрузке
 * модуля запросов ещё нет.
 */
export const DUMMY_HASH = ((): string => {
  const salt = randomBytes(SALT_BYTES);
  const secret = randomBytes(32).toString('hex');

  return format(salt, scryptSync(secret.normalize('NFKC'), salt, KEY_LENGTH, OPTIONS));
})();
