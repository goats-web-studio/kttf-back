import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';

import { ScreenControlService } from './screen-control.service.js';
import type { ScreenEventsService } from './screen-events.service.js';

/**
 * Слайд экрана зала из консоли — ADR-082.
 *
 * Главное: закрепление всегда временное, право — как у консоли, а стена
 * узнаёт о нём из потока, без перезагрузки.
 */

const TOURNAMENT_ID = '00000000-0000-4000-8000-000000000000';
const CLUB_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '55555555-5555-4555-8555-555555555555';

function makePrisma(member = true) {
  return {
    tournament: {
      findUnique: vi.fn().mockResolvedValue({
        clubId: CLUB_ID,
        status: 'RUNNING',
        screenPin: null,
        screenPinUntil: null,
      }),
      update: vi.fn(
        ({ data }: { data: { screenPin: string | null; screenPinUntil: Date | null } }) =>
          Promise.resolve(data),
      ),
    },
    clubMember: {
      findUnique: vi.fn().mockResolvedValue(member ? { role: 'ORGANIZER' } : null),
    },
  };
}

let prisma: ReturnType<typeof makePrisma>;
let changed: ReturnType<typeof vi.fn>;
let service: ScreenControlService;

beforeEach(() => {
  prisma = makePrisma();
  changed = vi.fn();
  service = new ScreenControlService(
    prisma as unknown as PrismaService,
    { changed } as unknown as ScreenEventsService,
  );
});

describe('закрепление слайда', () => {
  it('закрепляет на заданные минуты и будит стену', async () => {
    const before = Date.now();
    const control = await service.set(TOURNAMENT_ID, { pin: 'bracket', minutes: 5 }, USER_ID);

    expect(control.pin).toBe('bracket');
    const until = Date.parse(control.until ?? '');
    expect(until - before).toBeGreaterThanOrEqual(5 * 60_000 - 50);
    expect(until - before).toBeLessThanOrEqual(5 * 60_000 + 1_000);
    expect(changed).toHaveBeenCalledWith(TOURNAMENT_ID);
  });

  it('«Авто» снимает закрепление целиком', async () => {
    const control = await service.set(TOURNAMENT_ID, { pin: null }, USER_ID);

    expect(control).toEqual({ pin: null, until: null });
    expect(prisma.tournament.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { screenPin: null, screenPinUntil: null } }),
    );
  });

  it('не член клуба экраном не управляет', async () => {
    prisma.clubMember.findUnique.mockResolvedValue(null);

    await expect(service.set(TOURNAMENT_ID, { pin: 'tables' }, USER_ID)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(prisma.tournament.update).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it('у черновика экрана нет', async () => {
    prisma.tournament.findUnique.mockResolvedValue({
      clubId: CLUB_ID,
      status: 'DRAFT',
      screenPin: null,
      screenPinUntil: null,
    });

    await expect(service.get(TOURNAMENT_ID, USER_ID)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
