import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { GuidesController } from './guides.controller.js';
import { GuidesService } from './guides.service.js';

@Module({
  imports: [AuthModule],
  controllers: [GuidesController],
  providers: [GuidesService],
})
export class GuidesModule {}
