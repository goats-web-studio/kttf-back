import { TRIAL_REQUESTS_PER_DAY, type CreateTrialRequestInput } from '@kttf/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import type { TrainingRecord } from '../coaches/training-view.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { TrialRequestsService } from './trial-requests.service.js';

const CITY = '66666666-6666-4666-8666-666666666666';
const CLUB_ID = '77777777-7777-4777-8777-777777777777';
const COACH_ID = '11111111-1111-4111-8111-111111111111';
const TRAINING_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const PLAYER_ID = '44444444-4444-4444-8444-444444444444';
const city = { id: CITY, name: 'Алматы', nameKk: null };

const NOW = new Date('2026-10-22T19:30:00.000Z');
/** День по UTC+5: 19:30 UTC — уже 23 октября. */
const DAY = new Date('2026-10-23T00:00:00.000Z');

function makeClub(overrides: Record<string, unknown> = {}) {
  return {
    id: CLUB_ID,
    name: 'Спин',
    logoUrl: null,
    address: 'Абая 10',
    city,
    twoGisUrl: null,
    phone: '+77270000000',
    whatsapp: '+77010000001',
    telegram: null,
    primaryContact: 'WHATSAPP',
    hiddenAt: null,
    profileReviewedAt: null,
    ...overrides,
  };
}

function makeCoach(overrides: Record<string, unknown> = {}) {
  return {
    id: COACH_ID,
    slug: 'kim-sergey',
    userId: 'user-coach',
    photoUrl: null,
    phone: '+77010000000',
    whatsapp: '+77010000002',
    telegram: null,
    primaryContact: 'WHATSAPP',
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
    ...overrides,
  };
}

/** Строка тренировки, как её отдаёт выборка `trainingFields`. */
function makeTraining(overrides: Record<string, unknown> = {}): TrainingRecord {
  return {
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
    coach: makeCoach(),
    ...overrides,
  } as unknown as TrainingRecord;
}

/** Тренировка тренера в клубе KTTF, связь подтверждена. */
const inClub = (overrides: Record<string, unknown> = {}) =>
  makeTraining({
    place: 'CLUB',
    clubId: CLUB_ID,
    club: makeClub(),
    link: 'CONFIRMED',
    ...overrides,
  });

const coachTarget = {
  slug: 'kim-sergey',
  status: 'APPROVED',
  hiddenAt: null,
  id: COACH_ID,
  userId: 'user-coach',
  phone: '+77010000000',
  whatsapp: '+77010000002',
  player: { lastName: 'Ким', firstName: 'Сергей' },
};
const clubTarget = { id: CLUB_ID, name: 'Спин', phone: '+77270000000', whatsapp: '+77010000001' };

/** Заявка, как её отдаёт выборка `incomingTrialFields`. */
function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    status: 'NEW',
    userId: 'user-player',
    targetKind: 'COACH',
    coachId: COACH_ID,
    clubId: null,
    forWhom: 'CHILD',
    childAge: 9,
    preferredTime: 'будни после 18:00',
    comment: null,
    reply: null,
    source: 'CAMPAIGN',
    createdAt: NOW,
    answeredAt: null,
    training: { id: TRAINING_ID, title: 'Группа' },
    coach: coachTarget,
    club: null,
    user: {
      phone: '+77070000000',
      login: 'player',
      player: { id: PLAYER_ID, lastName: 'Иванов', firstName: 'Пётр' },
    },
    ...overrides,
  };
}

const asClub = {
  targetKind: 'CLUB',
  coachId: null,
  clubId: CLUB_ID,
  coach: null,
  club: clubTarget,
};

function makePrisma() {
  const prisma = {
    training: { findUnique: vi.fn().mockResolvedValue(makeTraining()) },
    coach: { findUnique: vi.fn().mockResolvedValue({ userId: 'user-coach' }) },
    clubMember: {
      findMany: vi.fn().mockResolvedValue([{ userId: 'user-owner' }, { userId: 'user-organizer' }]),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        phone: '+77070000000',
        login: 'player',
        isAdmin: false,
        player: { id: PLAYER_ID, lastName: 'Иванов', firstName: 'Пётр' },
      }),
    },
    trialRequest: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(makeRequest()),
      findMany: vi.fn().mockResolvedValue([makeRequest()]),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue(makeRequest()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    coachStatDaily: { upsert: vi.fn().mockResolvedValue({}) },
    clubStatDaily: { upsert: vi.fn().mockResolvedValue({}) },
    notification: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      updateMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(),
  };

  prisma.$transaction.mockImplementation((run: (tx: typeof prisma) => unknown) => run(prisma));

  return prisma;
}

