import { isAppError } from '@kttf/shared/errors';
import { JwtService } from '@nestjs/jwt';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { CODE_MAX_ATTEMPTS, CODE_REQUESTS_PER_HOUR, SESSION_TTL_MS } from './auth.constants.js';
import { AuthService } from './auth.service.js';
import type { CodeSender } from './code-sender.js';
import { TokenService } from './token.service.js';

const SECRET = 'test_secret_at_least_32_characters_long';

const account = {
  id: 'user-1',
  phone: '+70000000000',
  email: null,
  locale: 'RU',
  createdAt: new Date('2026-08-29T00:00:00.000Z'),
  player: null,
  clubRoles: [],
};

function makePrisma() {
  const prisma = {
    authCode: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({ id: 'code-1' }),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    user: {
      upsert: vi.fn().mockResolvedValue(account),
      findUnique: vi.fn().mockResolvedValue(account),
    },
    session: {
      create: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: vi.fn(),
  };

  prisma.$transaction.mockImplementation((run: (tx: typeof prisma) => unknown) => run(prisma));

  return prisma;
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  const sent: { phone: string; code: string }[] = [];
  const sender: CodeSender = {
    send: (phone, code) => {
      sent.push({ phone, code });
      return Promise.resolve();
    },
  };

  const tokens = new TokenService(
    {
      NODE_ENV: 'test',
      PORT: 3000,
      DATABASE_URL: 'postgresql://x',
      JWT_SECRET: SECRET,
      AUTH_CODE_SECRET: 'code_secret_at_least_32_characters!!',
    },
    new JwtService({ secret: SECRET }),
  );

  const service = new AuthService(prisma as unknown as PrismaService, tokens, sender);

  return { service, tokens, sent };
}

describe('requestCode', () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('отправляет код и сохраняет его хеш', async () => {
    const { service, tokens, sent } = makeService(prisma);

    await service.requestCode('+70000000000');

    expect(sent).toHaveLength(1);
    const stored = prisma.authCode.create.mock.calls[0]?.[0] as {
      data: { codeHash: string; phone: string };
    };
    expect(stored.data.phone).toBe('+70000000000');
    expect(tokens.matchesCode(sent[0]?.code ?? '', stored.data.codeHash)).toBe(true);
  });

  it('сам код в базу не попадает', async () => {
    // Иначе утечка базы отдаёт действующие коды в открытом виде.
    const { service, sent } = makeService(prisma);

    await service.requestCode('+70000000000');

    const stored = JSON.stringify(prisma.authCode.create.mock.calls[0]?.[0]);
    expect(stored).not.toContain(sent[0]?.code);
  });

  it('отказывает после пяти запросов в час — ТС 8.3', async () => {
    prisma.authCode.count.mockResolvedValue(CODE_REQUESTS_PER_HOUR);
    const { service, sent } = makeService(prisma);

    await expect(service.requestCode('+70000000000')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(sent).toHaveLength(0);
    expect(prisma.authCode.create).not.toHaveBeenCalled();
  });

  it('на границе лимита ещё пропускает', async () => {
    prisma.authCode.count.mockResolvedValue(CODE_REQUESTS_PER_HOUR - 1);
    const { service } = makeService(prisma);

    await expect(service.requestCode('+70000000000')).resolves.toMatchObject({
      expiresInSeconds: 300,
    });
  });
});

describe('verifyCode', () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
  });

  function armCode(tokens: TokenService, code: string, attempts = 0) {
    prisma.authCode.findFirst.mockResolvedValue({
      id: 'code-1',
      phone: '+70000000000',
      codeHash: tokens.hashCode(code),
      attempts,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
    });
  }

  it('верный код заводит сессию и возвращает пользователя', async () => {
    const { service, tokens } = makeService(prisma);
    armCode(tokens, '123456');

    const result = await service.verifyCode('+70000000000', '123456', 'vitest');

    expect(tokens.verifyAccessToken(result.accessToken)).toBe('user-1');
    expect(result.user).toMatchObject({ id: 'user-1', phone: '+70000000000', playerId: null });
    expect(prisma.session.create).toHaveBeenCalledOnce();
  });

  it('в сессию уезжает хеш refresh-токена, а не он сам', async () => {
    const { service, tokens } = makeService(prisma);
    armCode(tokens, '123456');

    const result = await service.verifyCode('+70000000000', '123456');

    const created = prisma.session.create.mock.calls[0]?.[0] as {
      data: { refreshToken: string; expiresAt: Date };
    };
    expect(created.data.refreshToken).toBe(tokens.hashRefreshToken(result.refreshToken));
    expect(created.data.refreshToken).not.toBe(result.refreshToken);
  });

  it('сессия живёт 90 дней — ТЗ 2.1', async () => {
    const { service, tokens } = makeService(prisma);
    armCode(tokens, '123456');

    const before = Date.now();
    await service.verifyCode('+70000000000', '123456');

    const created = prisma.session.create.mock.calls[0]?.[0] as { data: { expiresAt: Date } };
    // Окно, а не точное значение: между снимком времени и вычислением срока
    // проходит сколько-то миллисекунд, и точное сравнение мигает.
    const lifetime = created.data.expiresAt.getTime() - before;
    expect(lifetime).toBeGreaterThanOrEqual(SESSION_TTL_MS);
    expect(lifetime).toBeLessThan(SESSION_TTL_MS + 5_000);
  });

  it('код гасится в той же транзакции, что и создание сессии', async () => {
    // Иначе отказ посередине оставляет либо погашенный код без входа, либо
    // действующий код после входа.
    const { service, tokens } = makeService(prisma);
    armCode(tokens, '123456');

    await service.verifyCode('+70000000000', '123456');

    expect(prisma.$transaction).toHaveBeenCalledOnce();

    const update = prisma.authCode.update.mock.calls[0]?.[0] as {
      where: { id: string };
      data: { usedAt: Date };
    };
    expect(update.where.id).toBe('code-1');
    expect(update.data.usedAt).toBeInstanceOf(Date);
  });

  it('первый вход заводит аккаунт, повторный — нет', async () => {
    const { service, tokens } = makeService(prisma);
    armCode(tokens, '123456');

    await service.verifyCode('+70000000000', '123456');

    // upsert покрывает оба случая одним запросом и не даёт гонке породить
    // второй аккаунт на тот же телефон — ТЗ 2.1, один телефон = один аккаунт.
    expect(prisma.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { phone: '+70000000000' } }),
    );
  });

  it('без кода в базе — отказ', async () => {
    const { service } = makeService(prisma);

    await expect(service.verifyCode('+70000000000', '123456')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('неверный код считает попытку и не пускает', async () => {
    const { service, tokens } = makeService(prisma);
    armCode(tokens, '123456');

    await expect(service.verifyCode('+70000000000', '000000')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(prisma.authCode.update).toHaveBeenCalledWith({
      where: { id: 'code-1' },
      data: { attempts: { increment: 1 } },
    });
    expect(prisma.session.create).not.toHaveBeenCalled();
  });

  it('после пяти попыток код мёртв даже при верном вводе', async () => {
    // Без этого шестизначный код перебирается за время его жизни.
    const { service, tokens } = makeService(prisma);
    armCode(tokens, '123456', CODE_MAX_ATTEMPTS);

    await expect(service.verifyCode('+70000000000', '123456')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(prisma.session.create).not.toHaveBeenCalled();
  });

  it('ищет только непогашенные и неистёкшие коды', async () => {
    const { service } = makeService(prisma);

    await expect(service.verifyCode('+70000000000', '123456')).rejects.toThrow();

    const query = prisma.authCode.findFirst.mock.calls[0]?.[0] as {
      where: { usedAt: null; expiresAt: { gt: Date } };
    };
    expect(query.where.usedAt).toBeNull();
    expect(query.where.expiresAt.gt).toBeInstanceOf(Date);
  });
});

describe('refresh', () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('выдаёт новую пару и продлевает сессию', async () => {
    const { service, tokens } = makeService(prisma);
    const token = tokens.generateRefreshToken();
    prisma.session.findUnique.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 1000),
    });

    const result = await service.refresh(token, 'vitest');

    expect(tokens.verifyAccessToken(result.accessToken)).toBe('user-1');
    expect(result.refreshToken).not.toBe(token);
  });

  it('старый токен перестаёт работать: в базе лежит хеш нового', async () => {
    // Ротация нужна не только ради продления: украденный токен умирает при
    // первом же обновлении настоящим владельцем.
    const { service, tokens } = makeService(prisma);
    prisma.session.findUnique.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 1000),
    });

    const result = await service.refresh(tokens.generateRefreshToken());

    const updated = prisma.session.update.mock.calls[0]?.[0] as {
      data: { refreshToken: string };
    };
    expect(updated.data.refreshToken).toBe(tokens.hashRefreshToken(result.refreshToken));
  });

  it('сессию ищет по хешу, а не по самому токену', async () => {
    const { service, tokens } = makeService(prisma);
    const token = tokens.generateRefreshToken();

    await expect(service.refresh(token)).rejects.toThrow();

    expect(prisma.session.findUnique).toHaveBeenCalledWith({
      where: { refreshToken: tokens.hashRefreshToken(token) },
    });
  });

  it('неизвестный токен — отказ', async () => {
    const { service } = makeService(prisma);

    await expect(service.refresh('нет такого')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('истёкшая сессия — отказ', async () => {
    const { service } = makeService(prisma);
    prisma.session.findUnique.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(service.refresh('что-то')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(prisma.session.update).not.toHaveBeenCalled();
  });
});

describe('logout и me', () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('выход удаляет сессию по хешу и молчит, если её нет', async () => {
    const { service, tokens } = makeService(prisma);
    const token = tokens.generateRefreshToken();

    await expect(service.logout(token)).resolves.toBeUndefined();

    expect(prisma.session.deleteMany).toHaveBeenCalledWith({
      where: { refreshToken: tokens.hashRefreshToken(token) },
    });
  });

  it('me отдаёт профиль', async () => {
    const { service } = makeService(prisma);

    await expect(service.findUser('user-1')).resolves.toMatchObject({ id: 'user-1' });
  });

  it('me отказывает, если пользователя больше нет', async () => {
    // Токен подписан нами и ещё действителен, а аккаунт удалён.
    prisma.user.findUnique.mockResolvedValue(null);
    const { service } = makeService(prisma);

    await service.findUser('user-1').then(
      () => expect.unreachable('ожидался отказ'),
      (error: unknown) => {
        expect(isAppError(error) && error.code).toBe('UNAUTHORIZED');
      },
    );
  });
});
