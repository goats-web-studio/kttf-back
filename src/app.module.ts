import { Module } from '@nestjs/common';

import { AuthModule } from './features/auth/auth.module.js';
import { HealthModule } from './features/health/health.module.js';
import { ConfigModule } from './infra/config/config.module.js';
import { PrismaModule } from './infra/prisma/prisma.module.js';

/**
 * Корневой модуль.
 *
 * Структура по функциям, а не по типам файлов (бриф 3.2): `features/*` —
 * предметные области, `infra/*` — то, чем они пользуются, `common/*` — то,
 * что применяется ко всем запросам одинаково.
 */
@Module({
  imports: [ConfigModule, PrismaModule, AuthModule, HealthModule],
})
export class AppModule {}
