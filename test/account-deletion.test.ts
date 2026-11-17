import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { AccountDeletionService } from '../src/features/account/account-deletion.service.js';
import { AccountController } from '../src/features/account/account.controller.js';
import { AuthModule } from '../src/features/auth/auth.module.js';
import { TokenService } from '../src/features/auth/token.service.js';
import { ConfigModule } from '../src/infra/config/config.module.js';
import { ENV, type Env } from '../src/infra/config/env.js';
import { PrismaModule } from '../src/infra/prisma/prisma.module.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';

/**
 * `POST /auth/delete-account` — ADR-092, через настоящие маршрут, guard,
 * схему и фильтр ошибок. Сама очистка проверяется юнит-тестами сервиса.
 */
const env: Env = {
  NODE_ENV: 'test',
  PORT: 0,
  DATABASE_URL: 'postgresql://x',
  JWT_SECRET: 'test_secret_at_least_32_characters_long',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'kttf-media',
  S3_REGION: 'us-east-1',
};

let app: INestApplication | undefined;
let base: string;
let token: string;
const deletion = { deleteAccount: vi.fn() };

beforeEach(async () => {
  deletion.deleteAccount.mockReset().mockResolvedValue(undefined);

  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule, PrismaModule, AuthModule],
    controllers: [AccountController],
    providers: [{ provide: AccountDeletionService, useValue: deletion }],
  })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(PrismaService)
    .useValue({ user: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) } })
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.listen(0);
  base = `${await app.getUrl()}/api/v1/auth`;
  token = moduleRef.get(TokenService).issueAccessToken('user-1');
});

afterEach(async () => {
  await app?.close();
});

async function remove(body: unknown, bearer?: string) {
  const response = await fetch(`${base}/delete-account`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
  };
}

describe('POST /auth/delete-account', () => {
  it('удаляет вошедшего и отвечает 204 без тела', async () => {
    const result = await remove({ password: 'parol123' }, token);

    expect(result.status).toBe(204);
    expect(deletion.deleteAccount).toHaveBeenCalledWith(
      'user-1',
      { password: 'parol123' },
      expect.any(String),
    );
  });

  it('без токена — 401, до сервиса не доходит', async () => {
    const result = await remove({ password: 'parol123' });

    expect(result.status).toBe(401);
    expect(deletion.deleteAccount).not.toHaveBeenCalled();
  });

  it('без пароля — 400', async () => {
    const result = await remove({}, token);

    expect(result.status).toBe(400);
    expect(deletion.deleteAccount).not.toHaveBeenCalled();
  });

  it('неверный пароль — 403 WRONG_PASSWORD, не 401', async () => {
    deletion.deleteAccount.mockRejectedValue(
      new AppError(ERROR_CODES.WRONG_PASSWORD, 'Password is wrong'),
    );

    const result = await remove({ password: 'chuzhoi1' }, token);

    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: { code: 'WRONG_PASSWORD' } });
  });

  it('последний владелец клуба — 409 с причиной', async () => {
    deletion.deleteAccount.mockRejectedValue(
      new AppError(ERROR_CODES.ACCOUNT_DELETE_BLOCKED, 'Last owner', {
        reason: 'LAST_CLUB_OWNER',
        clubIds: ['club-1'],
      }),
    );

    const result = await remove({ password: 'parol123' }, token);

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({
      error: { code: 'ACCOUNT_DELETE_BLOCKED', details: { reason: 'LAST_CLUB_OWNER' } },
    });
  });
});
