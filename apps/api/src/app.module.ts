import { Module } from '@nestjs/common';
import { AuditModule } from './platform/audit/audit.module';
import { AuthModule } from './platform/auth/auth.module';
import { ChannelsModule } from './platform/channels/channels.module';
import { CompanyModule } from './platform/company/company.module';
import { PlatformConfigModule } from './platform/config/config.module';
import { ContextModule } from './platform/context/context.module';
import { DbModule } from './platform/db/db.module';
import { EventsModule } from './platform/events/events.module';
import { HealthModule } from './platform/health/health.module';
import { JobsModule } from './platform/jobs/jobs.module';
import { LoggingModule } from './platform/logging/logging.module';
import { ScopeModule } from './platform/scope/scope.module';

@Module({
  imports: [
    LoggingModule,
    DbModule,
    ContextModule,
    AuditModule,
    JobsModule,
    EventsModule,
    PlatformConfigModule,
    CompanyModule,
    ChannelsModule,
    ScopeModule,
    AuthModule,
    HealthModule,
  ],
})
export class AppModule {}
