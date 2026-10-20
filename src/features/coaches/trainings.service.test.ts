import { listTrainingsSchema } from '@kttf/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { groupTrainings, keptLink, venueKey } from './training-rules.js';
import { isTrainingPublic, toTrainingView, type TrainingRecord } from './training-view.js';
import { TrainingsService, trainingsWhere } from './trainings.service.js';

const CITY = '66666666-6666-4666-8666-666666666666';
const CLUB_ID = '77777777-7777-4777-8777-777777777777';
const COACH_ID = '11111111-1111-4111-8111-111111111111';
const city = { id: CITY, name: 'Алматы', nameKk: null };

function makeClub(overrides: Record<string, unknown> = {}) {
  return {
    id: CLUB_ID,
    name: 'Спин',
    logoUrl: null,
    address: 'Абая 10',
    city,
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
    ...overrides,
  };
}

/** Строка тренировки, как её отдаёт выборка `trainingFields`. */
function makeTraining(overrides: Record<string, unknown> = {}): TrainingRecord {
  return {
    id: 'training-1',
    author: 'COACH',
    coachId: COACH_ID,
    clubId: null,
    link: 'NONE',
    linkAt: null,
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
    sortOrder: 0,
    createdAt: new Date('2026-10-20T00:00:00.000Z'),
    club: null,
    coach: makeCoach(),
    ...overrides,
  } as unknown as TrainingRecord;
}

const inClub = (overrides: Record<string, unknown> = {}) =>
  makeTraining({ place: 'CLUB', clubId: CLUB_ID, club: makeClub(), ...overrides });

describe('связь после правки списка', () => {
  const at = new Date('2026-10-19T00:00:00.000Z');

  it('без второй стороны — NONE', () => {
    expect(keptLink({ partner: CLUB_ID, link: 'CONFIRMED', linkAt: at }, null)).toEqual({
      link: 'NONE',
      linkAt: null,
    });
  });

  it('та же вторая сторона — связь как была, включая отказ', () => {
    for (const link of ['PENDING', 'CONFIRMED', 'DECLINED'] as const) {
      expect(keptLink({ partner: CLUB_ID, link, linkAt: at }, CLUB_ID)).toEqual({
        link,
        linkAt: at,
      });
    }
  });

  it('новая строка или другая сторона — снова ждёт ответа', () => {
    expect(keptLink(undefined, CLUB_ID)).toEqual({ link: 'PENDING', linkAt: null });
    expect(keptLink({ partner: 'club-2', link: 'CONFIRMED', linkAt: at }, CLUB_ID)).toEqual({
      link: 'PENDING',
      linkAt: null,
    });
  });
});

