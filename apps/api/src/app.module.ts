import { Module } from '@nestjs/common';
import { DbModule } from './platform/db/db.module';
import { HealthModule } from './platform/health/health.module';
import { LoggingModule } from './platform/logging/logging.module';

@Module({
  imports: [LoggingModule, DbModule, HealthModule],
})
export class AppModule {}
