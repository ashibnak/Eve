import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { UsageController } from './usage.controller';
import { UsageInterceptor } from './usage.interceptor';
import { UsageService } from './usage.service';

@Global()
@Module({
  controllers: [UsageController],
  providers: [UsageService, { provide: APP_INTERCEPTOR, useClass: UsageInterceptor }],
  exports: [UsageService],
})
export class UsageModule {}
