import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { ENV, type Env } from '../../infra/config/env.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { CODE_SENDER } from './code-sender.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { LogCodeSender } from './log-code-sender.js';
import { TokenService } from './token.service.js';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({ secret: env.JWT_SECRET }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    JwtAuthGuard,
    // Пока провайдера SMS нет, код уходит в лог (ОВ-9). Подключение
    // настоящего провайдера — замена одной этой строки.
    { provide: CODE_SENDER, useClass: LogCodeSender },
  ],
  exports: [TokenService, JwtAuthGuard],
})
export class AuthModule {}
