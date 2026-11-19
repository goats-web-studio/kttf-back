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

const region = {
  id: 'region-1',
  countryId: 'country-1',
  name: 'Карагандинская область',
  nameKk: 'Қарағанды облысы',
  sortOrder: 100,
  isActive: true,
};

const city = {
  id: 'city-1',
  countryId: 'country-1',
  regionId: null,
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
    region: {
      findMany: vi.fn().mockResolvedValue([region]),
      findUnique: vi.fn().mockResolvedValue(region),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(region),
      update: vi.fn().mockResolvedValue(region),
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

  it('области — только доступные, той же сортировкой (ADR-096)', async () => {
    await service.listRegions({ countryId: 'country-1' });

    expect(prisma.region.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { countryId: 'country-1', isActive: true, country: { isActive: true } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  });

  it('области у администратора — со скрытыми', async () => {
    await service.listRegions({}, true);

    expect(prisma.region.findMany.mock.calls[0]?.[0]).toMatchObject({ where: {} });
  });

  it('город отдаётся с областью', async () => {
    await service.listCities({});

    expect(prisma.city.findMany.mock.calls[0]?.[0]).toMatchObject({
      select: { regionId: true },
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

describe('область', () => {
  it('заводится в существующей стране', async () => {
    await service.createRegion({ countryId: 'country-1', name: 'Улытауская область' });

    expect(prisma.region.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { countryId: 'country-1', name: 'Улытауская область' } }),
    );
  });

  it('в несуществующую страну не заводится', async () => {
    prisma.country.findUnique.mockResolvedValue(null);

    await expect(
      service.createRegion({ countryId: 'нет', name: 'Улытауская область' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.region.create).not.toHaveBeenCalled();
  });

  it('дубликат в стране ищется без учёта регистра', async () => {
    prisma.region.findFirst.mockResolvedValue({ id: 'region-2' });

    await expect(
      service.createRegion({ countryId: 'country-1', name: 'карагандинская область' }),
    ).rejects.toMatchObject({ code: 'PLACE_ALREADY_EXISTS' });
    expect(prisma.region.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: {
        countryId: 'country-1',
        name: { equals: 'карагандинская область', mode: 'insensitive' },
      },
    });
  });

  it('переименование в занятое — PLACE_ALREADY_EXISTS', async () => {
    prisma.region.findFirst.mockResolvedValue({ id: 'region-2' });

    await expect(
      service.updateRegion('region-1', { name: 'Абайская область' }),
    ).rejects.toMatchObject({ code: 'PLACE_ALREADY_EXISTS' });
    expect(prisma.region.update).not.toHaveBeenCalled();
  });

  it('скрывается правкой, смена регистра — не дубликат', async () => {
    await service.updateRegion('region-1', { name: 'КАРАГАНДИНСКАЯ ОБЛАСТЬ', isActive: false });

    expect(prisma.region.findFirst).not.toHaveBeenCalled();
    expect(prisma.region.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'region-1' },
        data: { name: 'КАРАГАНДИНСКАЯ ОБЛАСТЬ', isActive: false },
      }),
    );
  });

  it('несуществующая — NOT_FOUND', async () => {
    prisma.region.findUnique.mockResolvedValue(null);

    await expect(service.updateRegion('нет', { isActive: false })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('город в области', () => {
  it('заводится в область своей страны', async () => {
    prisma.region.findFirst.mockResolvedValue({ id: 'region-1' });

    await service.createCity({ countryId: 'country-1', regionId: 'region-1', name: 'Темиртау' });

    expect(prisma.region.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'region-1', countryId: 'country-1' },
    });
    expect(prisma.city.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { countryId: 'country-1', regionId: 'region-1', name: 'Темиртау' },
      }),
    );
  });

  it('область другой страны или несуществующая — VALIDATION_FAILED', async () => {
    await expect(
      service.createCity({ countryId: 'country-1', regionId: 'region-uz', name: 'Темиртау' }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { fields: [{ path: 'regionId' }] },
    });
    expect(prisma.city.create).not.toHaveBeenCalled();
  });

  it('правкой переносится в область страны города', async () => {
    prisma.region.findFirst.mockResolvedValue({ id: 'region-1' });

    await service.updateCity('city-1', { regionId: 'region-1' });

    expect(prisma.region.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'region-1', countryId: 'country-1' },
    });
    expect(prisma.city.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { regionId: 'region-1' } }),
    );
  });

  it('правкой в область чужой страны не переносится', async () => {
    await expect(service.updateCity('city-1', { regionId: 'region-uz' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(prisma.city.update).not.toHaveBeenCalled();
  });

  it('null выводит из области без проверки', async () => {
    await service.updateCity('city-1', { regionId: null });

    expect(prisma.region.findFirst).not.toHaveBeenCalled();
    expect(prisma.city.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { regionId: null } }),
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
