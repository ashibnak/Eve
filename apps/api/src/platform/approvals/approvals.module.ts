import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { JobsService } from '../jobs/jobs.service';
import { ApprovalService } from './approval.service';
import { ApprovalsController } from './approvals.controller';
import { ApprovalTypeRegistry } from './request-types';

@Global()
@Module({
  controllers: [ApprovalsController],
  providers: [ApprovalTypeRegistry, ApprovalService],
  exports: [ApprovalTypeRegistry, ApprovalService],
})
export class ApprovalsModule implements OnModuleInit {
  constructor(
    private readonly jobs: JobsService,
    private readonly approvals: ApprovalService,
  ) {}

  onModuleInit(): void {
    // Nightly expiry of requests whose effective date passed while waiting (00:15 UTC).
    this.jobs.schedule({
      name: 'platform.approvals.expiry',
      cron: '15 0 * * *',
      handler: () => this.approvals.expireDue(),
    });
  }
}
