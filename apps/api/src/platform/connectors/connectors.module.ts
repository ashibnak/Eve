import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { JobsService } from '../jobs/jobs.service';
import { ImportService } from './import.service';
import { ImportsController } from './imports.controller';

/** File connectors (ADR-011). Modules register their import targets with ImportService. */
@Global()
@Module({
  controllers: [ImportsController],
  providers: [ImportService],
  exports: [ImportService],
})
export class ConnectorsModule implements OnModuleInit {
  constructor(
    private readonly jobs: JobsService,
    private readonly imports: ImportService,
  ) {}

  onModuleInit(): void {
    // Nightly retention of discarded and abandoned imports (03:30 Tehran = 00:00 UTC).
    this.jobs.schedule({
      name: 'platform.connectors.retention',
      cron: '0 0 * * *',
      handler: () => this.imports.purgeExpired(),
    });
  }
}
