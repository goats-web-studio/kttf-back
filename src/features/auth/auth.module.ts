import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';

import { ENV, type Env } from '../../infra/config/env.js';
import { AdminGuard } from './admin.guard.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { LastSeenInterceptor } from './last-seen.interceptor.js';
import { LastSeenService } from './last-seen.service.js';
import { OptionalJwtGuard } from './optional-jwt.guard.js';
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
    OptionalJwtGuard,
    AdminGuard,
    LastSeenService,
    // Глобально: посещение отмечается на любом маршруте с токеном (ADR-050).
    { provide: APP_INTERCEPTOR, useClass: LastSeenInterceptor },
  ],
  exports: [TokenService, JwtAuthGuard, OptionalJwtGuard, AdminGuard],
})
export class AuthModule {}
