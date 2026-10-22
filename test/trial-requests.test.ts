import { type INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { AuthModule } from '../src/features/auth/auth.module.js';
import { NotificationsModule } from '../src/features/notifications/notifications.module.js';
import { TrialRequestsModule } from '../src/features/trial-requests/trial-requests.module.js';
import { ConfigModule } from '../src/infra/config/config.module.js';
import { ENV, type Env } from '../src/infra/config/env.js';
import { PrismaModule } from '../src/infra/prisma/prisma.module.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';

/**
 * Заявки на пробную и уведомления через настоящее приложение: маршруты
 * закрыты токеном, тело проверяется контрактом, отказы — в формате ТС 7.8.
 * Сами правила — в юнит-тестах сервисов.
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

const USER_ID = '22222222-2222-4222-8222-222222222222';
const CLUB_ID = '11111111-1111-4111-8111-111111111111';
const COACH_ID = '33333333-3333-4333-8333-333333333333';
const TRAINING_ID = '44444444-4444-4444-8444-444444444444';
const REQUEST_ID = '55555555-5555-4555-8555-555555555555';
const CITY = '66666666-6666-4666-8666-666666666666';
const city = { id: CITY, name: 'Алматы', nameKk: null };

const training = {
  id: TRAINING_ID,
  author: 'COACH',
  coachId: COACH_ID,
  clubId: null,
  link: 'NONE',
  linkAt: null,
  booking: 'COACH',
  kind: 'GROUP',
  audiences: ['AMATEURS'],
  kidsFromAge: null,
  place: 'ONLINE',
  venueName: null,
  venueAddress: null,
  title: 'Группа',
  schedule: null,
  priceKzt: null,
  unit: 'MONTH',
  note: null,
  description: null,
  enrollment: null,
  slots: [],
  sortOrder: 0,
  createdAt: new Date('2026-10-20T00:00:00.000Z'),
  club: null,
  coach: {
    id: COACH_ID,
    slug: 'kim-sergey',
    userId: 'user-coach',
    photoUrl: null,
    phone: null,
    whatsapp: null,
    telegram: null,
    primaryContact: null,
    status: 'APPROVED',
    hiddenAt: null,
    player: {
      id: 'player-coach',
      lastName: 'Ким',
      firstName: 'Сергей',
      middleName: null,
      photoUrl: null,
      rating: { toString: () => '512.00' },
      isProvisional: false,
      city,
    },
  },
};

const request = {
  id: REQUEST_ID,
  status: 'NEW',
  userId: USER_ID,
  targetKind: 'COACH',
  coachId: COACH_ID,
  clubId: null,
  forWhom: 'SELF',
  childAge: null,
  preferredTime: null,
  comment: null,
  reply: null,
  source: 'ORGANIC',
  createdAt: new Date('2026-10-22T10:00:00.000Z'),
  answeredAt: null,
  training: { id: TRAINING_ID, title: 'Группа' },
  coach: {
    slug: 'kim-sergey',
    status: 'APPROVED',
    hiddenAt: null,
    id: COACH_ID,
    userId: 'user-coach',
    phone: null,
    whatsapp: null,
    player: { lastName: 'Ким', firstName: 'Сергей' },
  },
  club: null,
  user: { phone: '+77070000000', login: 'player', player: null },
};

function makePrisma() {
  const prisma = {
    training: { findUnique: vi.fn().mockResolvedValue(training) },
    coach: { findUnique: vi.fn().mockResolvedValue({ userId: 'user-coach' }) },
    clubMember: { findMany: vi.fn().mockResolvedValue([]) },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        phone: '+77070000000',
        login: 'player',
        player: null,
        isAdmin: false,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    trialRequest: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(request),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue(request),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    coachStatDaily: { upsert: vi.fn().mockResolvedValue({}) },
    clubStatDaily: { upsert: vi.fn().mockResolvedValue({}) },
    notification: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(),
  };

  prisma.$transaction.mockImplementation((run: (tx: typeof prisma) => unknown) => run(prisma));

  return prisma;
}

let app: INestApplication | undefined;
let prisma: ReturnType<typeof makePrisma>;
let root: string;
let token: string;

beforeEach(async () => {
  prisma = makePrisma();

  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule, PrismaModule, AuthModule, TrialRequestsModule, NotificationsModule],
  })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.listen(0);
  root = `${await app.getUrl()}/api/v1`;
  token = new JwtService({ secret: env.JWT_SECRET }).sign({ sub: USER_ID }, { expiresIn: 600 });
});

afterEach(async () => {
  await app?.close();
  vi.restoreAllMocks();
});

async function call(
  method: string,
  path: string,
  options: { body?: unknown; auth?: boolean } = {},
) {
  const response = await fetch(`${root}${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.auth === true ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
  };
}

const body = { forWhom: 'SELF', source: 'ORGANIC' };

describe('заявка на пробную', () => {
  it('все маршруты — только с токеном', async () => {
    const routes: [string, string][] = [
      ['POST', `/trainings/${TRAINING_ID}/trial-requests`],
      ['GET', '/me/trial-requests'],
      ['POST', `/trial-requests/${REQUEST_ID}/cancel`],
      ['POST', `/trial-requests/${REQUEST_ID}/answer`],
      ['GET', `/coaches/${COACH_ID}/trial-requests`],
      ['GET', `/coaches/${COACH_ID}/trial-requests/count`],
      ['GET', `/clubs/${CLUB_ID}/trial-requests`],
      ['GET', `/clubs/${CLUB_ID}/trial-requests/count`],
      ['GET', '/notifications'],
      ['GET', '/notifications/unread'],
      ['POST', '/notifications/read'],
    ];

    for (const [method, path] of routes) {
      const options = method === 'POST' ? { body: {} } : {};

      expect((await call(method, path, options)).status, `${method} ${path}`).toBe(401);
    }

    expect(prisma.trialRequest.create).not.toHaveBeenCalled();
  });

  it('отправка — 201 и заявка глазами отправителя', async () => {
    const result = await call('POST', `/trainings/${TRAINING_ID}/trial-requests`, {
      body,
      auth: true,
    });

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      id: REQUEST_ID,
      status: 'NEW',
      target: { kind: 'COACH', id: COACH_ID, name: 'Ким Сергей', slug: 'kim-sergey' },
    });
  });

  it('за ребёнка без возраста — 400, до базы не доходит', async () => {
    const result = await call('POST', `/trainings/${TRAINING_ID}/trial-requests`, {
      body: { forWhom: 'CHILD', source: 'ORGANIC' },
      auth: true,
    });

    expect(result.status).toBe(400);
    expect(prisma.training.findUnique).not.toHaveBeenCalled();
  });

  it('повтор — 409 TRIAL_REQUEST_EXISTS, предел — 409 TRIAL_REQUEST_LIMIT', async () => {
    prisma.trialRequest.findFirst.mockResolvedValueOnce({ id: REQUEST_ID });

    const repeat = await call('POST', `/trainings/${TRAINING_ID}/trial-requests`, {
      body,
      auth: true,
    });

    expect(repeat.status).toBe(409);
    expect(repeat.body).toMatchObject({ error: { code: 'TRIAL_REQUEST_EXISTS' } });

    prisma.trialRequest.count.mockResolvedValueOnce(100);

    const limit = await call('POST', `/trainings/${TRAINING_ID}/trial-requests`, {
      body,
      auth: true,
    });

    expect(limit.status).toBe(409);
    expect(limit.body).toMatchObject({
      error: { code: 'TRIAL_REQUEST_LIMIT', details: { max: 5 } },
    });
  });

  it('отзыв своей — 200, отвеченной — 409 TRIAL_REQUEST_INVALID', async () => {
    expect(
      (await call('POST', `/trial-requests/${REQUEST_ID}/cancel`, { auth: true })).status,
    ).toBe(200);

    prisma.trialRequest.findUnique.mockResolvedValue({ ...request, status: 'DECLINED' });

    const again = await call('POST', `/trial-requests/${REQUEST_ID}/cancel`, { auth: true });

    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      error: { code: 'TRIAL_REQUEST_INVALID', details: { status: 'DECLINED' } },
    });
  });

  it('ответ не адресатом — 403', async () => {
    const result = await call('POST', `/trial-requests/${REQUEST_ID}/answer`, {
      body: { status: 'ACCEPTED' },
      auth: true,
    });

    expect(result.status).toBe(403);
    expect(prisma.trialRequest.updateMany).not.toHaveBeenCalled();
  });

  it('входящие клуба постороннему — 403', async () => {
    const result = await call('GET', `/clubs/${CLUB_ID}/trial-requests`, { auth: true });

    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(prisma.trialRequest.findMany).not.toHaveBeenCalled();
  });

  it('входящие тренера владельцу страницы — 200', async () => {
    prisma.coach.findUnique.mockResolvedValue({ userId: USER_ID });

    const result = await call('GET', `/coaches/${COACH_ID}/trial-requests/count`, { auth: true });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ new: 0 });
  });
});

describe('уведомления', () => {
  it('список и число непрочитанных — свои', async () => {
    expect((await call('GET', '/notifications', { auth: true })).body).toMatchObject({
      items: [],
      total: 0,
    });
    expect((await call('GET', '/notifications/unread', { auth: true })).body).toEqual({
      unread: 0,
    });
    expect(prisma.notification.count.mock.calls[0]?.[0]).toMatchObject({
      where: { userId: USER_ID },
    });
  });

  it('отметка прочитанными — 204, кривые идентификаторы — 400', async () => {
    expect((await call('POST', '/notifications/read', { body: {}, auth: true })).status).toBe(204);
    expect(
      (await call('POST', '/notifications/read', { body: { ids: ['nope'] }, auth: true })).status,
    ).toBe(400);
    expect(prisma.notification.updateMany).toHaveBeenCalledOnce();
  });
});
