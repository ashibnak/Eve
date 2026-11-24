import { Global, Module } from '@nestjs/common';
import { ApprovalService } from './approval.service';
import { ApprovalsController } from './approvals.controller';
import { ApprovalTypeRegistry } from './request-types';

@Global()
@Module({
  controllers: [ApprovalsController],
  providers: [ApprovalTypeRegistry, ApprovalService],
  exports: [ApprovalTypeRegistry, ApprovalService],
})
export class ApprovalsModule {}
