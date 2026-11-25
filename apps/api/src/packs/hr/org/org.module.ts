import { Module, type OnModuleInit } from '@nestjs/common';
import { RoleRegistry } from '../../../platform/auth/roles';
import { JobsService } from '../../../platform/jobs/jobs.service';
import { RuleRegistry } from '../../../platform/rules/rule-registry';
import { ScopedDb } from '../../../platform/scope/scoped-db';
import { registerScopedModel } from '../../../platform/scope/scoped-prisma';
import { UnitSubtreeRegistry } from '../../../platform/scope/unit-subtree.registry';
import { peopleDirectoryProvider } from './adapters/people-directory.adapter';
import { OrgUnitSubtreeAdapter } from './adapters/unit-subtree.adapter';
import { FindingsCommands } from './findings/findings.commands';
import { FindingsController } from './findings/findings.controller';
import { FindingsService } from './findings/findings.service';
import { OrgRuleRunner } from './findings/rule-runner';
import { OrgController } from './org.controller';
import { OrgDataOwnerRole, OrgPermissions } from './org.permissions';
import { OrgRuleChecker } from './rules/org-rule-checker';
import { ORG_RULE_TEMPLATES } from './rules/index';
import { OrgService } from './service/org.service';

/** Registers org's tables with the scope layer (version tables also by unit, for unit grants). */
export function registerOrgScopedModels(): void {
  registerScopedModel('OrgCompany', { companyField: 'companyId' });
  registerScopedModel('OrgUnitLevel', { companyField: 'companyId' });
  registerScopedModel('OrgUnit', { companyField: 'companyId' });
  registerScopedModel('OrgUnitVersion', { companyField: 'companyId', unitField: 'unitId' });
  registerScopedModel('OrgPosition', { companyField: 'companyId' });
  registerScopedModel('OrgPositionVersion', { companyField: 'companyId', unitField: 'unitId' });
  registerScopedModel('OrgReportingLine', { companyField: 'companyId' });
  registerScopedModel('OrgAssignment', { companyField: 'companyId' });
  registerScopedModel('OrgRuleRun', { companyField: 'companyId' });
  registerScopedModel('OrgFinding', { companyField: 'companyId' });
}

/**
 * org (Module 1): the temporal structure, its read services and its consistency rules with the
 * findings inbox. Owns the org_* tables.
 */
@Module({
  controllers: [OrgController, FindingsController],
  providers: [
    OrgService,
    peopleDirectoryProvider,
    OrgRuleRunner,
    OrgRuleChecker,
    FindingsService,
    FindingsCommands,
  ],
  exports: [OrgService],
})
export class OrgModule implements OnModuleInit {
  constructor(
    private readonly roles: RoleRegistry,
    private readonly db: ScopedDb,
    private readonly unitSubtree: UnitSubtreeRegistry,
    private readonly rules: RuleRegistry,
    private readonly jobs: JobsService,
    private readonly runner: OrgRuleRunner,
  ) {}

  onModuleInit(): void {
    registerOrgScopedModels();
    this.roles.register(OrgDataOwnerRole);
    // Spec §2: auditors read everything, the structure included.
    this.roles.extend('auditor', [OrgPermissions.read]);
    this.unitSubtree.use(new OrgUnitSubtreeAdapter(this.db));
    // Spec §5: R1-R15 (R8, R9 come with payroll sync and grading: decision 2026-11-25).
    this.rules.register(...ORG_RULE_TEMPLATES);
    // Nightly, as of the customer's today: 22:30 UTC is 02:00 in Tehran.
    this.jobs.schedule({
      name: 'org.rules.nightly',
      cron: '30 22 * * *',
      handler: () => this.runner.runNightly(),
    });
  }
}
