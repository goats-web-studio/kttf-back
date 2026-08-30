import { CODE_LENGTH } from '@kttf/shared/types';
import { JwtService } from '@nestjs/jwt';
import { describe, expect, it } from 'vitest';

import { ACCESS_TOKEN_TTL_SECONDS } from './auth.constants.js';
import { TokenService } from './token.service.js';

const SECRET = 'test_secret_at_least_32_characters_long';

function makeService(codeSecret = 'code_secret_at_least_32_characters!!'): TokenService {
  return new TokenService(
    {
      NODE_ENV: 'test',
      PORT: 3000,
      DATABASE_URL: 'postgresql://x',
      JWT_SECRET: SECRET,
      AUTH_CODE_SECRET: codeSecret,
    },
    new JwtService({ secret: SECRET }),
  );
}

describe('access-токен', () => {
  it('выпускается и читается обратно', () => {
    const service = makeService();

    expect(service.verifyAccessToken(service.issueAccessToken('user-1'))).toBe('user-1');
  });

  it('подделанный не проходит', () => {
    const alien = new TokenService(
      {
        NODE_ENV: 'test',
        PORT: 3000,
        DATABASE_URL: 'postgresql://x',
        JWT_SECRET: 'someone_elses_secret_32_characters!!',
        AUTH_CODE_SECRET: 'code_secret_at_least_32_characters!!',
      },
      new JwtService({ secret: 'someone_elses_secret_32_characters!!' }),
    );

    expect(makeService().verifyAccessToken(alien.issueAccessToken('user-1'))).toBeNull();
  });

  it('мусор вместо токена не роняет проверку', () => {
    expect(makeService().verifyAccessToken('не токен вовсе')).toBeNull();
  });

  it('истёкший не проходит', () => {
    const jwt = new JwtService({ secret: SECRET });
    const expired = jwt.sign({ sub: 'user-1' }, { expiresIn: -1 });

    expect(makeService().verifyAccessToken(expired)).toBeNull();
  });

  it('токен без sub не пропускается', () => {
    // Подписан нами, но пустой: без проверки такой токен дал бы userId
    // undefined, и дальше по коду он поехал бы как строка.
    const signed = new JwtService({ secret: SECRET }).sign({});

    expect(makeService().verifyAccessToken(signed)).toBeNull();
  });

  it('срок жизни ограничен: у JWT нет отзыва', () => {
    const service = makeService();
    const decoded = new JwtService({ secret: SECRET }).decode<{ exp: number; iat: number }>(
      service.issueAccessToken('user-1'),
    );

    expect(decoded.exp - decoded.iat).toBe(ACCESS_TOKEN_TTL_SECONDS);
  });
});

describe('одноразовый код', () => {
  it('нужной длины и только из цифр', () => {
    const service = makeService();

    for (let i = 0; i < 200; i += 1) {
      expect(service.generateCode()).toMatch(new RegExp(`^[0-9]{${String(CODE_LENGTH)}}$`));
    }
  });

  it('ведущие нули сохраняются: код — строка, а не число', () => {
    // 000123 как число превращается в 123, и человек вводит не то, что видит.
    const service = makeService();
    const codes = Array.from({ length: 2000 }, () => service.generateCode());

    expect(codes.every((code) => code.length === CODE_LENGTH)).toBe(true);
  });

  it('коды не повторяются подряд', () => {
    const service = makeService();
    const codes = new Set(Array.from({ length: 100 }, () => service.generateCode()));

    expect(codes.size).toBeGreaterThan(50);
  });

  it('хеш сходится со своим кодом', () => {
    const service = makeService();
    const code = service.generateCode();

    expect(service.matchesCode(code, service.hashCode(code))).toBe(true);
  });

  it('чужой код не подходит', () => {
    const service = makeService();

    expect(service.matchesCode('000000', service.hashCode('111111'))).toBe(false);
  });

  it('хеш зависит от ключа: утечка базы не выдаёт коды', () => {
    // Без ключа таблица хешей для миллиона шестизначных кодов строится за
    // секунды, и любой действующий код восстанавливается из базы.
    const ours = makeService();
    const theirs = makeService('other_secret_at_least_32_characters!');

    expect(ours.hashCode('123456')).not.toBe(theirs.hashCode('123456'));
  });

  it('мусор вместо хеша не роняет сверку', () => {
    const service = makeService();

    expect(service.matchesCode('123456', 'не хеш')).toBe(false);
    expect(service.matchesCode('123456', '')).toBe(false);
  });
});

describe('refresh-токен', () => {
  it('каждый раз новый и достаточно длинный', () => {
    const service = makeService();
    const tokens = new Set(Array.from({ length: 100 }, () => service.generateRefreshToken()));

    expect(tokens.size).toBe(100);
    expect([...tokens][0]).toHaveLength(64);
  });

  it('хешируется устойчиво', () => {
    const service = makeService();
    const token = service.generateRefreshToken();

    expect(service.hashRefreshToken(token)).toBe(service.hashRefreshToken(token));
  });

  it('в базу уезжает не сам токен', () => {
    // Иначе утечка базы означает вход в любой аккаунт без пароля.
    const service = makeService();
    const token = service.generateRefreshToken();

    expect(service.hashRefreshToken(token)).not.toBe(token);
  });
});
