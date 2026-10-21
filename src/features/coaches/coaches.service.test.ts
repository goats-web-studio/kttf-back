import { coachCredentialFilePath } from '@kttf/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { PlacesService } from '../places/places.service.js';
import { CoachesService, keptVerification } from './coaches.service.js';

const COACH_ID = '11111111-1111-4111-8111-111111111111';
const DOC_ID = '22222222-2222-4222-8222-222222222222';
const SCAN = '/api/v1/files/coach-docs/33333333-3333-4333-8333-333333333333.webp';
const OWNER_ID = 'user-owner';
const CLUB_ID = '77777777-7777-4777-8777-777777777777';
const VERIFIED = new Date('2026-10-01T00:00:00.000Z');

const city = { id: 'city-1', name: 'Алматы', nameKk: null };

const credential = {
  id: DOC_ID,
  kind: 'CERTIFICATE' as const,
  title: 'Курс ITTF Level 1',
  issuer: 'ITTF',
  year: 2019,
  fileKey: SCAN,
  filePublic: false,
  verifiedAt: VERIFIED,
};

function makeCoach(overrides: Record<string, unknown> = {}) {
  return {
    id: COACH_ID,
    slug: 'kim-sergey',
    playerId: 'player-1',
    userId: OWNER_ID,
    player: {
      id: 'player-1',
      lastName: 'Ким',
      firstName: 'Сергей',
      middleName: null,
      photoUrl: null,
      rating: { toString: () => '512.00' },
      isProvisional: false,
      city,
    },
    status: 'APPROVED',
    rejectReason: 'Нет фото',
    reviewedAt: null,
    submittedAt: null,
    hiddenAt: null,
    hiddenReason: null,
    headline: null,
    about: null,
    photoUrl: null,
    coverUrl: null,
    coachingSince: 2015,
    city,
    formats: [],
    visitAreas: null,
    languages: ['KK', 'RU'],
    phone: null,
    whatsapp: null,
    telegram: null,
    instagram: null,
    primaryContact: null,
    sportsRank: 'KMS',
    coachCategory: null,
    refereeCategory: null,
    education: null,
    plan: 'FREE',
    profileReviewedAt: null,
    createdAt: new Date('2026-10-20T00:00:00.000Z'),
    trainings: [],
    credentials: [
      credential,
      { ...credential, id: 'doc-public', filePublic: true },
      { ...credential, id: 'doc-empty', fileKey: null },
    ],
    achievements: [],
    clubLinks: [],
    ...overrides,
  };
}

/** Тренировка в выборке страницы — тренер в ней тот же. */
function makeTraining(overrides: Record<string, unknown> = {}) {
  return {
    id: 'training-1',
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
    sortOrder: 0,
    createdAt: new Date('2026-10-20T00:00:00.000Z'),
    club: null,
    coach: {
      id: COACH_ID,
      slug: 'kim-sergey',
      userId: OWNER_ID,
      photoUrl: null,
      phone: null,
      whatsapp: null,
      telegram: null,
      primaryContact: null,
      status: 'APPROVED',
      hiddenAt: null,
      player: {
        id: 'player-1',
        lastName: 'Ким',
        firstName: 'Сергей',
        middleName: null,
        photoUrl: null,
        rating: { toString: () => '512.00' },
        isProvisional: false,
        city,
      },
    },
    ...overrides,
  };
}

