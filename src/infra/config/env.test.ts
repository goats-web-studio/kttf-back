import { describe, expect, it } from 'vitest';

import { parseEnv } from './env.js';

const minimal = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5433/kttf',
  JWT_SECRET: 'test_secret_at_least_32_characters_long',
  AUTH_CODE_SECRET: 'code_secret_at_least_32_characters!!',
};

describe('parseEnv', () => {
  it('умолчания разумны: без NODE_ENV и PORT приложение всё равно поднимется', () => {
    const env = parseEnv(minimal);

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
  });

  it('порт приводится к числу: из окружения он приходит строкой', () => {
    const env = parseEnv({ ...minimal, PORT: '8080' });

    expect(env.PORT).toBe(8080);
  });

  it('без строки подключения не стартует', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it('перечисляет все проблемы разом, а не первую', () => {
    // Иначе человек перезапускает приложение столько раз, сколько переменных
    // он не задал.
    let message = '';
    try {
      parseEnv({ NODE_ENV: 'staging', PORT: 'abc' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('NODE_ENV');
    expect(message).toContain('PORT');
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('JWT_SECRET');
    expect(message).toContain('AUTH_CODE_SECRET');
  });

  it('короткий ключ подписи не принимается', () => {
    // HS256 с коротким ключом подбирается перебором, а подделка токена — это
    // вход в любой аккаунт.
    expect(() => parseEnv({ ...minimal, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('неизвестный режим не проходит', () => {
    expect(() => parseEnv({ ...minimal, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('результат заморожен: конфигурация не правится по ходу работы', () => {
    const env = parseEnv(minimal);

    expect(Object.isFrozen(env)).toBe(true);
  });
});
