import { Module } from '@nestjs/common';
import { jurisdiction as ir } from '@eve/jurisdiction-ir';
import { ApprovalsModule } from './platform/approvals/approvals.module';
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
import { JurisdictionModule } from './platform/jurisdiction/jurisdiction.module';
import { LoggingModule } from './platform/logging/logging.module';
import { RulesModule } from './platform/rules/rules.module';
import { ScopeModule } from './platform/scope/scope.module';
import { UsageModule } from './platform/usage/usage.module';

@Module({
  imports: [
    LoggingModule,
    DbModule,
    ContextModule,
    AuditModule,
    JobsModule,
    EventsModule,
    PlatformConfigModule,
    // R1 ships the Iran pack only; more countries are more packs (ADR-010).
    JurisdictionModule.forRoot([ir]),
    CompanyModule,
    ChannelsModule,
    ScopeModule,
    AuthModule,
    ApprovalsModule,
    RulesModule,
    UsageModule,
    HealthModule,
  ],
})
export class AppModule {}
