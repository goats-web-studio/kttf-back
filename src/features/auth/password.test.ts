import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from './password.js';

/**
 * Хранение паролей — ADR-034, ADR-128.
 *
 * Здесь легко ошибиться незаметно: общая соль или сравнение через `===` не
 * ломают ни один функциональный тест, они ломают безопасность молча.
 */

/**
 * Хеш пароля `parol123`, посчитанный прежним синхронным кодом до ADR-128.
 * Такие лежат в базе у всех, кто уже завёл аккаунт.
 */
const STORED_BEFORE_ADR_128 =
  'scrypt$65536$8$1$0123456789abcdef0123456789abcdef$d85a08bc67a913c4a24ea04fa2da67ffc66cf411f4c3853cec433f4f2ad05d7cd08cb505d950229389c95cc9ff481f2855beffc9b1d5005ef1c9ac67523c50c5';

describe('пароль', () => {
  it('сверяется с собственным хешем', async () => {
    const stored = await hashPassword('parol123');

    expect(await verifyPassword('parol123', stored)).toBe(true);
    expect(await verifyPassword('parol124', stored)).toBe(false);
  });

  it('хеш, записанный до ADR-128, сверяется как раньше', async () => {
    // Формат и параметры не менялись: вошедшие раньше входят и теперь.
    expect(await verifyPassword('parol123', STORED_BEFORE_ADR_128)).toBe(true);
    expect(await verifyPassword('parol124', STORED_BEFORE_ADR_128)).toBe(false);
  });

  it('у одного и того же пароля хеши разные', async () => {
    // Общая соль означала бы, что одна радужная таблица вскрывает базу разом,
    // а одинаковые хеши выдают тех, у кого пароль совпал.
    expect(await hashPassword('parol123')).not.toBe(await hashPassword('parol123'));
  });

  it('сам пароль в строке не хранится', async () => {
    expect(await hashPassword('parol123')).not.toContain('parol123');
  });

  it('юникод сводится к одной форме', async () => {
    // «é» набирается одним знаком и двумя; для человека это один пароль.
    const stored = await hashPassword('paérol12');

    expect(await verifyPassword('paérol12', stored)).toBe(true);
  });

  it('испорченный хеш означает отказ, а не исключение', async () => {
    const salt = '0123456789abcdef0123456789abcdef';
    const broken = [
      '',
      'мусор',
      'scrypt$1$2$3',
      `${STORED_BEFORE_ADR_128}$лишнее`,
      // N не степень двойки и N = 0: scrypt такие параметры не принимает.
      `scrypt$3$8$1$${salt}$abcd`,
      `scrypt$$8$1$${salt}$abcd`,
      // Пустой ключ совпал бы с любым паролем.
      `scrypt$65536$8$1$${salt}$`,
      `scrypt$65536$8$1$${salt}$не-hex`,
    ];

    for (const stored of broken) {
      expect(await verifyPassword('parol123', stored), stored).toBe(false);
    }
  });

  it('не держит поток запросов, пока считается хеш', async () => {
    // Синхронный scrypt останавливал весь API на время хеша (ADR-128):
    // таймер на ноль миллисекунд срабатывал только после него.
    let ticked = false;
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        ticked = true;
        resolve();
      }, 0);
    });

    const tickedBeforeHash = hashPassword('parol123').then(() => ticked);

    await timer;
    expect(await tickedBeforeHash).toBe(true);
  });

  it('очередь не теряет запросов, когда их больше, чем мест', async () => {
    const passwords = ['parol-1a', 'parol-2b', 'parol-3c', 'parol-4d', 'parol-5e'];

    const results = await Promise.all(
      passwords.map(async (password) => verifyPassword(password, await hashPassword(password))),
    );

    expect(results).toEqual([true, true, true, true, true]);
  });
});
