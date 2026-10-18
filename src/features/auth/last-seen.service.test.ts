import type { ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { LastSeenInterceptor } from './last-seen.interceptor.js';
import { LastSeenService } from './last-seen.service.js';

const MINUTE = 60_000;
const START = new Date('2026-10-19T12:00:00.000Z');
const at = (minutes: number) => new Date(START.getTime() + minutes * MINUTE);

let updateMany: ReturnType<typeof vi.fn>;
let service: LastSeenService;

beforeEach(() => {
  updateMany = vi.fn().mockResolvedValue({ count: 1 });
  service = new LastSeenService({ user: { updateMany } } as unknown as PrismaService);
});

describe('последнее посещение', () => {
  it('пишется не чаще раза в пять минут', async () => {
    await service.touch('u1', at(0));
    await service.touch('u1', at(1));
    await service.touch('u1', at(4.9));

    expect(updateMany).toHaveBeenCalledTimes(1);

    await service.touch('u1', at(5));

    expect(updateMany).toHaveBeenCalledTimes(2);
  });

  it('у каждого пользователя свой шаг', async () => {
    await service.touch('u1', at(0));
    await service.touch('u2', at(1));

    expect(updateMany).toHaveBeenCalledTimes(2);
  });

  it('шаг держит и сама база: после перезапуска API лишней записи нет', async () => {
    await service.touch('u1', at(10));

    // Пишем только тем, у кого отметки нет или она старше окна.
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'u1',
        OR: [{ lastSeenAt: null }, { lastSeenAt: { lte: at(5) } }],
      },
      data: { lastSeenAt: at(10) },
    });
  });

  it('сбой записи не роняет запрос, и следующий запрос пробует снова', async () => {
    updateMany.mockRejectedValueOnce(new Error('база недоступна'));

    await expect(service.touch('u1', at(0))).resolves.toBeUndefined();
    await service.touch('u1', at(1));

    expect(updateMany).toHaveBeenCalledTimes(2);
  });
});

describe('перехватчик посещения', () => {
  const context = (userId: string | undefined) =>
    ({
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => ({ userId }) }),
    }) as unknown as ExecutionContext;

  it('отмечает запрос с проверенным токеном и не ждёт записи', () => {
    const touch = vi.fn().mockResolvedValue(undefined);
    const interceptor = new LastSeenInterceptor({ touch } as unknown as LastSeenService);

    interceptor.intercept(context('u1'), { handle: () => of('ответ') });

    expect(touch).toHaveBeenCalledWith('u1');
  });

  it('анонимный запрос не трогает', () => {
    const touch = vi.fn();
    const interceptor = new LastSeenInterceptor({ touch } as unknown as LastSeenService);

    interceptor.intercept(context(undefined), { handle: () => of('ответ') });

    expect(touch).not.toHaveBeenCalled();
  });
});
