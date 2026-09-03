import { JwtService } from '@nestjs/jwt';
import { describe, expect, it } from 'vitest';

import { ACCESS_TOKEN_TTL_SECONDS } from './auth.constants.js';
import { TokenService } from './token.service.js';

const SECRET = 'test_secret_at_least_32_characters_long';

function makeService(): TokenService {
  return new TokenService(
    {
      NODE_ENV: 'test',
      PORT: 3000,
      DATABASE_URL: 'postgresql://x',
      JWT_SECRET: SECRET,
      S3_ENDPOINT: 'http://localhost:9000',
      S3_BUCKET: 'kttf-media',
      S3_REGION: 'us-east-1',
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
        S3_ENDPOINT: 'http://localhost:9000',
        S3_BUCKET: 'kttf-media',
        S3_REGION: 'us-east-1',
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