function makePrisma() {
  return {
    coach: {
      findUnique: vi.fn().mockResolvedValue(makeCoach()),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(makeCoach({ status: 'DRAFT' })),
      update: vi.fn().mockResolvedValue(makeCoach()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    training: {
      deleteMany: vi.fn().mockReturnValue('deleteMany'),
      createMany: vi.fn().mockReturnValue('createMany'),
    },
    club: { findMany: vi.fn().mockResolvedValue([{ id: CLUB_ID }]) },
    clubCoach: {
      createMany: vi.fn().mockReturnValue('staff-create'),
      updateMany: vi.fn().mockReturnValue('staff-update'),
    },
    coachCredential: {
      deleteMany: vi.fn().mockReturnValue('deleteMany'),
      createMany: vi.fn().mockReturnValue('createMany'),
      findFirst: vi.fn(),
    },
    coachAchievement: {
      deleteMany: vi.fn().mockReturnValue('deleteMany'),
      createMany: vi.fn().mockReturnValue('createMany'),
    },
    player: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'player-1',
        lastName: 'Ким',
        firstName: 'Сергей',
        cityId: 'city-1',
        coachPage: null,
      }),
      groupBy: vi.fn().mockResolvedValue([{ coachPlayerId: 'player-1', _count: { _all: 24 } }]),
    },
    user: { findUnique: vi.fn().mockResolvedValue({ isAdmin: false }) },
    city: { findFirst: vi.fn().mockResolvedValue({ id: 'city-2' }) },
    // Третья операция списка — свежесть страницы: её результат — страница.
    $transaction: vi.fn((operations: unknown[]) =>
      Promise.resolve(
        operations.map((operation, index) => (index === 2 ? makeCoach() : operation)),
      ),
    ),
  };
}

let prisma: ReturnType<typeof makePrisma>;
let service: CoachesService;

beforeEach(() => {
  prisma = makePrisma();
  const db = prisma as unknown as PrismaService;
  service = new CoachesService(db, new PlacesService(db));
});

/** Что ушло в `createMany` документов. */
function writtenCredentials(): Record<string, unknown>[] {
  const call = prisma.coachCredential.createMany.mock.calls[0]?.[0] as {
    data: Record<string, unknown>[];
  };

  return call.data;
}

describe('заведение страницы', () => {
  it('без профиля игрока — FORBIDDEN', async () => {
    prisma.player.findUnique.mockResolvedValue(null);

    await expect(service.create(OWNER_ID)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(prisma.coach.create).not.toHaveBeenCalled();
  });

  it('вторая страница — COACH_ALREADY_EXISTS', async () => {
    prisma.player.findUnique.mockResolvedValue({
      id: 'player-1',
      lastName: 'Ким',
      firstName: 'Сергей',
      cityId: 'city-1',
      coachPage: { id: COACH_ID },
    });

    await expect(service.create(OWNER_ID)).rejects.toMatchObject({
      code: 'COACH_ALREADY_EXISTS',
    });
  });

  it('черновик с городом игрока и адресом латиницей', async () => {
    const view = await service.create(OWNER_ID);

    expect(prisma.coach.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { playerId: 'player-1', userId: OWNER_ID, slug: 'kim-sergey', cityId: 'city-1' },
      }),
    );
    expect(view.status).toBe('DRAFT');
    expect(view.studentsCount).toBe(24);
  });

  it('занятый адрес получает суффикс', async () => {
    prisma.coach.findMany.mockResolvedValue([{ slug: 'kim-sergey' }, { slug: 'kim-sergey-2' }]);

    await service.create(OWNER_ID);

    expect(prisma.coach.create.mock.calls[0]?.[0]).toMatchObject({
      data: { slug: 'kim-sergey-3' },
    });
  });

  it('гонка двух нажатий — тот же отказ, а не 500', async () => {
    prisma.coach.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '7' }),
    );

    await expect(service.create(OWNER_ID)).rejects.toMatchObject({
      code: 'COACH_ALREADY_EXISTS',
    });
  });
});

