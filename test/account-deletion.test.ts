import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { AccountRequestsService } from '../src/features/account/account-requests.service.js';
import {
  AccountController,
  AccountRequestsAdminController,
} from '../src/features/account/account.controller.js';
import { AuthModule } from '../src/features/auth/auth.module.js';
import { TokenService } from '../src/features/auth/token.service.js';
import { ConfigModule } from '../src/infra/config/config.module.js';
import { ENV, type Env } from '../src/infra/config/env.js';
import { PrismaModule } from '../src/infra/prisma/prisma.module.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';

/**
 * Заявки на удаление и восстановление — ADR-095, через настоящие маршруты,
 * guard'ы, схемы и фильтр ошибок. Сама работа проверяется юнит-тестами
 * сервисов.
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

const REQUEST_ID = '0b9a8c2e-3c1f-4e8a-9d55-6f0e1a2b3c4d';
const VIEW = {
  id: REQUEST_ID,
  kind: 'DELETE',
  status: 'PENDING',
  createdAt: '2026-11-18T10:00:00.000Z',
  decidedAt: null,
  answer: null,
};

let app: INestApplication | undefined;
let base: string;
let userToken: string;
let adminToken: string;
const requests = {
  requestDeletion: vi.fn(),
  cancelDeletion: vi.fn(),
  status: vi.fn(),
  requestRestore: vi.fn(),
  list: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
};

beforeEach(async () => {
  for (const mock of Object.values(requests)) mock.mockReset();
  requests.requestDeletion.mockResolvedValue(VIEW);
  requests.cancelDeletion.mockResolvedValue(undefined);
  requests.list.mockResolvedValue([]);
  requests.approve.mockResolvedValue({ ...VIEW, status: 'APPROVED' });

  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule, PrismaModule, AuthModule],
    controllers: [AccountController, AccountRequestsAdminController],
    providers: [{ provide: AccountRequestsService, useValue: requests }],
  })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(PrismaService)
    .useValue({
      user: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn(({ where }: { where: { id: string } }) =>
          Promise.resolve({ isAdmin: where.id === 'admin-1' }),
        ),
      },
    })
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.listen(0);
  base = `${await app.getUrl()}/api/v1`;
  userToken = moduleRef.get(TokenService).issueAccessToken('user-1');
  adminToken = moduleRef.get(TokenService).issueAccessToken('admin-1');
});

afterEach(async () => {
  await app?.close();
});

async function call(method: string, path: string, body?: unknown, bearer?: string) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
  };
}

describe('POST /account/deletion-request', () => {
  it('заводит заявку и отвечает 201 с ней', async () => {
    const result = await call(
      'POST',
      '/account/deletion-request',
      { password: 'parol123', reason: 'Ухожу' },
      userToken,
    );

    expect(result.status).toBe(201);
    expect(result.body).toEqual(VIEW);
    expect(requests.requestDeletion).toHaveBeenCalledWith(
      'user-1',
      { password: 'parol123', reason: 'Ухожу' },
      expect.any(String),
    );
  });

  it('без токена — 401, до сервиса не доходит', async () => {
    const result = await call('POST', '/account/deletion-request', { password: 'parol123' });

    expect(result.status).toBe(401);
    expect(requests.requestDeletion).not.toHaveBeenCalled();
  });

  it('без пароля — 400', async () => {
    const result = await call('POST', '/account/deletion-request', {}, userToken);

    expect(result.status).toBe(400);
    expect(requests.requestDeletion).not.toHaveBeenCalled();
  });

  it('неверный пароль — 403 WRONG_PASSWORD, не 401', async () => {
    requests.requestDeletion.mockRejectedValue(
      new AppError(ERROR_CODES.WRONG_PASSWORD, 'Password is wrong'),
    );

    const result = await call('POST', '/account/deletion-request', { password: 'x' }, userToken);

    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: { code: 'WRONG_PASSWORD' } });
  });

  it('вторая ожидающая — 409 ACCOUNT_REQUEST_PENDING', async () => {
    requests.requestDeletion.mockRejectedValue(
      new AppError(ERROR_CODES.ACCOUNT_REQUEST_PENDING, 'Request already pending'),
    );

    const result = await call(
      'POST',
      '/account/deletion-request',
      { password: 'parol123' },
      userToken,
    );

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: { code: 'ACCOUNT_REQUEST_PENDING' } });
  });
});

describe('прочие маршруты аккаунта', () => {
  it('DELETE /account/deletion-request — 204', async () => {
    const result = await call('DELETE', '/account/deletion-request', undefined, userToken);

    expect(result.status).toBe(204);
    expect(requests.cancelDeletion).toHaveBeenCalledWith('user-1');
  });

  it('POST /account/restore-request без имени — 400', async () => {
    const result = await call(
      'POST',
      '/account/restore-request',
      { lastName: 'Иванов' },
      userToken,
    );

    expect(result.status).toBe(400);
    expect(requests.requestRestore).not.toHaveBeenCalled();
  });

  it('POST /account/restore-request с подтверждённым профилем — 409 HAS_PROFILE', async () => {
    requests.requestRestore.mockRejectedValue(
      new AppError(ERROR_CODES.ACCOUNT_RESTORE_INVALID, 'Cannot restore', {
        reason: 'HAS_PROFILE',
      }),
    );

    const result = await call(
      'POST',
      '/account/restore-request',
      { lastName: 'Иванов', firstName: 'Пётр' },
      userToken,
    );

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({
      error: { code: 'ACCOUNT_RESTORE_INVALID', details: { reason: 'HAS_PROFILE' } },
    });
  });

  it('POST /auth/delete-account больше нет — 404', async () => {
    const result = await call('POST', '/auth/delete-account', { password: 'parol123' }, userToken);

    expect(result.status).toBe(404);
  });
});

describe('/admin/account-requests', () => {
  it('не администратор — 403, до сервиса не доходит', async () => {
    const list = await call('GET', '/admin/account-requests', undefined, userToken);
    const approve = await call(
      'POST',
      `/admin/account-requests/${REQUEST_ID}/approve`,
      undefined,
      userToken,
    );

    expect(list.status).toBe(403);
    expect(approve.status).toBe(403);
    expect(requests.list).not.toHaveBeenCalled();
    expect(requests.approve).not.toHaveBeenCalled();
  });

  it('администратор видит список с фильтром по статусу', async () => {
    const result = await call(
      'GET',
      '/admin/account-requests?status=PENDING',
      undefined,
      adminToken,
    );

    expect(result.status).toBe(200);
    expect(requests.list).toHaveBeenCalledWith({ status: 'PENDING' });
  });

  it('одобрение — 200 с заявкой', async () => {
    const result = await call(
      'POST',
      `/admin/account-requests/${REQUEST_ID}/approve`,
      undefined,
      adminToken,
    );

    expect(result.status).toBe(200);
    expect(requests.approve).toHaveBeenCalledWith(REQUEST_ID, 'admin-1');
  });

  it('последний владелец клуба при одобрении — 409 ACCOUNT_DELETE_BLOCKED', async () => {
    requests.approve.mockRejectedValue(
      new AppError(ERROR_CODES.ACCOUNT_DELETE_BLOCKED, 'Last owner', {
        reason: 'LAST_CLUB_OWNER',
        clubIds: ['club-1'],
      }),
    );

    const result = await call(
      'POST',
      `/admin/account-requests/${REQUEST_ID}/approve`,
      undefined,
      adminToken,
    );

    expect(result.status).toBe(409);
  });

  it('отказ без ответа — 400', async () => {
    const result = await call(
      'POST',
      `/admin/account-requests/${REQUEST_ID}/reject`,
      {},
      adminToken,
    );

    expect(result.status).toBe(400);
    expect(requests.reject).not.toHaveBeenCalled();
  });
});
