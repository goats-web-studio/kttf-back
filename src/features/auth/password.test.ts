import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from './password.js';

/**
 * Хранение паролей — ADR-034.
 *
 * Здесь легко ошибиться незаметно: общая соль или сравнение через `===` не
 * ломают ни один функциональный тест, они ломают безопасность молча.
 */

describe('пароль', () => {
  it('сверяется с собственным хешем', () => {
    const stored = hashPassword('parol123');

    expect(verifyPassword('parol123', stored)).toBe(true);
    expect(verifyPassword('parol124', stored)).toBe(false);
  });

  it('у одного и того же пароля хеши разные', () => {
    // Общая соль означала бы, что одна радужная таблица вскрывает базу разом,
    // а одинаковые хеши выдают тех, у кого пароль совпал.
    expect(hashPassword('parol123')).not.toBe(hashPassword('parol123'));
  });

  it('сам пароль в строке не хранится', () => {
    expect(hashPassword('parol123')).not.toContain('parol123');
  });

  it('юникод сводится к одной форме', () => {
    // «é» набирается одним знаком и двумя; для человека это один пароль.
    const stored = hashPassword('paérol12');

    expect(verifyPassword('paérol12', stored)).toBe(true);
  });

  it('испорченный хеш означает отказ, а не исключение', () => {
    for (const broken of ['', 'мусор', 'scrypt$1$2$3', `${hashPassword('parol123')}$лишнее`]) {
      expect(verifyPassword('parol123', broken), broken).toBe(false);
    }
  });
});
