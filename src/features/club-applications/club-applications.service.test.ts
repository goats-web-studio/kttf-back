import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../infra/config/env.js';
import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { APPLICATIONS_PER_HOUR, ClubApplicationsService } from './club-applications.service.js';
import { clientIp } from '../../common/client-ip.js';

const INPUT = {
  name: 'Арман',
  contact: '+7 701 123 45 67',
  clubName: 'Спин',
  city: 'Караганда',
};

const row = {
  id: '00000000-0000-4000-8000-000000000001',
  ...INPUT,
  address: null,
  tableCount: 6,
  tournaments: null,
  message: null,
  status: 'NEW' as const,
  userId: null,
  createdAt: new Date('2026-10-18T10:00:00.000Z'),
  handledAt: null,
};

function makePrisma() {
  return {
    clubApplication: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue(row),
      findMany: vi.fn().mockResolvedValue([row]),
      findUnique: vi.fn().mockResolvedValue({ id: row.id }),
      update: vi.fn().mockResolvedValue(row),
    },
  };
}

const env = { JWT_SECRET: 'x'.repeat(32) } as Env;

let prisma: ReturnType<typeof makePrisma>;

/** Что ушло в базу n-м вызовом: `data` у create и update. */
interface Written {
  readonly ipHash: string;
  readonly handledAt: Date | null;
}

function dataOf(mock: { mock: { calls: unknown[][] } }, index: number): Written {
  return (mock.mock.calls[index]?.[0] as { data: Written }).data;
}
let service: ClubApplicationsService;

beforeEach(() => {
  prisma = makePrisma();
  service = new ClubApplicationsService(prisma as unknown as PrismaService, env);
});

describe('приём заявки', () => {
  it('сохраняет заявку и привязывает вошедшего', async () => {
    await service.create({ ...INPUT, tableCount: 6 }, 'user-1', '10.0.0.1');

    expect(prisma.clubApplication.create.mock.calls[0]?.[0]).toMatchObject({
      data: { ...INPUT, tableCount: 6, address: null, userId: 'user-1' },
    });
  });

  it('адрес не хранится — только ключевой хэш', async () => {
    await service.create(INPUT, undefined, '10.0.0.1');

    const data = dataOf(prisma.clubApplication.create, 0);

    expect(data.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(data)).not.toContain('10.0.0.1');
  });

  it('один адрес — один хэш, другой адрес — другой', async () => {
    await service.create(INPUT, undefined, '10.0.0.1');
    await service.create(INPUT, undefined, '10.0.0.1');
    await service.create(INPUT, undefined, '10.0.0.2');

    const hashes = [0, 1, 2].map((index) => dataOf(prisma.clubApplication.create, index).ipHash);

    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[0]).not.toBe(hashes[2]);
  });

  it('заполненная ловушка — молча не сохраняется', async () => {
    await expect(
      service.create({ ...INPUT, website: 'spam.example' }, undefined, '10.0.0.1'),
    ).resolves.toBeUndefined();

    expect(prisma.clubApplication.create).not.toHaveBeenCalled();
  });

  it(`больше ${String(APPLICATIONS_PER_HOUR)} за час с адреса — RATE_LIMITED`, async () => {
    prisma.clubApplication.count.mockResolvedValue(APPLICATIONS_PER_HOUR);

    await expect(service.create(INPUT, undefined, '10.0.0.1')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(prisma.clubApplication.create).not.toHaveBeenCalled();
  });
});

describe('разбор у администратора', () => {
  it('свежие сверху, постранично, даты строкой', async () => {
    const page = await service.list({ page: 2, limit: 10, status: 'NEW' });

    expect(prisma.clubApplication.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { status: 'NEW' },
      orderBy: { createdAt: 'desc' },
      skip: 10,
      take: 10,
    });
    expect(page.items[0]?.createdAt).toBe('2026-10-18T10:00:00.000Z');
  });

  it('обработано — с отметкой времени, вернули в новые — без неё', async () => {
    await service.update(row.id, { status: 'DONE' });
    await service.update(row.id, { status: 'NEW' });

    const done = dataOf(prisma.clubApplication.update, 0);
    const back = dataOf(prisma.clubApplication.update, 1);

    expect(done.handledAt).toBeInstanceOf(Date);
    expect(back.handledAt).toBeNull();
  });

  it('несуществующая — NOT_FOUND', async () => {
    prisma.clubApplication.findUnique.mockResolvedValue(null);

    await expect(service.update(row.id, { status: 'DONE' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('адрес за прокси', () => {
  const socket = { remoteAddress: '172.18.0.5' } as never;

  it('последний в X-Forwarded-For — его дописал Caddy', () => {
    expect(clientIp({ headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }, socket })).toBe(
      '203.0.113.7',
    );
  });

  it('без заголовка — адрес соединения', () => {
    expect(clientIp({ headers: {}, socket })).toBe('172.18.0.5');
  });
});
