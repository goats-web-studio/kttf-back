import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import type {
  CityView,
  CountryView,
  CreateCityInput,
  CreateCountryInput,
  ListCitiesQuery,
  UpdateCityInput,
  UpdateCountryInput,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { defined } from '../../common/objects.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';

const countryFields = {
  id: true,
  code: true,
  name: true,
  nameKk: true,
  sortOrder: true,
  isActive: true,
} as const;

const cityFields = {
  id: true,
  countryId: true,
  name: true,
  nameKk: true,
  sortOrder: true,
  isActive: true,
} as const;

/** Столицы впереди по заданному порядку, дальше по алфавиту. */
const byOrder = [{ sortOrder: 'asc' as const }, { name: 'asc' as const }];

/** Город, который можно выбрать: не скрыт сам и не скрыта его страна. */
const available = { isActive: true, country: { isActive: true } } as const;

/**
 * Справочник стран и городов — ADR-046.
 *
 * Открытая часть отдаёт только доступное для выбора, полная — со скрытым —
 * нужна администратору. Удаления нет: на город ссылаются клубы и игроки.
 */
@Injectable()
export class PlacesService {
  constructor(private readonly prisma: PrismaService) {}

  async listCountries(withHidden = false): Promise<CountryView[]> {
    return this.prisma.country.findMany({
      where: withHidden ? {} : { isActive: true },
      select: countryFields,
      orderBy: byOrder,
    });
  }

  async listCities(query: ListCitiesQuery, withHidden = false): Promise<CityView[]> {
    return this.prisma.city.findMany({
      where: {
        ...(query.countryId === undefined ? {} : { countryId: query.countryId }),
        ...(withHidden ? {} : available),
      },
      select: cityFields,
      orderBy: byOrder,
    });
  }

  async createCountry(input: CreateCountryInput): Promise<CountryView> {
    await this.assertCodeFree(input.code);

    return this.prisma.country.create({ data: defined(input), select: countryFields });
  }

  async updateCountry(id: string, input: UpdateCountryInput): Promise<CountryView> {
    const country = await this.findCountry(id);

    if (input.code !== undefined && input.code !== country.code) {
      await this.assertCodeFree(input.code);
    }

    return this.prisma.country.update({
      where: { id },
      data: defined(input),
      select: countryFields,
    });
  }

  async createCity(input: CreateCityInput): Promise<CityView> {
    await this.findCountry(input.countryId);
    await this.assertNameFree(input.countryId, input.name);

    return this.prisma.city.create({ data: defined(input), select: cityFields });
  }

  async updateCity(id: string, input: UpdateCityInput): Promise<CityView> {
    const city = await this.prisma.city.findUnique({ where: { id }, select: cityFields });

    if (city === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'City not found', { id });
    }

    // Смена регистра в своём же названии — не дубликат: «алматы» → «Алматы».
    if (input.name !== undefined && input.name.toLowerCase() !== city.name.toLowerCase()) {
      await this.assertNameFree(city.countryId, input.name);
    }

    return this.prisma.city.update({ where: { id }, data: defined(input), select: cityFields });
  }

  /**
   * Город можно записать клубу или игроку.
   *
   * `current` — город, который уже указан: скрытый город остаётся у тех,
   * у кого он был, и повторная отправка той же формы не должна падать.
   */
  async assertCityAvailable(cityId: string | undefined, current?: string): Promise<void> {
    if (cityId === undefined || cityId === current) return;

    const city = await this.prisma.city.findFirst({
      where: { id: cityId, ...available },
      select: { id: true },
    });

    if (city === null) {
      throw new AppError(ERROR_CODES.CITY_UNAVAILABLE, 'City is unknown or hidden', { cityId });
    }
  }

  private async findCountry(id: string): Promise<CountryView> {
    const country = await this.prisma.country.findUnique({ where: { id }, select: countryFields });

    if (country === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Country not found', { id });
    }

    return country;
  }

  private async assertCodeFree(code: string): Promise<void> {
    const taken = await this.prisma.country.findUnique({ where: { code }, select: { id: true } });

    if (taken !== null) {
      throw new AppError(ERROR_CODES.PLACE_ALREADY_EXISTS, 'Country code already taken', {
        field: 'code',
      });
    }
  }

  /**
   * Без учёта регистра: «Алматы» и «алматы» в одной стране — ровно тот
   * разнобой, от которого справочник избавляет. Уникальный индекс в базе
   * регистр различает, поэтому проверка здесь.
   */
  private async assertNameFree(countryId: string, name: string): Promise<void> {
    const taken = await this.prisma.city.findFirst({
      where: { countryId, name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });

    if (taken !== null) {
      throw new AppError(ERROR_CODES.PLACE_ALREADY_EXISTS, 'City already exists in this country', {
        field: 'name',
      });
    }
  }
}
