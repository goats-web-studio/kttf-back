import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { ClubStaffService, staffFromTrainings } from './club-staff.service.js';

const CLUB_ID = '77777777-7777-4777-8777-777777777777';
const COACH_ID = '11111111-1111-4111-8111-111111111111';
const pair = { clubId: CLUB_ID, coachId: COACH_ID };
const city = { id: 'city-1', name: 'Алматы', nameKk: null };

/** Связь штаба, как её отдаёт выборка `clubCoachFields`. */
function makeLink(overrides: Record<string, unknown> = {}) {
  return {
    clubId: CLUB_ID,
    coachId: COACH_ID,
    status: 'ACTIVE',
    position: null,
    requestedAt: new Date('2026-10-20T00:00:00.000Z'),
    confirmedAt: null,
    club: {
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
    },
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
    clubCoach: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve(makeLink(args.data)),
      ),
      createMany: vi.fn().mockReturnValue('createMany'),
      update: vi.fn().mockResolvedValue(makeLink({ position: 'Старший тренер' })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    coach: { findFirst: vi.fn().mockResolvedValue({ id: COACH_ID }) },
    club: {
      findFirst: vi.fn().mockResolvedValue({ id: CLUB_ID }),
      findUnique: vi.fn().mockResolvedValue({ hiddenAt: null }),
    },
    clubMember: { findUnique: vi.fn().mockResolvedValue(null) },
    user: { findUnique: vi.fn().mockResolvedValue({ isAdmin: false }) },
  };
}

let prisma: ReturnType<typeof makePrisma>;
let service: ClubStaffService;

beforeEach(() => {
  prisma = makePrisma();
  service = new ClubStaffService(prisma as unknown as PrismaService);
});

describe('приглашение и запрос', () => {
  it('клуб приглашает — связь ждёт тренера, с должностью', async () => {
    const view = await service.invite(CLUB_ID, { coachId: COACH_ID, position: 'Детский тренер' });

    expect(prisma.clubCoach.create.mock.calls[0]?.[0]).toMatchObject({
      data: { ...pair, status: 'INVITED_BY_CLUB', position: 'Детский тренер' },
    });
    expect(view.status).toBe('INVITED_BY_CLUB');
  });

  it('тренер просится — связь ждёт клуб', async () => {
    await service.request(COACH_ID, { clubId: CLUB_ID });

    expect(prisma.clubCoach.create.mock.calls[0]?.[0]).toMatchObject({
      data: { ...pair, status: 'REQUESTED_BY_COACH', position: null },
    });
  });

  it('встречное предложение — согласие: связь становится ACTIVE', async () => {
    prisma.clubCoach.findUnique
      .mockResolvedValueOnce({ status: 'REQUESTED_BY_COACH' })
      .mockResolvedValueOnce(makeLink());

    await expect(service.invite(CLUB_ID, { coachId: COACH_ID })).resolves.toMatchObject({
      status: 'ACTIVE',
    });
    expect(prisma.clubCoach.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { ...pair, status: 'REQUESTED_BY_COACH' },
      data: { status: 'ACTIVE' },
    });
    expect(prisma.clubCoach.create).not.toHaveBeenCalled();
  });

  it('уже в штабе или уже приглашён — CLUB_COACH_INVALID', async () => {
    for (const status of ['ACTIVE', 'INVITED_BY_CLUB']) {
      prisma.clubCoach.findUnique.mockResolvedValueOnce({ status });

      await expect(service.invite(CLUB_ID, { coachId: COACH_ID })).rejects.toMatchObject({
        code: 'CLUB_COACH_INVALID',
        details: { status },
      });
    }

    prisma.clubCoach.findUnique.mockResolvedValueOnce({ status: 'REQUESTED_BY_COACH' });

    await expect(service.request(COACH_ID, { clubId: CLUB_ID })).rejects.toMatchObject({
      code: 'CLUB_COACH_INVALID',
    });
  });

  it('тренер без опубликованной страницы — VALIDATION_FAILED с полем', async () => {
    prisma.coach.findFirst.mockResolvedValue(null);

    await expect(service.invite(CLUB_ID, { coachId: COACH_ID })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { field: 'coachId' },
    });
  });

  it('скрытый или неизвестный клуб — VALIDATION_FAILED с полем', async () => {
    prisma.club.findFirst.mockResolvedValue(null);

    await expect(service.request(COACH_ID, { clubId: CLUB_ID })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { field: 'clubId' },
    });
  });
});

