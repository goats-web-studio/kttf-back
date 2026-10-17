import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { PlacesService } from './places.service.js';

const country = {
  id: 'country-1',
  code: 'KZ',
  name: 'Казахстан',
  nameKk: 'Қазақстан',
  sortOrder: 10,
  isActive: true,
};

const city = {
  id: 'city-1',
  countryId: 'country-1',
  name: 'Алматы',
  nameKk: null,
  sortOrder: 20,
  isActive: true,
};

function makePrisma() {
  return {
    country: {
      findMany: vi.fn().mockResolvedValue([country]),
      findUnique: vi.fn().mockResolvedValue(country),
      create: vi.fn().mockResolvedValue(country),
      update: vi.fn().mockResolvedValue(country),
    },
    city: {
      findMany: vi.fn().mockResolvedValue([city]),
      findUnique: vi.fn().mockResolvedValue(city),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(city),
      update: vi.fn().mockResolvedValue(city),
    },
  };
}

let prisma: ReturnType<typeof makePrisma>;
let service: PlacesService;

beforeEach(() => {
  prisma = makePrisma();
  service = new PlacesService(prisma as unknown as PrismaService);
});

describe('списки', () => {
  it('открытый — только доступное, столицы впереди', async () => {
    await service.listCities({});

    expect(prisma.city.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { isActive: true, country: { isActive: true } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  });

  it('полный — со скрытым', async () => {
    await service.listCountries(true);

    expect(prisma.country.findMany.mock.calls[0]?.[0]).toMatchObject({ where: {} });
  });
});

describe('страна', () => {
  it('занятый код — PLACE_ALREADY_EXISTS', async () => {
    await expect(service.createCountry({ code: 'KZ', name: 'Казахстан' })).rejects.toMatchObject({
      code: 'PLACE_ALREADY_EXISTS',
    });
    expect(prisma.country.create).not.toHaveBeenCalled();
  });

  it('свой же код при правке не дубликат', async () => {
    await service.updateCountry('country-1', { code: 'KZ', name: 'Республика Казахстан' });

    expect(prisma.country.update).toHaveBeenCalledOnce();
  });

  it('несуществующая — NOT_FOUND', async () => {
    prisma.country.findUnique.mockResolvedValue(null);

    await expect(service.updateCountry('нет', { isActive: false })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('город', () => {
  it('дубликат ищется без учёта регистра', async () => {
    prisma.city.findFirst.mockResolvedValue({ id: 'city-2' });

    await expect(
      service.createCity({ countryId: 'country-1', name: 'алматы' }),
    ).rejects.toMatchObject({ code: 'PLACE_ALREADY_EXISTS' });
    expect(prisma.city.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { countryId: 'country-1', name: { equals: 'алматы', mode: 'insensitive' } },
    });
  });

  it('в несуществующую страну не заводится', async () => {
    prisma.country.findUnique.mockResolvedValue(null);

    await expect(service.createCity({ countryId: 'нет', name: 'Каскелен' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('смена регистра в своём названии — не дубликат', async () => {
    await service.updateCity('city-1', { name: 'АЛМАТЫ' });

    expect(prisma.city.findFirst).not.toHaveBeenCalled();
    expect(prisma.city.update).toHaveBeenCalledOnce();
  });

  it('скрывается правкой', async () => {
    await service.updateCity('city-1', { isActive: false });

    expect(prisma.city.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isActive: false } }),
    );
  });
});

describe('выбор города клубу или игроку', () => {
  it('скрытый или чужой город — CITY_UNAVAILABLE', async () => {
    await expect(service.assertCityAvailable('city-9')).rejects.toMatchObject({
      code: 'CITY_UNAVAILABLE',
    });
    expect(prisma.city.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'city-9', isActive: true, country: { isActive: true } },
    });
  });

  it('уже указанный город остаётся, даже если его скрыли', async () => {
    await service.assertCityAvailable('city-1', 'city-1');

    expect(prisma.city.findFirst).not.toHaveBeenCalled();
  });

  it('город не меняется — проверять нечего', async () => {
    await service.assertCityAvailable(undefined);

    expect(prisma.city.findFirst).not.toHaveBeenCalled();
  });
});