describe('публичность тренировки', () => {
  it('тренерская без клуба — у опубликованной страницы', () => {
    expect(isTrainingPublic(makeTraining())).toBe(true);
    expect(isTrainingPublic(makeTraining({ coach: makeCoach({ status: 'PENDING' }) }))).toBe(false);
    expect(isTrainingPublic(makeTraining({ coach: makeCoach({ hiddenAt: new Date() }) }))).toBe(
      false,
    );
  });

  it('тренерская в клубе — только после подтверждения клубом', () => {
    for (const link of ['PENDING', 'DECLINED'] as const) {
      expect(isTrainingPublic(inClub({ link }))).toBe(false);
    }
    expect(isTrainingPublic(inClub({ link: 'CONFIRMED' }))).toBe(true);
    expect(
      isTrainingPublic(inClub({ link: 'CONFIRMED', club: makeClub({ hiddenAt: new Date() }) })),
    ).toBe(false);
  });

  it('клубная — у не скрытого клуба, тренер не нужен', () => {
    expect(isTrainingPublic(inClub({ author: 'CLUB', coachId: null, coach: null }))).toBe(true);
    expect(
      isTrainingPublic(inClub({ author: 'CLUB', club: makeClub({ hiddenAt: new Date() }) })),
    ).toBe(false);
  });

  it('тренер клубной тренировки виден всем только подтверждённым и опубликованным', () => {
    const pending = inClub({ author: 'CLUB', link: 'PENDING' });

    expect(toTrainingView(pending, false).coach).toBeNull();
    // Клубу и тренеру — как есть, со статусом связи.
    expect(toTrainingView(pending, false).link).toBe('NONE');
    expect(toTrainingView(pending, true)).toMatchObject({
      coach: { id: COACH_ID },
      link: 'PENDING',
    });
    expect(
      toTrainingView(inClub({ author: 'CLUB', link: 'CONFIRMED' }), false).coach,
    ).toMatchObject({ slug: 'kim-sergey' });
    expect(
      toTrainingView(
        inClub({ author: 'CLUB', link: 'CONFIRMED', coach: makeCoach({ hiddenAt: new Date() }) }),
        false,
      ).coach,
    ).toBeNull();
  });

  it('постороннему ожидание и отказ выглядят как отсутствие связи', () => {
    for (const link of ['PENDING', 'DECLINED'] as const) {
      const fromClub = toTrainingView(inClub({ author: 'CLUB', link }), false);
      const fromCoach = toTrainingView(inClub({ link }), false);

      expect(fromClub).toMatchObject({ link: 'NONE', coach: null, club: { id: CLUB_ID } });
      expect(fromCoach).toMatchObject({ link: 'NONE', club: null, coach: { id: COACH_ID } });
      // Автору, второй стороне и администратору — как есть.
      expect(toTrainingView(inClub({ author: 'CLUB', link }), true)).toMatchObject({
        link,
        coach: { id: COACH_ID },
      });
      expect(toTrainingView(inClub({ link }), true)).toMatchObject({
        link,
        club: { id: CLUB_ID },
      });
    }

    expect(toTrainingView(inClub({ link: 'CONFIRMED' }), false)).toMatchObject({
      link: 'CONFIRMED',
      club: { id: CLUB_ID },
    });
  });

  it('зал вне KTTF — названием и адресом', () => {
    const view = toTrainingView(
      makeTraining({ place: 'CLUB', venueName: 'Школа №5', venueAddress: 'Сатпаева 1' }),
      false,
    );

    expect(view).toMatchObject({ club: null, venue: { name: 'Школа №5', address: 'Сатпаева 1' } });
  });
});