let prisma: ReturnType<typeof makePrisma>;
let service: TrialRequestsService;

beforeEach(() => {
  prisma = makePrisma();
  const db = prisma as unknown as PrismaService;
  service = new TrialRequestsService(db, new NotificationsService(db));
});

const input: CreateTrialRequestInput = {
  forWhom: 'CHILD',
  childAge: 9,
  preferredTime: 'будни после 18:00',
  source: 'CAMPAIGN',
};

function notified() {
  return prisma.notification.createMany.mock.calls.map(
    (call: unknown[]) => (call[0] as { data: unknown }).data,
  );
}

describe('адресат заявки', () => {
  it('своя тренировка тренера — тренеру: заявка, строка статистики, уведомление', async () => {
    const view = await service.create(TRAINING_ID, 'user-player', input, NOW);

    expect(prisma.trialRequest.create.mock.calls[0]?.[0]).toMatchObject({
      data: {
        trainingId: TRAINING_ID,
        userId: 'user-player',
        targetKind: 'COACH',
        coachId: COACH_ID,
        clubId: null,
        forWhom: 'CHILD',
        childAge: 9,
        preferredTime: 'будни после 18:00',
        comment: null,
        source: 'CAMPAIGN',
      },
    });
    expect(prisma.coachStatDaily.upsert).toHaveBeenCalledWith({
      where: { coachId_date_source: { coachId: COACH_ID, date: DAY, source: 'CAMPAIGN' } },
      create: { coachId: COACH_ID, date: DAY, source: 'CAMPAIGN', trialRequests: 1 },
      update: { trialRequests: { increment: 1 } },
    });
    expect(prisma.clubStatDaily.upsert).not.toHaveBeenCalled();
    expect(notified()).toEqual([
      [
        {
          userId: 'user-coach',
          type: 'TRIAL_REQUEST_NEW',
          data: {
            trialRequestId: REQUEST_ID,
            trainingTitle: 'Группа',
            requesterName: 'Иванов Пётр',
            inbox: { kind: 'COACH', id: COACH_ID, name: 'Ким Сергей' },
          },
        },
      ],
    ]);
    expect(view.target).toEqual({
      kind: 'COACH',
      id: COACH_ID,
      name: 'Ким Сергей',
      slug: 'kim-sergey',
      phone: '+77010000000',
      whatsapp: '+77010000002',
    });
  });

  it('тренировка тренера в клубе с записью у тренера — тренеру', async () => {
    prisma.training.findUnique.mockResolvedValue(inClub({ booking: 'COACH' }));

    await service.create(TRAINING_ID, 'user-player', input, NOW);

    expect(prisma.trialRequest.create.mock.calls[0]?.[0]).toMatchObject({
      data: { targetKind: 'COACH', coachId: COACH_ID, clubId: null },
    });
  });

  it('тренировка тренера с записью через клуб — клубу: OWNER и ORGANIZER', async () => {
    prisma.training.findUnique.mockResolvedValue(inClub({ booking: 'CLUB' }));
    prisma.trialRequest.create.mockResolvedValue(makeRequest(asClub));

    const view = await service.create(TRAINING_ID, 'user-player', input, NOW);

    expect(prisma.trialRequest.create.mock.calls[0]?.[0]).toMatchObject({
      data: { targetKind: 'CLUB', coachId: null, clubId: CLUB_ID },
    });
    expect(prisma.clubMember.findMany).toHaveBeenCalledWith({
      where: { clubId: CLUB_ID, role: { in: ['OWNER', 'ORGANIZER'] } },
      select: { userId: true },
    });
    expect(prisma.clubStatDaily.upsert).toHaveBeenCalledWith({
      where: { clubId_date_source: { clubId: CLUB_ID, date: DAY, source: 'CAMPAIGN' } },
      create: { clubId: CLUB_ID, date: DAY, source: 'CAMPAIGN', trialRequests: 1 },
      update: { trialRequests: { increment: 1 } },
    });
    expect(prisma.coachStatDaily.upsert).not.toHaveBeenCalled();

    const rows = notified()[0] as { userId: string; data: { inbox: unknown } }[];

    expect(rows.map((row) => row.userId)).toEqual(['user-owner', 'user-organizer']);
    expect(rows[0]?.data.inbox).toEqual({ kind: 'CLUB', id: CLUB_ID, name: 'Спин' });
    expect(view.target).toMatchObject({ kind: 'CLUB', id: CLUB_ID, slug: null });
  });

  it('группа клуба — клубу, даже если в строке записан тренер', async () => {
    prisma.training.findUnique.mockResolvedValue(
      inClub({ author: 'CLUB', booking: 'COACH', link: 'NONE' }),
    );
    prisma.trialRequest.create.mockResolvedValue(makeRequest(asClub));

    await service.create(TRAINING_ID, 'user-player', input, NOW);

    expect(prisma.trialRequest.create.mock.calls[0]?.[0]).toMatchObject({
      data: { targetKind: 'CLUB', clubId: CLUB_ID },
    });
  });
});

