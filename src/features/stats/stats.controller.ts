import {
  homeStatsQuerySchema,
  type HomeLeaders,
  type HomePodiums,
  type HomeStatsQuery,
  type HomeUpsets,
} from '@kttf/shared/types';
import { Controller, Get, Query } from '@nestjs/common';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { TtlCache } from '../../common/ttl-cache.js';
import { HomeStatsService } from './home-stats.service.js';

/**
 * Срок живых блоков главной — ADR-132.
 *
 * Они одинаковы для всех и считаются агрегатами по всем встречам; меняются,
 * только когда завершается турнир или засчитывается дуэль. Минута отставания
 * после этого незаметна, а без кэша каждый заход на главную пересчитывал всё.
 */
export const HOME_STATS_TTL_MS = 60_000;

/** Живые блоки главной — ADR-071. Публичные: главную смотрит и гость. */
@Controller('stats')
export class StatsController {
  private readonly podiumsCache = new TtlCache<HomePodiums>(HOME_STATS_TTL_MS);
  private readonly leadersCache = new TtlCache<HomeLeaders>(HOME_STATS_TTL_MS);
  private readonly upsetsCache = new TtlCache<HomeUpsets>(HOME_STATS_TTL_MS);

  constructor(private readonly home: HomeStatsService) {}

  /** «Последние результаты турниров» с призёрами. */
  @Get('podiums')
  async podiums(): Promise<HomePodiums> {
    return this.podiumsCache.get('all', () => this.home.podiums());
  }

  /** «Статистика»: больше всех турниров и побед за период. */
  @Get('leaders')
  async leaders(
    @Query(new ZodValidationPipe(homeStatsQuerySchema)) query: HomeStatsQuery,
  ): Promise<HomeLeaders> {
    return this.leadersCache.get(query.period, () => this.home.leaders(query.period));
  }

  /** «Лучшие победы» — слабый по рейтингу обыграл сильного. */
  @Get('upsets')
  async upsets(
    @Query(new ZodValidationPipe(homeStatsQuerySchema)) query: HomeStatsQuery,
  ): Promise<HomeUpsets> {
    return this.upsetsCache.get(query.period, () => this.home.upsets(query.period));
  }
}
