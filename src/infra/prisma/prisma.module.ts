import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service.js';

/**
 * Доступ к базе. Модуль глобальный: соединение одно на приложение, и заводить
 * его в каждом доменном модуле заново незачем.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
