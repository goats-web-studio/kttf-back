import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { ENV, type Env } from '../../infra/config/env.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
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
  providers: [AuthService, TokenService, JwtAuthGuard, OptionalJwtGuard],
  exports: [TokenService, JwtAuthGuard, OptionalJwtGuard],
})
export class AuthModule {}
