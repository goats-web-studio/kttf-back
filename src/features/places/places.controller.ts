import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  createCitySchema,
  createCountrySchema,
  listCitiesSchema,
  updateCitySchema,
  updateCountrySchema,
  type CityView,
  type CountryView,
  type CreateCityInput,
  type CreateCountryInput,
  type ListCitiesQuery,
  type UpdateCityInput,
  type UpdateCountryInput,
} from '@kttf/shared/types';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RequireAdmin } from '../auth/admin.guard.js';
import { PlacesService } from './places.service.js';

const uuidParam = z.uuid();

/**
 * Справочник для выбора — ADR-046. Открыт всем: город выбирают и при
 * регистрации, и в фильтрах публичных списков.
 *
 * Без страниц: городов в справочнике десятки, и форма выбора нужна целиком.
 */
@Controller()
export class PlacesController {
  constructor(private readonly places: PlacesService) {}

  @Get('countries')
  async countries(): Promise<CountryView[]> {
    return this.places.listCountries();
  }

  @Get('cities')
  async cities(
    @Query(new ZodValidationPipe(listCitiesSchema)) query: ListCitiesQuery,
  ): Promise<CityView[]> {
    return this.places.listCities(query);
  }
}

/** Ведение справочника — только администратор платформы (ADR-046). */
@Controller('admin')
@RequireAdmin()
export class PlacesAdminController {
  constructor(private readonly places: PlacesService) {}

  @Get('countries')
  async countries(): Promise<CountryView[]> {
    return this.places.listCountries(true);
  }

  @Post('countries')
  async createCountry(
    @Body(new ZodValidationPipe(createCountrySchema)) body: CreateCountryInput,
  ): Promise<CountryView> {
    return this.places.createCountry(body);
  }

  @Patch('countries/:id')
  async updateCountry(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(updateCountrySchema)) body: UpdateCountryInput,
  ): Promise<CountryView> {
    return this.places.updateCountry(id, body);
  }

  @Get('cities')
  async cities(
    @Query(new ZodValidationPipe(listCitiesSchema)) query: ListCitiesQuery,
  ): Promise<CityView[]> {
    return this.places.listCities(query, true);
  }

  @Post('cities')
  async createCity(
    @Body(new ZodValidationPipe(createCitySchema)) body: CreateCityInput,
  ): Promise<CityView> {
    return this.places.createCity(body);
  }

  @Patch('cities/:id')
  async updateCity(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(updateCitySchema)) body: UpdateCityInput,
  ): Promise<CityView> {
    return this.places.updateCity(id, body);
  }
}