describe('блоки раздела «Тренировки»', () => {
  it('клуб, зал и «выезд и онлайн» последним', () => {
    const groups = groupTrainings([
      makeTraining({ id: 'online', place: 'ONLINE' }),
      makeTraining({ id: 'visit', place: 'VISIT' }),
      makeTraining({
        id: 'venue',
        place: 'CLUB',
        venueName: 'Школа №5',
        venueAddress: 'Сатпаева 1',
      }),
      inClub({ id: 'club', author: 'CLUB', link: 'NONE', coachId: null, coach: null }),
      inClub({ id: 'coach-in-club', link: 'CONFIRMED', sortOrder: 1 }),
    ]);

    expect(groups.map((group) => group.kind)).toEqual(['CLUB', 'VENUE', 'ANYWHERE']);
    expect(groups[0]).toMatchObject({ club: { id: CLUB_ID, name: 'Спин' }, venue: null });
    expect(groups[0]?.trainings.map((training) => training.id)).toEqual(['club', 'coach-in-club']);
    expect(groups[1]?.venue).toEqual({ name: 'Школа №5', address: 'Сатпаева 1' });
    expect(groups[2]?.trainings.map((training) => training.id).sort()).toEqual(['online', 'visit']);
  });

  it('один зал — без разницы в регистре и пробелах по краям', () => {
    const groups = groupTrainings([
      makeTraining({ id: 'a', place: 'CLUB', venueName: 'Школа №5', venueAddress: 'Сатпаева 1' }),
      makeTraining({ id: 'b', place: 'CLUB', venueName: ' школа №5 ', venueAddress: 'САТПАЕВА 1' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.trainings).toHaveLength(2);
    expect(venueKey('Школа №5', 'Сатпаева 1')).toBe(venueKey(' школа №5', 'сатпаева 1 '));
  });

  it('клубы по свежести страницы клуба, без отметки — в конце, затем по названию', () => {
    const club = (id: string, name: string, at: string | null) =>
      inClub({
        id,
        clubId: id,
        author: 'CLUB',
        club: makeClub({ id, name, profileReviewedAt: at === null ? null : new Date(at) }),
      });

    const groups = groupTrainings([
      club('c1', 'Бета', null),
      club('c2', 'Альфа', null),
      club('c3', 'Гамма', '2026-10-01T00:00:00.000Z'),
      club('c4', 'Дельта', '2026-10-15T00:00:00.000Z'),
    ]);

    expect(groups.map((group) => group.club?.name)).toEqual(['Дельта', 'Гамма', 'Альфа', 'Бета']);
  });

  it('внутри блока — порядок строк, затем время заведения', () => {
    const groups = groupTrainings([
      makeTraining({ id: 'late', sortOrder: 0, createdAt: new Date('2026-10-20T10:00:00Z') }),
      makeTraining({ id: 'second', sortOrder: 1 }),
      makeTraining({ id: 'early', sortOrder: 0, createdAt: new Date('2026-10-20T09:00:00Z') }),
    ]);

    expect(groups[0]?.trainings.map((training) => training.id)).toEqual([
      'early',
      'late',
      'second',
    ]);
  });
});

describe('фильтры раздела', () => {
  const where = (query: Record<string, string>) => trainingsWhere(listTrainingsSchema.parse(query));

  it('без фильтров — только публичные', () => {
    const result = where({});

    expect(result.AND).toHaveLength(1);
    expect(JSON.stringify(result.AND)).toContain('CONFIRMED');
  });

  it('клуб — только его блок', () => {
    expect(where({ clubId: CLUB_ID }).clubId).toBe(CLUB_ID);
  });

  it('возраст: детская или подростковая, с этого возраста или без возраста', () => {
    expect(where({ age: '9' }).AND).toContainEqual({
      audiences: { hasSome: ['KIDS', 'TEENS'] },
      OR: [{ kidsFromAge: null }, { kidsFromAge: { lte: 9 } }],
    });
  });

  it('«цена до» включительно; без цены не попадает', () => {
    expect(where({ priceTo: '15000' }).priceKzt).toEqual({ not: null, lte: 15_000 });
  });

  it('город — клуба у клубных, страницы тренера у остальных', () => {
    expect(where({ cityId: CITY }).AND).toContainEqual({
      OR: [
        { clubId: { not: null }, club: { is: { cityId: { in: [CITY] } } } },
        { clubId: null, coach: { is: { cityId: { in: [CITY] } } } },
      ],
    });
  });

  it('язык — тренера; клубная без подтверждённого тренера не проходит', () => {
    expect(where({ language: 'KK' }).AND).toContainEqual({
      OR: [
        { author: 'COACH', coach: { is: { languages: { has: 'KK' } } } },
        {
          author: 'CLUB',
          link: 'CONFIRMED',
          coach: { is: { status: 'APPROVED', hiddenAt: null, languages: { has: 'KK' } } },
        },
      ],
    });
  });
});

function makePrisma() {
  return {
    training: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(inClub({ link: 'PENDING' })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockReturnValue('deleteMany'),
      createMany: vi.fn().mockReturnValue('createMany'),
    },
    club: {
      findUnique: vi.fn().mockResolvedValue({ hiddenAt: null }),
      update: vi.fn().mockReturnValue('touch'),
    },
    coach: { findMany: vi.fn().mockResolvedValue([{ id: COACH_ID }]) },
    clubMember: { findUnique: vi.fn().mockResolvedValue(null) },
    user: { findUnique: vi.fn().mockResolvedValue({ isAdmin: false }) },
    $transaction: vi.fn((operations: unknown[]) => Promise.resolve(operations)),
  };
}

let prisma: ReturnType<typeof makePrisma>;
let service: TrainingsService;

beforeEach(() => {
  prisma = makePrisma();
  service = new TrainingsService(prisma as unknown as PrismaService);
});

describe('список блоками', () => {
  it('страница считает блоки, а не тренировки', async () => {
    prisma.training.findMany.mockResolvedValue([
      inClub({ id: 'a', author: 'CLUB' }),
      inClub({ id: 'b', author: 'CLUB' }),
      makeTraining({ id: 'c' }),
    ]);

    const page = await service.list(listTrainingsSchema.parse({ limit: '1', page: '2' }));

    expect(page.total).toBe(2);
    expect(page.items.map((group) => group.kind)).toEqual(['ANYWHERE']);
  });
});

describe('подтверждение связи', () => {
  it('тренировку тренера в клубе подтверждает OWNER или ORGANIZER клуба', async () => {
    for (const role of ['OWNER', 'ORGANIZER']) {
      prisma.clubMember.findUnique.mockResolvedValueOnce({ role });
      const now = new Date('2026-10-20T12:00:00.000Z');

      await service.confirm('training-1', 'user-club', now);

      expect(prisma.training.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'training-1', link: { in: ['PENDING'] } },
        data: { link: 'CONFIRMED', linkAt: now },
      });
    }
  });

  it('судья клуба, посторонний и сам тренер-автор — FORBIDDEN', async () => {
    prisma.clubMember.findUnique.mockResolvedValueOnce({ role: 'REFEREE' });

    await expect(service.confirm('training-1', 'user-referee')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(service.confirm('training-1', 'user-stranger')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // Автор отвечать за клуб не может.
    await expect(service.confirm('training-1', 'user-coach')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(prisma.training.updateMany).not.toHaveBeenCalled();
  });

  it('клубную тренировку подтверждает владелец страницы тренера, а не клуб', async () => {
    prisma.training.findUnique.mockResolvedValue(inClub({ author: 'CLUB', link: 'PENDING' }));
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'OWNER' });

    await expect(service.confirm('training-1', 'user-club')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(service.confirm('training-1', 'user-coach')).resolves.toMatchObject({
      author: 'CLUB',
    });
  });

  it('администратор отвечает за любую сторону', async () => {
    prisma.user.findUnique.mockResolvedValue({ isAdmin: true });

    await expect(service.confirm('training-1', 'user-admin')).resolves.toBeDefined();
  });

  it('связь, которая не ждёт ответа, — TRAINING_LINK_INVALID с текущим статусом', async () => {
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'OWNER' });
    prisma.training.updateMany.mockResolvedValue({ count: 0 });
    prisma.training.findUnique
      .mockResolvedValueOnce(inClub({ link: 'CONFIRMED' }))
      .mockResolvedValueOnce({ link: 'CONFIRMED' });

    await expect(service.confirm('training-1', 'user-club')).rejects.toMatchObject({
      code: 'TRAINING_LINK_INVALID',
      details: { link: 'CONFIRMED' },
    });
  });

  it('отказ — из ожидания и из подтверждённой: разрыв связи', async () => {
    prisma.clubMember.findUnique.mockResolvedValue({ role: 'ORGANIZER' });

    await service.decline('training-1', 'user-club');

    expect(prisma.training.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { link: { in: ['PENDING', 'CONFIRMED'] } },
      data: { link: 'DECLINED' },
    });
  });

  it('несуществующая тренировка — NOT_FOUND', async () => {
    prisma.training.findUnique.mockResolvedValue(null);

    await expect(service.decline('training-9', 'user-club')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('тренировки клуба', () => {
  /** Что ушло в `createMany`. */
  function written(): Record<string, unknown>[] {
    return (prisma.training.createMany.mock.calls[0]?.[0] as { data: Record<string, unknown>[] })
      .data;
  }

  const row = {
    kind: 'GROUP' as const,
    audiences: ['AMATEURS' as const],
    title: 'Вечерняя группа',
    unit: 'MONTH' as const,
  };
  const at = new Date('2026-10-19T00:00:00.000Z');

  it('место — сам клуб; тренер указан — ждёт его подтверждения', async () => {
    await service.setClubTrainings(CLUB_ID, {
      trainings: [{ ...row, coachId: COACH_ID }, { ...row }],
    });

    expect(written()).toEqual([
      expect.objectContaining({
        author: 'CLUB',
        clubId: CLUB_ID,
        place: 'CLUB',
        coachId: COACH_ID,
        link: 'PENDING',
      }),
      expect.objectContaining({ coachId: null, link: 'NONE', sortOrder: 1 }),
    ]);
    expect(prisma.training.deleteMany).toHaveBeenCalledWith({
      where: { clubId: CLUB_ID, author: 'CLUB' },
    });
  });

  it('тот же id и тот же тренер сохраняют связь, другой тренер — снова ожидание', async () => {
    const id = '88888888-8888-4888-8888-888888888888';
    prisma.training.findMany.mockResolvedValueOnce([
      { id, coachId: COACH_ID, link: 'DECLINED', linkAt: at, createdAt: at },
    ]);

    await service.setClubTrainings(CLUB_ID, { trainings: [{ ...row, id, coachId: COACH_ID }] });

    expect(written()[0]).toMatchObject({ id, link: 'DECLINED', linkAt: at, createdAt: at });

    prisma.training.createMany.mockClear();
    prisma.training.findMany.mockResolvedValueOnce([
      { id, coachId: 'coach-old', link: 'CONFIRMED', linkAt: at, createdAt: at },
    ]);

    await service.setClubTrainings(CLUB_ID, { trainings: [{ ...row, id, coachId: COACH_ID }] });

    expect(written()[0]).toMatchObject({ id, link: 'PENDING', linkAt: null });
  });

  it('тренер без опубликованной страницы — VALIDATION_FAILED с полем', async () => {
    prisma.coach.findMany.mockResolvedValue([]);

    await expect(
      service.setClubTrainings(CLUB_ID, { trainings: [{ ...row }, { ...row, coachId: COACH_ID }] }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { field: 'trainings.1.coachId' },
    });
    expect(prisma.training.createMany).not.toHaveBeenCalled();
  });

  it('кабинет клуба: свои, входящие и подтверждённые тренерские — как есть', async () => {
    prisma.training.findMany.mockResolvedValue([
      inClub({ id: 'own', author: 'CLUB', link: 'PENDING' }),
      inClub({ id: 'request', link: 'PENDING' }),
      inClub({ id: 'confirmed', link: 'CONFIRMED' }),
      inClub({ id: 'declined', link: 'DECLINED' }),
    ]);

    const view = await service.manage(CLUB_ID);

    expect(view.trainings.map((training) => training.id)).toEqual(['own']);
    expect(view.trainings[0]?.coach).not.toBeNull();
    expect(view.requests.map((training) => training.id)).toEqual(['request']);
    expect(view.coachTrainings.map((training) => training.id)).toEqual(['confirmed']);
  });

  it('страница клуба: свои впереди; скрытый клуб — пусто, чужой — NOT_FOUND', async () => {
    prisma.training.findMany.mockResolvedValue([
      inClub({ id: 'coach', link: 'CONFIRMED' }),
      inClub({ id: 'own', author: 'CLUB', link: 'PENDING' }),
    ]);

    const list = await service.forClub(CLUB_ID);

    expect(list.map((training) => training.id)).toEqual(['own', 'coach']);
    // Тренер клубной тренировки без подтверждения публично не показывается.
    expect(list[0]).toMatchObject({ coach: null, link: 'NONE' });

    prisma.club.findUnique.mockResolvedValueOnce({ hiddenAt: new Date() });
    await expect(service.forClub(CLUB_ID)).resolves.toEqual([]);

    prisma.club.findUnique.mockResolvedValueOnce(null);
    await expect(service.forClub(CLUB_ID)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
