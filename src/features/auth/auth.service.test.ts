import { isAppError } from '@kttf/shared/errors';
import { JwtService } from '@nestjs/jwt';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { SESSION_TTL_MS } from './auth.constants.js';
import { AuthService } from './auth.service.js';
import { hashPassword } from './password.js';
import { TokenService } from './token.service.js';

/**
 * Вход и регистрация — ТЗ 2.1, ADR-034.
 *
 * Проверяется не только удачный путь: отказ обязан выглядеть одинаково для
 * незнакомого логина и для неверного пароля, иначе форма входа превращается
 * в проверку, есть ли такой человек на платформе.
 */

const SECRET = 'test_secret_at_least_32_characters_long';
const PASSWORD = 'parol123';

const account = {
  id: 'user-1',
  phone: '+70000000000',
  login: 'aslan',
  passwordHash: hashPassword(PASSWORD),
  email: null,
  locale: 'RU',
  createdAt: new Date('2026-08-29T00:00:00.000Z'),
  player: null,
  clubRoles: [],
};

function makePrisma() {
  const prisma = {
    user: {
      create: vi.fn().mockResolvedValue(account),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(account),
    },
    player: {
      findUnique: vi.fn().mockResolvedValue({ userId: null }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
  const tokens = new TokenService(
    {
      NODE_ENV: 'test',
      PORT: 3000,
      DATABASE_URL: 'postgresql://x',
      JWT_SECRET: SECRET,
    },
    new JwtService({ secret: SECRET }),
  );

  const service = new AuthService(prisma as unknown as PrismaService, tokens);

  return { service, tokens };
}

describe('вход', () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('пускает по логину и заводит сессию', async () => {
    const { service } = makeService(prisma);

    const session = await service.login({ identifier: 'aslan', password: PASSWORD });

    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { login: 'aslan' } }),
    );
    expect(session.user.id).toBe('user-1');
    expect(prisma.session.create).toHaveBeenCalledOnce();
  });

  it('телефон узнаётся по формату, а не по отдельному полю', async () => {
    const { service } = makeService(prisma);

    await service.login({ identifier: '+70000000000', password: PASSWORD });

    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { phone: '+70000000000' } }),
    );
  });

  it('неверный пароль и неизвестный логин отвергаются одинаково', async () => {
    const { service } = makeService(prisma);

    const wrongPassword = await service
      .login({ identifier: 'aslan', password: 'ne-parol' })
      .catch((error: unknown) => error);

    prisma.user.findUnique.mockResolvedValue(null);
    const unknownLogin = await service
      .login({ identifier: 'kto-to', password: PASSWORD })
      .catch((error: unknown) => error);

    if (!isAppError(wrongPassword) || !isAppError(unknownLogin)) {
      throw new Error('ожидались доменные ошибки');
    }

    expect(wrongPassword.code).toBe('UNAUTHORIZED');
    expect(unknownLogin.code).toBe('UNAUTHORIZED');
    expect(unknownLogin.message).toBe(wrongPassword.message);
  });

  it('аккаунт без пароля войти не даёт', async () => {
    // Заведён до перехода на пароль (ADR-034): пароля нет, входа нет.
    prisma.user.findUnique.mockResolvedValue({ ...account, passwordHash: null });
    const { service } = makeService(prisma);

    await expect(service.login({ identifier: 'aslan', password: PASSWORD })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(prisma.session.create).not.toHaveBeenCalled();
  });

  it('сессия живёт 90 дней — ТЗ 2.1', async () => {
    const { service } = makeService(prisma);

    await service.login({ identifier: 'aslan', password: PASSWORD });

    const created = prisma.session.create.mock.calls[0]?.[0] as { data: { expiresAt: Date } };
    const days = (created.data.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);

    expect(Math.round(days)).toBe(Math.round(SESSION_TTL_MS / (24 * 60 * 60 * 1000)));
  });
});

describe('регистрация', () => {
  let prisma: ReturnType<typeof makePrisma>;
  const input = { login: 'aslan', password: PASSWORD, phone: '+70000000000' };

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('заводит аккаунт и сразу входит', async () => {
    const { service } = makeService(prisma);

    const session = await service.signUp(input);

    expect(session.accessToken).not.toBe('');
    expect(prisma.session.create).toHaveBeenCalledOnce();
  });

  it('пароль в базу открытым не попадает', async () => {
    const { service } = makeService(prisma);

    await service.signUp(input);

    const stored = JSON.stringify(prisma.user.create.mock.calls[0]?.[0]);
    expect(stored).not.toContain(PASSWORD);
  });

  it('занятый телефон или логин называет поле', async () => {
    prisma.user.findFirst.mockResolvedValue({ phone: '+70000000000', login: 'drugoi' });
    const { service } = makeService(prisma);

    await expect(service.signUp(input)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { field: 'phone' },
    });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('привязывает к игроку, заведённому тренером', async () => {
    const { service } = makeService(prisma);

    const session = await service.signUp({ ...input, playerId: 'player-1' });

    expect(prisma.player.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'player-1', userId: null } }),
    );
    expect(session.user.playerId).toBe('player-1');
  });

  it('чужого игрока занять нельзя', async () => {
    prisma.player.findUnique.mockResolvedValue({ userId: 'user-2' });
    const { service } = makeService(prisma);

    await expect(service.signUp({ ...input, playerId: 'player-1' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { field: 'playerId' },
    });
  });

  it('игрока, занятого между проверкой и записью, тоже не отдаёт', async () => {
    // Гонка: проверка прошла, а привязать уже некого.
    prisma.player.updateMany.mockResolvedValue({ count: 0 });
    const { service } = makeService(prisma);

    await expect(service.signUp({ ...input, playerId: 'player-1' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
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
