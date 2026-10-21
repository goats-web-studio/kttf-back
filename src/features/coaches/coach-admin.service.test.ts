import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { CoachAdminService } from './coach-admin.service.js';
import type { CoachesService } from './coaches.service.js';

const COACH_ID = '11111111-1111-4111-8111-111111111111';
const city = { id: 'city-1', name: 'Алматы', nameKk: null };

const coach = {
  id: COACH_ID,
  slug: 'kim-sergey',
  playerId: 'player-1',
  userId: 'user-1',
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
  status: 'PENDING',
  rejectReason: null,
  reviewedAt: null,
  submittedAt: new Date('2026-10-20T09:00:00.000Z'),
  hiddenAt: null,
  hiddenReason: null,
  headline: null,
  about: null,
  photoUrl: null,
  coverUrl: null,
  coachingSince: null,
  city,
  formats: [],
  visitAreas: null,
  languages: [],
  phone: null,
  whatsapp: null,
  telegram: null,
  instagram: null,
  primaryContact: null,
  sportsRank: null,
  coachCategory: null,
  refereeCategory: null,
  education: null,
  plan: 'FREE',
  profileReviewedAt: null,
  createdAt: new Date('2026-10-19T00:00:00.000Z'),
  trainings: [],
  credentials: [
    {
      id: 'doc-1',
      kind: 'DIPLOMA',
      title: 'КазАСТ',
      issuer: null,
      year: 2014,
      fileKey: '/api/v1/files/coach-docs/33333333-3333-4333-8333-333333333333.webp',
      filePublic: false,
      verifiedAt: null,
    },
  ],
  achievements: [],
  clubLinks: [],
};

function makePrisma() {
  return {
    coach: {
      findMany: vi.fn().mockResolvedValue([coach]),
      findUnique: vi.fn().mockResolvedValue(coach),
      count: vi.fn().mockResolvedValue(1),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    coachCredential: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    player: { groupBy: vi.fn().mockResolvedValue([]) },
  };
}

let prisma: ReturnType<typeof makePrisma>;
let coaches: { findById: ReturnType<typeof vi.fn> };
let service: CoachAdminService;

beforeEach(() => {
  prisma = makePrisma();
  coaches = { findById: vi.fn().mockResolvedValue({ id: COACH_ID }) };
  service = new CoachAdminService(
    prisma as unknown as PrismaService,
    coaches as unknown as CoachesService,
  );
});

describe('очередь заявок', () => {
  it('свежие отправленные сверху; администратору видно всё, включая сканы', async () => {
    const page = await service.list({ page: 1, limit: 20, status: 'PENDING' });

    expect(prisma.coach.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { status: 'PENDING' },
      orderBy: [{ submittedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    });
    expect(page.items[0]).toMatchObject({
      submittedAt: '2026-10-20T09:00:00.000Z',
      credentials: [{ file: coach.credentials[0]?.fileKey, hasFile: true }],
    });
    expect(page.items[0]?.credentials[0]?.fileUrl).toMatch(/\/credentials\/doc-1\/file$/);
  });
});

describe('решение по заявке', () => {
  it('одобрить можно только заявку на проверке', async () => {
    const now = new Date('2026-10-20T12:00:00.000Z');

    await service.approve(COACH_ID, now);

    expect(prisma.coach.updateMany).toHaveBeenCalledWith({
      where: { id: COACH_ID, status: 'PENDING' },
      data: { status: 'APPROVED', reviewedAt: now, rejectReason: null },
    });
  });

  it('отказ — с причиной', async () => {
    await service.reject(COACH_ID, 'Нет тренировок с ценой');

    expect(prisma.coach.updateMany.mock.calls[0]?.[0]).toMatchObject({
      data: { status: 'REJECTED', rejectReason: 'Нет тренировок с ценой' },
    });
  });

  it('не из PENDING — COACH_STATUS_INVALID с текущим статусом', async () => {
    prisma.coach.updateMany.mockResolvedValue({ count: 0 });

    for (const status of ['DRAFT', 'APPROVED', 'REJECTED']) {
      prisma.coach.findUnique.mockResolvedValueOnce({ status });

      await expect(service.approve(COACH_ID)).rejects.toMatchObject({
        code: 'COACH_STATUS_INVALID',
        details: { status },
      });
    }
  });

  it('несуществующая страница — NOT_FOUND', async () => {
    prisma.coach.updateMany.mockResolvedValue({ count: 0 });
    prisma.coach.findUnique.mockResolvedValue(null);

    await expect(service.reject(COACH_ID, 'x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('постмодерация', () => {
  it('скрытие — с причиной, снятие стирает обе отметки', async () => {
    await service.setHidden(COACH_ID, { hidden: true, reason: 'Чужие фото' });
    await service.setHidden(COACH_ID, { hidden: false });

    const [hide, show] = prisma.coach.updateMany.mock.calls.map(
      (call) => (call[0] as { data: { hiddenAt: Date | null; hiddenReason: string | null } }).data,
    );

    expect(hide?.hiddenAt).toBeInstanceOf(Date);
    expect(hide?.hiddenReason).toBe('Чужие фото');
    expect(show).toEqual({ hiddenAt: null, hiddenReason: null });
  });

  it('«проверено KTTF» ставится и снимается у документа этого тренера', async () => {
    await service.verifyCredential(COACH_ID, 'doc-1', true);
    await service.verifyCredential(COACH_ID, 'doc-1', false);

    const calls = prisma.coachCredential.updateMany.mock.calls.map(
      (call) => call[0] as { where: unknown; data: { verifiedAt: Date | null } },
    );

    expect(calls[0]?.where).toEqual({ id: 'doc-1', coachId: COACH_ID });
    expect(calls[0]?.data.verifiedAt).toBeInstanceOf(Date);
    expect(calls[1]?.data.verifiedAt).toBeNull();
    expect(coaches.findById).toHaveBeenCalledWith(COACH_ID);
  });

  it('документ чужого тренера — NOT_FOUND', async () => {
    prisma.coachCredential.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.verifyCredential(COACH_ID, 'doc-9', true)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