describe('подтверждение', () => {
  it('приглашение клуба подтверждает тренер', async () => {
    prisma.clubCoach.findUnique.mockResolvedValue(makeLink({ status: 'INVITED_BY_CLUB' }));
    const now = new Date('2026-10-21T10:00:00.000Z');

    await service.confirm(pair, 'user-coach', now);

    expect(prisma.clubCoach.updateMany).toHaveBeenCalledWith({
      where: { ...pair, status: 'INVITED_BY_CLUB' },
      data: { status: 'ACTIVE', confirmedAt: now },
    });
  });

  it('запрос тренера подтверждает OWNER или ORGANIZER клуба', async () => {
    prisma.clubCoach.findUnique.mockResolvedValue(makeLink({ status: 'REQUESTED_BY_COACH' }));

    for (const role of ['OWNER', 'ORGANIZER']) {
      prisma.clubMember.findUnique.mockResolvedValueOnce({ role });

      await expect(service.confirm(pair, 'user-club')).resolves.toBeDefined();
    }
  });

  it('своё же предложение не подтвердить — CLUB_COACH_INVALID', async () => {
    prisma.clubCoach.findUnique.mockResolvedValue(makeLink({ status: 'INVITED_BY_CLUB' }));
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'OWNER' });

    await expect(service.confirm(pair, 'user-club')).rejects.toMatchObject({
      code: 'CLUB_COACH_INVALID',
      details: { status: 'INVITED_BY_CLUB' },
    });
    expect(prisma.clubCoach.updateMany).not.toHaveBeenCalled();
  });

  it('уже в штабе — CLUB_COACH_INVALID даже администратору', async () => {
    prisma.clubCoach.findUnique.mockResolvedValue(makeLink({ status: 'ACTIVE' }));
    prisma.user.findUnique.mockResolvedValue({ isAdmin: true });

    await expect(service.confirm(pair, 'user-admin')).rejects.toMatchObject({
      code: 'CLUB_COACH_INVALID',
    });
  });

  it('посторонний и судья клуба — FORBIDDEN', async () => {
    prisma.clubCoach.findUnique.mockResolvedValue(makeLink({ status: 'REQUESTED_BY_COACH' }));

    await expect(service.confirm(pair, 'user-stranger')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    prisma.clubMember.findUnique.mockResolvedValueOnce({ role: 'REFEREE' });

    await expect(service.confirm(pair, 'user-referee')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('администратор подтверждает за любую сторону', async () => {
    prisma.clubCoach.findUnique.mockResolvedValue(makeLink({ status: 'INVITED_BY_CLUB' }));
    prisma.user.findUnique.mockResolvedValue({ isAdmin: true });

    await expect(service.confirm(pair, 'user-admin')).resolves.toBeDefined();
  });

  it('связи нет — NOT_FOUND', async () => {
    await expect(service.confirm(pair, 'user-coach')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('разрыв и должность', () => {
  it('разорвать может любая сторона в любом статусе', async () => {
    prisma.clubCoach.findUnique.mockResolvedValue(makeLink({ status: 'INVITED_BY_CLUB' }));

    await service.remove(pair, 'user-coach');

    prisma.clubMember.findUnique.mockResolvedValueOnce({ role: 'ORGANIZER' });
    await service.remove(pair, 'user-club');

    expect(prisma.clubCoach.deleteMany).toHaveBeenCalledTimes(2);
    expect(prisma.clubCoach.deleteMany).toHaveBeenCalledWith({ where: pair });
  });

  it('посторонний не разрывает — FORBIDDEN', async () => {
    prisma.clubCoach.findUnique.mockResolvedValue(makeLink());

    await expect(service.remove(pair, 'user-stranger')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(prisma.clubCoach.deleteMany).not.toHaveBeenCalled();
  });

  it('должность правит клуб', async () => {
    prisma.clubCoach.findUnique.mockResolvedValue(makeLink());

    await expect(service.setPosition(pair, { position: 'Старший тренер' })).resolves.toMatchObject({
      position: 'Старший тренер',
    });
  });
});

describe('выдача штаба', () => {
  it('публично — ACTIVE с опубликованной страницей; скрытый клуб — пусто', async () => {
    prisma.clubCoach.findMany.mockResolvedValue([makeLink()]);

    await expect(service.forClub(CLUB_ID)).resolves.toHaveLength(1);
    expect(prisma.clubCoach.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: {
        clubId: CLUB_ID,
        status: 'ACTIVE',
        coach: { is: { status: 'APPROVED', hiddenAt: null } },
      },
    });

    prisma.club.findUnique.mockResolvedValueOnce({ hiddenAt: new Date() });
    await expect(service.forClub(CLUB_ID)).resolves.toEqual([]);
  });

  it('кабинет клуба: состав, приглашённые и запросы', async () => {
    prisma.clubCoach.findMany.mockResolvedValue([
      makeLink({ status: 'ACTIVE' }),
      makeLink({ status: 'INVITED_BY_CLUB' }),
      makeLink({ status: 'REQUESTED_BY_COACH' }),
    ]);

    const view = await service.manage(CLUB_ID);

    expect([view.active.length, view.invited.length, view.requests.length]).toEqual([1, 1, 1]);
  });
});

describe('автодобавление в штаб', () => {
  it('новая пара — ACTIVE, ждущая — ACTIVE, должность не трогается', () => {
    const now = new Date('2026-10-21T10:00:00.000Z');
    const operations = staffFromTrainings(prisma as unknown as PrismaService, [pair, pair], now);

    expect(operations).toHaveLength(2);
    expect(prisma.clubCoach.createMany).toHaveBeenCalledWith({
      data: [{ ...pair, status: 'ACTIVE', requestedAt: now, confirmedAt: now }],
      skipDuplicates: true,
    });
    expect(prisma.clubCoach.updateMany).toHaveBeenCalledWith({
      where: { ...pair, status: { not: 'ACTIVE' } },
      data: { status: 'ACTIVE', confirmedAt: now },
    });
  });

  it('нет подтверждённых — ничего', () => {
    expect(staffFromTrainings(prisma as unknown as PrismaService, [])).toEqual([]);
  });
});
