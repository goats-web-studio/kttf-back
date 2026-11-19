import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  createCitySchema,
  createCountrySchema,
  createRegionSchema,
  listCitiesSchema,
  listRegionsSchema,
  updateCitySchema,
  updateCountrySchema,
  updateRegionSchema,
  type CityView,
  type CountryView,
  type CreateCityInput,
  type CreateCountryInput,
  type CreateRegionInput,
  type ListCitiesQuery,
  type ListRegionsQuery,
  type RegionView,
  type UpdateCityInput,
  type UpdateCountryInput,
  type UpdateRegionInput,
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

  /** Области — ADR-096: фильтры выбирают область целиком. */
  @Get('regions')
  async regions(
    @Query(new ZodValidationPipe(listRegionsSchema)) query: ListRegionsQuery,
  ): Promise<RegionView[]> {
    return this.places.listRegions(query);
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

  @Get('regions')
  async regions(
    @Query(new ZodValidationPipe(listRegionsSchema)) query: ListRegionsQuery,
  ): Promise<RegionView[]> {
    return this.places.listRegions(query, true);
  }

  @Post('regions')
  async createRegion(
    @Body(new ZodValidationPipe(createRegionSchema)) body: CreateRegionInput,
  ): Promise<RegionView> {
    return this.places.createRegion(body);
  }

  @Patch('regions/:id')
  async updateRegion(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(updateRegionSchema)) body: UpdateRegionInput,
  ): Promise<RegionView> {
    return this.places.updateRegion(id, body);
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