describe('отказы при отправке', () => {
  it('непубличная тренировка — NOT_FOUND, как чужой адрес', async () => {
    const hidden = [
      makeTraining({ coach: makeCoach({ status: 'PENDING' }) }),
      makeTraining({ coach: makeCoach({ hiddenAt: new Date() }) }),
      inClub({ link: 'PENDING' }),
      inClub({ author: 'CLUB', club: makeClub({ hiddenAt: new Date() }) }),
      null,
    ];

    for (const training of hidden) {
      prisma.training.findUnique.mockResolvedValueOnce(training);

      await expect(service.create(TRAINING_ID, 'user-player', input, NOW)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    }

    expect(prisma.trialRequest.create).not.toHaveBeenCalled();
  });

  it('тренер себе — FORBIDDEN', async () => {
    await expect(service.create(TRAINING_ID, 'user-coach', input, NOW)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(prisma.trialRequest.create).not.toHaveBeenCalled();
  });

  it('OWNER или ORGANIZER клуба своему клубу — FORBIDDEN', async () => {
    prisma.training.findUnique.mockResolvedValue(inClub({ author: 'CLUB' }));

    await expect(service.create(TRAINING_ID, 'user-organizer', input, NOW)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(prisma.trialRequest.create).not.toHaveBeenCalled();
  });

  it('двойное нажатие: вторая заявка под замком видит первую — TRIAL_REQUEST_EXISTS', async () => {
    prisma.trialRequest.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: REQUEST_ID });

    await expect(service.create(TRAINING_ID, 'user-player', input, NOW)).rejects.toMatchObject({
      code: 'TRIAL_REQUEST_EXISTS',
    });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.trialRequest.create).not.toHaveBeenCalled();
  });

  it('новая заявка на ту же тренировку уже есть — TRIAL_REQUEST_EXISTS', async () => {
    prisma.trialRequest.findFirst.mockResolvedValue({ id: REQUEST_ID });

    await expect(service.create(TRAINING_ID, 'user-player', input, NOW)).rejects.toMatchObject({
      code: 'TRIAL_REQUEST_EXISTS',
    });
    expect(prisma.trialRequest.findFirst).toHaveBeenCalledWith({
      where: { trainingId: TRAINING_ID, userId: 'user-player', status: 'NEW' },
      select: { id: true },
    });
    expect(prisma.trialRequest.create).not.toHaveBeenCalled();
  });

  it('предел за сутки — TRIAL_REQUEST_LIMIT с величиной предела', async () => {
    prisma.trialRequest.count.mockResolvedValue(TRIAL_REQUESTS_PER_DAY);

    await expect(service.create(TRAINING_ID, 'user-player', input, NOW)).rejects.toMatchObject({
      code: 'TRIAL_REQUEST_LIMIT',
      details: { max: TRIAL_REQUESTS_PER_DAY },
    });
    expect(prisma.trialRequest.count).toHaveBeenCalledWith({
      where: {
        userId: 'user-player',
        createdAt: { gte: new Date('2026-10-21T19:30:00.000Z') },
      },
    });
    expect(prisma.trialRequest.create).not.toHaveBeenCalled();
  });

  it('последняя заявка в пределе проходит', async () => {
    prisma.trialRequest.count.mockResolvedValue(TRIAL_REQUESTS_PER_DAY - 1);

    await expect(service.create(TRAINING_ID, 'user-player', input, NOW)).resolves.toMatchObject({
      id: REQUEST_ID,
    });
  });

  it('имя отправителя без профиля — логин, без логина — телефон', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      phone: '+77070000000',
      login: 'petya',
      player: null,
    });
    await service.create(TRAINING_ID, 'user-player', input, NOW);

    prisma.user.findUnique.mockResolvedValueOnce({
      phone: '+77070000000',
      login: null,
      player: null,
    });
    await service.create(TRAINING_ID, 'user-player', input, NOW);

    const names = notified().map(
      (rows) => (rows as { data: { requesterName: string } }[])[0]?.data.requesterName,
    );

    expect(names).toEqual(['petya', '+77070000000']);
  });
});

