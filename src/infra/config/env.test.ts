import { describe, expect, it } from 'vitest';

import { parseEnv } from './env.js';

const minimal = { DATABASE_URL: 'postgresql://user:pass@localhost:5433/kttf' };

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
  });

  it('неизвестный режим не проходит', () => {
    expect(() => parseEnv({ ...minimal, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('результат заморожен: конфигурация не правится по ходу работы', () => {
    const env = parseEnv(minimal);

    expect(Object.isFrozen(env)).toBe(true);
  });
});
