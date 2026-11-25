import { Module, type OnModuleInit } from '@nestjs/common';
import { RoleRegistry, SystemAdminRole } from '../../../platform/auth/roles';
import { ImportService } from '../../../platform/connectors/import.service';
import { EventRegistry } from '../../../platform/events/event-registry';
import { JobsService } from '../../../platform/jobs/jobs.service';
import { RuleRegistry } from '../../../platform/rules/rule-registry';
import { ScopedDb } from '../../../platform/scope/scoped-db';
import { registerScopedModel } from '../../../platform/scope/scoped-prisma';
import { UnitSubtreeRegistry } from '../../../platform/scope/unit-subtree.registry';
import { peopleDirectoryProvider } from './adapters/people-directory.adapter';
import { OrgUnitSubtreeAdapter } from './adapters/unit-subtree.adapter';
import { OrgEventSink } from './events/org-event-sink';
import { ORG_EVENTS } from './events/org.events';
import { FindingsCommands } from './findings/findings.commands';
import { FindingsController } from './findings/findings.controller';
import { FindingsService } from './findings/findings.service';
import { OrgRuleRunner } from './findings/rule-runner';
import { StructureImport } from './import/structure.import-target';
import { OrgController } from './org.controller';
import { OrgChangeApproverRole, OrgDataOwnerRole, OrgPermissions } from './org.permissions';
import { OrgProfileController } from './profile/profile.controller';
import { OrgProfileService } from './profile/profile.service';
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
  registerScopedModel('OrgPendingEvent', { companyField: 'companyId' });
}

/**
 * org (Module 1): the temporal structure, its read services and its consistency rules with the
 * findings inbox. Owns the org_* tables.
 */
@Module({
  controllers: [OrgController, FindingsController, OrgProfileController],
  providers: [
    OrgService,
    peopleDirectoryProvider,
    OrgRuleRunner,
    OrgRuleChecker,
    FindingsService,
    FindingsCommands,
    OrgEventSink,
    OrgProfileService,
    StructureImport,
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
    private readonly eventRegistry: EventRegistry,
    private readonly eventSink: OrgEventSink,
    private readonly imports: ImportService,
    private readonly structureImport: StructureImport,
  ) {}

  onModuleInit(): void {
    registerOrgScopedModels();
    this.roles.register(OrgDataOwnerRole, OrgChangeApproverRole);
    // Spec §2: the system administrator sets up each company's profile and unit levels.
    this.roles.extend(SystemAdminRole.name, [OrgPermissions.manageCompany]);
    this.eventRegistry.register(...ORG_EVENTS);
    this.imports.registerTarget(this.structureImport.target());
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
    // Events of changes whose effective date has come (21:00 UTC = 00:30 Tehran).
    this.jobs.schedule({
      name: 'org.events.due',
      cron: '0 21 * * *',
      handler: () => this.eventSink.publishDue(),
    });
  }
}