describe('отзыв заявки', () => {
  it('отправитель отзывает новую — адресату уведомление', async () => {
    prisma.trialRequest.findUnique
      .mockResolvedValueOnce(makeRequest())
      .mockResolvedValueOnce(makeRequest({ status: 'CANCELLED' }));

    const view = await service.cancel(REQUEST_ID, 'user-player');

    expect(prisma.trialRequest.updateMany).toHaveBeenCalledWith({
      where: { id: REQUEST_ID, status: 'NEW' },
      data: { status: 'CANCELLED' },
    });
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: {
        type: 'TRIAL_REQUEST_NEW',
        readAt: null,
        data: { path: ['trialRequestId'], equals: REQUEST_ID },
      },
      data: { readAt: expect.any(Date) as Date },
    });
    expect(notified()).toEqual([
      [
        {
          userId: 'user-coach',
          type: 'TRIAL_REQUEST_CANCELLED',
          data: {
            trialRequestId: REQUEST_ID,
            trainingTitle: 'Группа',
            requesterName: 'Иванов Пётр',
            inbox: { kind: 'COACH', id: COACH_ID, name: 'Ким Сергей' },
          },
        },
      ],
    ]);
    expect(view.status).toBe('CANCELLED');
    expect(view).not.toHaveProperty('requester');
  });

  it('чужую — FORBIDDEN, даже адресату', async () => {
    await expect(service.cancel(REQUEST_ID, 'user-coach')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(prisma.trialRequest.updateMany).not.toHaveBeenCalled();
  });

  it('уже отвеченную — TRIAL_REQUEST_INVALID с текущим статусом', async () => {
    prisma.trialRequest.findUnique.mockResolvedValue(makeRequest({ status: 'ACCEPTED' }));

    await expect(service.cancel(REQUEST_ID, 'user-player')).rejects.toMatchObject({
      code: 'TRIAL_REQUEST_INVALID',
      details: { status: 'ACCEPTED' },
    });
    expect(prisma.trialRequest.updateMany).not.toHaveBeenCalled();
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });

  it('ответ пришёл между чтением и отзывом — тоже TRIAL_REQUEST_INVALID', async () => {
    prisma.trialRequest.updateMany.mockResolvedValue({ count: 0 });
    prisma.trialRequest.findUnique
      .mockResolvedValueOnce(makeRequest())
      .mockResolvedValueOnce({ status: 'DECLINED' });

    await expect(service.cancel(REQUEST_ID, 'user-player')).rejects.toMatchObject({
      code: 'TRIAL_REQUEST_INVALID',
      details: { status: 'DECLINED' },
    });
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });

  it('несуществующая — NOT_FOUND', async () => {
    prisma.trialRequest.findUnique.mockResolvedValue(null);

    await expect(service.cancel(REQUEST_ID, 'user-player')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('ответ на заявку', () => {
  it('тренер принимает — отправителю уведомление с его именем', async () => {
    const answered = new Date('2026-10-23T05:00:00.000Z');

    prisma.trialRequest.findUnique
      .mockResolvedValueOnce(makeRequest())
      .mockResolvedValueOnce(
        makeRequest({ status: 'ACCEPTED', reply: 'Ждём в субботу', answeredAt: answered }),
      );

    const view = await service.answer(
      REQUEST_ID,
      'user-coach',
      { status: 'ACCEPTED', reply: 'Ждём в субботу' },
      answered,
    );

    expect(prisma.trialRequest.updateMany).toHaveBeenCalledWith({
      where: { id: REQUEST_ID, status: 'NEW' },
      data: {
        status: 'ACCEPTED',
        reply: 'Ждём в субботу',
        answeredAt: answered,
        answeredById: 'user-coach',
      },
    });
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: {
        type: 'TRIAL_REQUEST_NEW',
        readAt: null,
        data: { path: ['trialRequestId'], equals: REQUEST_ID },
      },
      data: { readAt: answered },
    });
    expect(notified()).toEqual([
      [
        {
          userId: 'user-player',
          type: 'TRIAL_REQUEST_ANSWERED',
          data: {
            trialRequestId: REQUEST_ID,
            trainingTitle: 'Группа',
            status: 'ACCEPTED',
            targetName: 'Ким Сергей',
          },
        },
      ],
    ]);
    expect(view).toMatchObject({
      status: 'ACCEPTED',
      reply: 'Ждём в субботу',
      answeredAt: answered.toISOString(),
      requester: { name: 'Иванов Пётр', phone: '+77070000000', playerId: PLAYER_ID },
      source: 'CAMPAIGN',
    });
  });

  it('ORGANIZER клуба отклоняет — от имени клуба', async () => {
    prisma.trialRequest.findUnique.mockResolvedValue(makeRequest(asClub));

    await service.answer(REQUEST_ID, 'user-organizer', { status: 'DECLINED' }, NOW);

    expect(prisma.trialRequest.updateMany.mock.calls[0]?.[0]).toMatchObject({
      data: { status: 'DECLINED', reply: null, answeredById: 'user-organizer' },
    });
    expect(notified()[0]).toMatchObject([
      { userId: 'user-player', data: { status: 'DECLINED', targetName: 'Спин' } },
    ]);
  });

  it('не адресат — FORBIDDEN: ни отправитель, ни администратор', async () => {
    prisma.user.findUnique.mockResolvedValue({ isAdmin: true });

    for (const userId of ['user-player', 'user-admin']) {
      await expect(
        service.answer(REQUEST_ID, userId, { status: 'ACCEPTED' }, NOW),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }

    expect(prisma.trialRequest.updateMany).not.toHaveBeenCalled();
  });

  it('не новую — TRIAL_REQUEST_INVALID', async () => {
    prisma.trialRequest.findUnique.mockResolvedValue(makeRequest({ status: 'CANCELLED' }));

    await expect(
      service.answer(REQUEST_ID, 'user-coach', { status: 'ACCEPTED' }, NOW),
    ).rejects.toMatchObject({ code: 'TRIAL_REQUEST_INVALID', details: { status: 'CANCELLED' } });
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });
});

describe('списки заявок', () => {
  const query = { page: 1, limit: 20 };

  it('свои — только свои, новые первыми, без отправителя в ответе', async () => {
    prisma.trialRequest.count.mockResolvedValue(1);

    const page = await service.listMine('user-player', { ...query, status: 'NEW' });

    expect(prisma.trialRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-player', status: 'NEW' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 0,
        take: 20,
      }),
    );
    expect(page).toMatchObject({ total: 1, page: 1, limit: 20 });
    expect(page.items[0]).not.toHaveProperty('requester');
  });

  it('входящие тренера — владельцу страницы, с отправителем', async () => {
    const page = await service.incoming({ kind: 'COACH', id: COACH_ID }, 'user-coach', query);

    expect(prisma.trialRequest.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { coachId: COACH_ID },
    });
    expect(page.items[0]?.requester).toEqual({
      name: 'Иванов Пётр',
      phone: '+77070000000',
      playerId: PLAYER_ID,
    });
  });

  it('входящие клуба — OWNER и ORGANIZER, администратору тоже', async () => {
    await service.incoming({ kind: 'CLUB', id: CLUB_ID }, 'user-owner', query);

    prisma.user.findUnique.mockResolvedValue({ isAdmin: true });
    await service.incoming({ kind: 'CLUB', id: CLUB_ID }, 'user-admin', query);

    expect(prisma.trialRequest.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.trialRequest.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { clubId: CLUB_ID },
    });
  });

  it('посторонний — FORBIDDEN, и к числу новых тоже', async () => {
    await expect(
      service.incoming({ kind: 'CLUB', id: CLUB_ID }, 'user-player', query),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      service.count({ kind: 'COACH', id: COACH_ID }, 'user-player'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Несуществующая страница — тот же отказ.
    prisma.coach.findUnique.mockResolvedValue(null);
    await expect(
      service.incoming({ kind: 'COACH', id: COACH_ID }, 'user-coach', query),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(prisma.trialRequest.findMany).not.toHaveBeenCalled();
  });

  it('число новых — только NEW своего ящика', async () => {
    prisma.trialRequest.count.mockResolvedValue(3);

    await expect(service.count({ kind: 'CLUB', id: CLUB_ID }, 'user-owner')).resolves.toEqual({
      new: 3,
    });
    expect(prisma.trialRequest.count).toHaveBeenCalledWith({
      where: { clubId: CLUB_ID, status: 'NEW' },
    });
  });
});