describe('публичная страница', () => {
  it('опубликованную видит аноним — без причины отказа и путей загрузки', async () => {
    const view = await service.findBySlug('kim-sergey', undefined);

    expect(view.rejectReason).toBeNull();
    expect(view.credentials.map((doc) => doc.file)).toEqual([null, null, null]);
    expect(view.credentials.map((doc) => doc.hasFile)).toEqual([true, true, false]);
    // Скан открыт только с галочкой «показывать скан».
    expect(view.credentials.map((doc) => doc.fileUrl)).toEqual([
      null,
      coachCredentialFilePath(COACH_ID, 'doc-public'),
      null,
    ]);
    expect(view.credentials[0]?.verifiedAt).toBe(VERIFIED.toISOString());
  });

  it('владелец видит причину отказа, пути загрузки и непубличные сканы', async () => {
    const view = await service.findBySlug('kim-sergey', OWNER_ID);

    expect(view.rejectReason).toBe('Нет фото');
    expect(view.credentials[0]).toMatchObject({
      file: SCAN,
      fileUrl: coachCredentialFilePath(COACH_ID, DOC_ID),
    });
  });

  it('неопубликованную постороннему не показать — NOT_FOUND', async () => {
    for (const overrides of [
      { status: 'DRAFT' },
      { status: 'PENDING' },
      { status: 'REJECTED' },
      { status: 'APPROVED', hiddenAt: new Date() },
    ]) {
      prisma.coach.findUnique.mockResolvedValue(makeCoach(overrides));

      await expect(service.findBySlug('kim-sergey', undefined)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(service.findBySlug('kim-sergey', 'user-stranger')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    }
  });

  it('неопубликованную видят владелец и администратор', async () => {
    prisma.coach.findUnique.mockResolvedValue(makeCoach({ status: 'PENDING' }));

    await expect(service.findBySlug('kim-sergey', OWNER_ID)).resolves.toMatchObject({
      status: 'PENDING',
    });

    prisma.user.findUnique.mockResolvedValue({ isAdmin: true });

    await expect(service.findBySlug('kim-sergey', 'user-admin')).resolves.toMatchObject({
      status: 'PENDING',
      rejectReason: 'Нет фото',
    });
  });
});

describe('правка страницы', () => {
  it('ставит свежесть и не трогает статус', async () => {
    prisma.coach.findUnique.mockResolvedValue({ cityId: 'city-1' });

    await service.update(COACH_ID, { headline: 'Детский тренер', about: null });

    const data = (prisma.coach.update.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;

    expect(data).toMatchObject({ headline: 'Детский тренер', about: null });
    expect(data.profileReviewedAt).toBeInstanceOf(Date);
    expect(data).not.toHaveProperty('status');
  });

  it('скрытый или неизвестный город — CITY_UNAVAILABLE', async () => {
    prisma.coach.findUnique.mockResolvedValue({ cityId: 'city-1' });
    prisma.city.findFirst.mockResolvedValue(null);

    await expect(service.update(COACH_ID, { cityId: crypto.randomUUID() })).rejects.toMatchObject({
      code: 'CITY_UNAVAILABLE',
    });
    expect(prisma.coach.update).not.toHaveBeenCalled();
  });

  it('несуществующая страница — NOT_FOUND', async () => {
    prisma.coach.findUnique.mockResolvedValue(null);

    await expect(service.update(COACH_ID, { headline: 'x' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('свои тренировки тренера', () => {
  const at = new Date('2026-10-19T00:00:00.000Z');
  const id = '88888888-8888-4888-8888-888888888888';
  const row = {
    kind: 'GROUP' as const,
    audiences: ['AMATEURS' as const],
    title: 'Группа',
    unit: 'MONTH' as const,
  };

  function stored(trainings: Record<string, unknown>[]) {
    prisma.coach.findUnique.mockResolvedValue({ plan: 'FREE', trainings });
  }

  function written(): Record<string, unknown>[] {
    return (prisma.training.createMany.mock.calls[0]?.[0] as { data: Record<string, unknown>[] })
      .data;
  }

  it('правит только свои строки; порядок — sortOrder, пустое — null', async () => {
    stored([]);

    await service.setTrainings(COACH_ID, {
      trainings: [
        { ...row, place: 'ONLINE', title: 'А' },
        { ...row, place: 'VISIT', title: 'Б', priceKzt: 8_000 },
      ],
    });

    expect(prisma.training.deleteMany).toHaveBeenCalledWith({
      where: { coachId: COACH_ID, author: 'COACH' },
    });
    expect(
      written().map((training) => [training.title, training.sortOrder, training.priceKzt]),
    ).toEqual([
      ['А', 0, null],
      ['Б', 1, 8_000],
    ]);
    expect(written()[0]).toMatchObject({ author: 'COACH', coachId: COACH_ID, link: 'NONE' });
  });

  it('клуб KTTF — ждёт подтверждения клуба; зал по адресу, выезд и онлайн — без связи', async () => {
    stored([]);

    await service.setTrainings(COACH_ID, {
      trainings: [
        { ...row, place: 'CLUB', clubId: CLUB_ID },
        { ...row, place: 'CLUB', venueName: 'Школа №5', venueAddress: 'Сатпаева 1' },
        { ...row, place: 'VISIT' },
      ],
    });

    expect(written().map((training) => [training.clubId, training.link])).toEqual([
      [CLUB_ID, 'PENDING'],
      [null, 'NONE'],
      [null, 'NONE'],
    ]);
    expect(written()[1]).toMatchObject({ venueName: 'Школа №5', venueAddress: 'Сатпаева 1' });
  });

  it('тот же id и тот же клуб сохраняют связь, включая отказ', async () => {
    stored([{ id, clubId: CLUB_ID, link: 'DECLINED', linkAt: at, createdAt: at }]);

    await service.setTrainings(COACH_ID, {
      trainings: [{ ...row, id, place: 'CLUB', clubId: CLUB_ID }],
    });

    expect(written()[0]).toMatchObject({ id, link: 'DECLINED', linkAt: at, createdAt: at });
  });

  it('смена клуба — снова ожидание; без клуба — связи нет', async () => {
    stored([{ id, clubId: 'club-old', link: 'CONFIRMED', linkAt: at, createdAt: at }]);

    await service.setTrainings(COACH_ID, {
      trainings: [{ ...row, id, place: 'CLUB', clubId: CLUB_ID }],
    });

    expect(written()[0]).toMatchObject({ id, link: 'PENDING', linkAt: null });

    prisma.training.createMany.mockClear();
    stored([{ id, clubId: CLUB_ID, link: 'CONFIRMED', linkAt: at, createdAt: at }]);

    await service.setTrainings(COACH_ID, { trainings: [{ ...row, id, place: 'ONLINE' }] });

    expect(written()[0]).toMatchObject({ id, clubId: null, link: 'NONE', linkAt: null });
  });

  it('кто записывает: в клубе KTTF — как выбрал тренер, без клуба — всегда тренер', async () => {
    stored([]);

    await service.setTrainings(COACH_ID, {
      trainings: [
        { ...row, place: 'CLUB', clubId: CLUB_ID, booking: 'CLUB' },
        { ...row, place: 'CLUB', clubId: CLUB_ID },
        { ...row, place: 'CLUB', venueName: 'Школа №5', venueAddress: 'Сатпаева 1' },
        { ...row, place: 'ONLINE' },
      ],
    });

    expect(written().map((training) => training.booking)).toEqual([
      'CLUB',
      'COACH',
      'COACH',
      'COACH',
    ]);
  });

  it('чужой id — новая строка', async () => {
    stored([]);

    await service.setTrainings(COACH_ID, { trainings: [{ ...row, id, place: 'ONLINE' }] });

    expect(written()[0]).not.toHaveProperty('id');
  });

  it('скрытый или неизвестный клуб — VALIDATION_FAILED с полем', async () => {
    stored([]);
    prisma.club.findMany.mockResolvedValue([]);

    await expect(
      service.setTrainings(COACH_ID, {
        trainings: [
          { ...row, place: 'ONLINE' },
          { ...row, place: 'CLUB', clubId: CLUB_ID },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { field: 'trainings.1.clubId' },
    });
    expect(prisma.training.createMany).not.toHaveBeenCalled();
  });
});

describe('документы и отметка «проверено KTTF»', () => {
  const stored = {
    id: DOC_ID,
    title: credential.title,
    issuer: credential.issuer,
    year: credential.year,
    fileKey: SCAN,
    verifiedAt: VERIFIED,
  };

  beforeEach(() => {
    prisma.coach.findUnique.mockResolvedValue({ plan: 'FREE', credentials: [stored] });
  });

  const row = {
    id: DOC_ID,
    kind: 'CERTIFICATE' as const,
    title: credential.title,
    issuer: credential.issuer,
    year: credential.year,
    file: SCAN,
  };

  it('документ без изменений сохраняет запись и отметку', async () => {
    await service.setCredentials(COACH_ID, { credentials: [{ ...row, filePublic: true }] });

    expect(writtenCredentials()).toEqual([
      expect.objectContaining({ id: DOC_ID, verifiedAt: VERIFIED, filePublic: true }),
    ]);
  });

  it('другое название, год или скан — отметка снимается', async () => {
    for (const change of [
      { title: 'Другой курс' },
      { issuer: null },
      { year: 2020 },
      { file: '/api/v1/files/coach-docs/44444444-4444-4444-8444-444444444444.webp' },
    ]) {
      prisma.coachCredential.createMany.mockClear();

      await service.setCredentials(COACH_ID, { credentials: [{ ...row, ...change }] });

      expect(writtenCredentials()[0]).toMatchObject({ id: DOC_ID, verifiedAt: null });
    }
  });

  it('чужой или неизвестный id — новый документ без отметки', async () => {
    await service.setCredentials(COACH_ID, {
      credentials: [{ ...row, id: '55555555-5555-4555-8555-555555555555' }],
    });

    const [written] = writtenCredentials();

    expect(written).not.toHaveProperty('id');
    expect(written).not.toHaveProperty('verifiedAt');
    expect(written).toMatchObject({ coachId: COACH_ID, filePublic: false, sortOrder: 0 });
  });

  it('отсутствующие в списке удаляются', async () => {
    await service.setCredentials(COACH_ID, { credentials: [] });

    expect(prisma.coachCredential.deleteMany).toHaveBeenCalledWith({
      where: { coachId: COACH_ID },
    });
    expect(writtenCredentials()).toEqual([]);
  });

  it('правило отметки — чистая функция', () => {
    const next = { title: stored.title, issuer: stored.issuer, year: stored.year, fileKey: SCAN };

    expect(keptVerification(stored, next)).toBe(VERIFIED);
    expect(keptVerification(stored, { ...next, fileKey: null })).toBeNull();
    expect(keptVerification({ ...stored, verifiedAt: null }, next)).toBeNull();
  });
});

describe('отправка на проверку', () => {
  const online = makeTraining();

  it('из черновика и после отказа — PENDING, отметка времени, причина стёрта', async () => {
    for (const status of ['DRAFT', 'REJECTED']) {
      prisma.coach.findUnique.mockResolvedValueOnce(makeCoach({ status, trainings: [online] }));
      const now = new Date('2026-10-20T12:00:00.000Z');

      await service.submit(COACH_ID, now);

      expect(prisma.coach.updateMany).toHaveBeenLastCalledWith({
        where: { id: COACH_ID, status: { in: ['DRAFT', 'REJECTED'] } },
        data: { status: 'PENDING', submittedAt: now, rejectReason: null },
      });
    }
  });

  it('тренировка в клубе, который ещё не ответил, тоже считается', async () => {
    prisma.coach.findUnique.mockResolvedValueOnce(
      makeCoach({
        status: 'DRAFT',
        trainings: [makeTraining({ place: 'CLUB', clubId: CLUB_ID, link: 'PENDING' })],
      }),
    );

    await expect(service.submit(COACH_ID)).resolves.toBeDefined();
  });

  it('уже отправленную или одобренную — COACH_STATUS_INVALID со статусом', async () => {
    for (const status of ['PENDING', 'APPROVED']) {
      prisma.coach.findUnique.mockResolvedValueOnce(makeCoach({ status, trainings: [online] }));

      await expect(service.submit(COACH_ID)).rejects.toMatchObject({
        code: 'COACH_STATUS_INVALID',
        details: { status },
      });
    }

    expect(prisma.coach.updateMany).not.toHaveBeenCalled();
  });

  it('без города и тренировок — COACH_INCOMPLETE со списком', async () => {
    prisma.coach.findUnique.mockResolvedValueOnce(makeCoach({ status: 'DRAFT', city: null }));

    await expect(service.submit(COACH_ID)).rejects.toMatchObject({
      code: 'COACH_INCOMPLETE',
      details: { missing: ['city', 'trainings'] },
    });
  });

  it('клубная тренировка без ответа тренера — не его тренировка', async () => {
    prisma.coach.findUnique.mockResolvedValueOnce(
      makeCoach({
        status: 'DRAFT',
        trainings: [
          makeTraining({ author: 'CLUB', place: 'CLUB', clubId: CLUB_ID, link: 'PENDING' }),
        ],
      }),
    );

    await expect(service.submit(COACH_ID)).rejects.toMatchObject({
      code: 'COACH_INCOMPLETE',
      details: { missing: ['trainings'] },
    });
  });
});

describe('штаб на странице тренера (T2)', () => {
  const clubRef = (overrides: Record<string, unknown> = {}) => ({
    id: CLUB_ID,
    name: 'Спин',
    logoUrl: null,
    address: null,
    city,
    twoGisUrl: null,
    phone: null,
    whatsapp: null,
    telegram: null,
    primaryContact: null,
    hiddenAt: null,
    profileReviewedAt: null,
    ...overrides,
  });
  const link = (status: string, club = clubRef()) => ({
    clubId: club.id,
    coachId: COACH_ID,
    status,
    position: status === 'ACTIVE' ? 'Старший тренер' : null,
    requestedAt: new Date('2026-10-20T00:00:00.000Z'),
    confirmedAt: status === 'ACTIVE' ? new Date('2026-10-20T00:00:00.000Z') : null,
    club,
    coach: makeTraining().coach,
  });
  const clubLinks = [
    link('ACTIVE'),
    link('ACTIVE', clubRef({ id: 'hidden-club', hiddenAt: new Date() })),
    link('INVITED_BY_CLUB', clubRef({ id: 'club-invites' })),
    link('REQUESTED_BY_COACH', clubRef({ id: 'club-requested' })),
  ];

  it('посторонний видит клубы штаба без скрытых, без приглашений и запросов', async () => {
    prisma.coach.findUnique.mockResolvedValue(makeCoach({ clubLinks }));

    const view = await service.findBySlug('kim-sergey', undefined);

    expect(view.clubs.map((item) => [item.club.id, item.position])).toEqual([
      [CLUB_ID, 'Старший тренер'],
    ]);
    expect(view.clubInvites).toEqual([]);
    expect(view.clubRequests).toEqual([]);
  });

  it('владелец видит приглашения клубов и свои запросы', async () => {
    prisma.coach.findUnique.mockResolvedValue(makeCoach({ clubLinks }));

    const view = await service.findBySlug('kim-sergey', OWNER_ID);

    expect(view.clubInvites.map((item) => item.club.id)).toEqual(['club-invites']);
    expect(view.clubRequests.map((item) => item.club.id)).toEqual(['club-requested']);
  });

  it('сохранение своих тренировок: связь с клубом осталась подтверждённой — тренер в штабе', async () => {
    const id = '88888888-8888-4888-8888-888888888888';
    prisma.coach.findUnique.mockResolvedValue({
      plan: 'FREE',
      trainings: [{ id, clubId: CLUB_ID, link: 'CONFIRMED', linkAt: null, createdAt: new Date() }],
    });

    await service.setTrainings(COACH_ID, {
      trainings: [
        {
          id,
          kind: 'GROUP',
          audiences: ['AMATEURS'],
          title: 'Группа',
          unit: 'MONTH',
          place: 'CLUB',
          clubId: CLUB_ID,
        },
      ],
    });

    expect(prisma.$transaction.mock.calls[0]?.[0]).toContain('staff-create');
    expect(prisma.clubCoach.createMany.mock.calls[0]?.[0]).toMatchObject({
      data: [{ clubId: CLUB_ID, coachId: COACH_ID, status: 'ACTIVE' }],
    });
  });
});

describe('тренировки на странице тренера', () => {
  const club = (overrides: Record<string, unknown> = {}) => ({
    id: CLUB_ID,
    name: 'Спин',
    logoUrl: null,
    address: null,
    city,
    hiddenAt: null,
    profileReviewedAt: null,
    ...overrides,
  });
  const inClub = (id: string, overrides: Record<string, unknown>) =>
    makeTraining({ id, place: 'CLUB', clubId: CLUB_ID, club: club(), ...overrides });
  const trainings = [
    makeTraining({ id: 'online' }),
    inClub('club-pending', { link: 'PENDING' }),
    inClub('club-ok', { link: 'CONFIRMED' }),
    inClub('from-club', { author: 'CLUB', link: 'CONFIRMED' }),
    inClub('request', { author: 'CLUB', link: 'PENDING' }),
    inClub('hidden-club', {
      author: 'CLUB',
      link: 'CONFIRMED',
      club: club({ hiddenAt: new Date() }),
    }),
  ];

  it('посторонний видит видимые свои и подтверждённые клубные, без входящих', async () => {
    prisma.coach.findUnique.mockResolvedValue(makeCoach({ trainings }));

    const view = await service.findBySlug('kim-sergey', undefined);

    expect(view.trainings.map((training) => training.id)).toEqual([
      'online',
      'club-ok',
      'from-club',
    ]);
    expect(view.trainingRequests).toEqual([]);
  });

  it('владелец видит свои как есть и входящие от клубов', async () => {
    prisma.coach.findUnique.mockResolvedValue(makeCoach({ trainings }));

    const view = await service.findBySlug('kim-sergey', OWNER_ID);

    expect(view.trainings.map((training) => [training.id, training.link])).toEqual([
      ['online', 'NONE'],
      ['club-pending', 'PENDING'],
      ['club-ok', 'CONFIRMED'],
      ['from-club', 'CONFIRMED'],
    ]);
    expect(view.trainingRequests.map((training) => training.id)).toEqual(['request']);
    expect(view.trainingRequests[0]?.club).toMatchObject({ id: CLUB_ID });
  });
});

describe('выдача скана', () => {
  function scan(overrides: { filePublic?: boolean; status?: string; hiddenAt?: Date | null }) {
    return {
      fileKey: SCAN,
      filePublic: overrides.filePublic ?? false,
      coach: {
        userId: OWNER_ID,
        status: overrides.status ?? 'APPROVED',
        hiddenAt: overrides.hiddenAt ?? null,
      },
    };
  }

  const key = 'coach-docs/33333333-3333-4333-8333-333333333333.webp';

  it('публичный скан опубликованной страницы — всем, с общим кэшем', async () => {
    prisma.coachCredential.findFirst.mockResolvedValue(scan({ filePublic: true }));

    await expect(service.credentialFile(COACH_ID, DOC_ID, undefined)).resolves.toEqual({
      key,
      isPublic: true,
    });
  });

  it('непубличный скан — постороннему NOT_FOUND, владельцу — без общего кэша', async () => {
    prisma.coachCredential.findFirst.mockResolvedValue(scan({}));

    await expect(service.credentialFile(COACH_ID, DOC_ID, undefined)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(service.credentialFile(COACH_ID, DOC_ID, 'user-stranger')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(service.credentialFile(COACH_ID, DOC_ID, OWNER_ID)).resolves.toEqual({
      key,
      isPublic: false,
    });
  });

  it('скан с галочкой, но страница не опубликована — только владельцу и администратору', async () => {
    prisma.coachCredential.findFirst.mockResolvedValue(
      scan({ filePublic: true, status: 'PENDING' }),
    );

    await expect(service.credentialFile(COACH_ID, DOC_ID, undefined)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    prisma.user.findUnique.mockResolvedValue({ isAdmin: true });

    await expect(service.credentialFile(COACH_ID, DOC_ID, 'user-admin')).resolves.toMatchObject({
      isPublic: false,
    });
  });

  it('документ без скана или чужого тренера — NOT_FOUND', async () => {
    prisma.coachCredential.findFirst.mockResolvedValue(null);

    await expect(service.credentialFile(COACH_ID, DOC_ID, OWNER_ID)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    prisma.coachCredential.findFirst.mockResolvedValue({ ...scan({}), fileKey: null });

    await expect(service.credentialFile(COACH_ID, DOC_ID, OWNER_ID)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
