import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { ApprovalTypeRegistry } from '../approvals/request-types';
import { AuditService } from '../audit/audit.service';
import { EventRegistry } from '../events/event-registry';
import { EventPublisher } from '../events/event-publisher';
import { ParamVersionsService } from './param-versions.service';
import { RuleParamsChanged, ruleParamsChangeType } from './rule-params.request';
import { RuleRegistry } from './rule-registry';
import { RuleRuntime } from './rule-runtime';
import { RulesController } from './rules.controller';

/** The rules engine. Packs register their templates in the RuleRegistry (org R1-R15 in S6). */
@Global()
@Module({
  controllers: [RulesController],
  providers: [RuleRegistry, ParamVersionsService, RuleRuntime],
  exports: [RuleRegistry, ParamVersionsService, RuleRuntime],
})
export class RulesModule implements OnModuleInit {
  constructor(
    private readonly rules: RuleRegistry,
    private readonly params: ParamVersionsService,
    private readonly approvalTypes: ApprovalTypeRegistry,
    private readonly audit: AuditService,
    private readonly events: EventPublisher,
    private readonly eventRegistry: EventRegistry,
  ) {}

  onModuleInit(): void {
    this.eventRegistry.register(RuleParamsChanged);
    this.approvalTypes.register(
      ruleParamsChangeType({
        rules: this.rules,
        params: this.params,
        audit: this.audit,
        events: this.events,
      }),
    );
  }
}
