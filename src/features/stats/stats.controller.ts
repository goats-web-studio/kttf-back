import {
  homeStatsQuerySchema,
  type HomeLeaders,
  type HomePodiums,
  type HomeStatsQuery,
  type HomeUpsets,
} from '@kttf/shared/types';
import { Controller, Get, Query } from '@nestjs/common';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { HomeStatsService } from './home-stats.service.js';

/** Живые блоки главной — ADR-071. Публичные: главную смотрит и гость. */
@Controller('stats')
export class StatsController {
  constructor(private readonly home: HomeStatsService) {}

  /** «Последние результаты турниров» с призёрами. */
  @Get('podiums')
  async podiums(): Promise<HomePodiums> {
    return this.home.podiums();
  }

  /** «Статистика»: больше всех турниров и побед за период. */
  @Get('leaders')
  async leaders(
    @Query(new ZodValidationPipe(homeStatsQuerySchema)) query: HomeStatsQuery,
  ): Promise<HomeLeaders> {
    return this.home.leaders(query.period);
  }

  /** «Лучшие победы» — слабый по рейтингу обыграл сильного. */
  @Get('upsets')
  async upsets(
    @Query(new ZodValidationPipe(homeStatsQuerySchema)) query: HomeStatsQuery,
  ): Promise<HomeUpsets> {
    return this.home.upsets(query.period);
  }
}
