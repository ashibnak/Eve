import { Module, type OnModuleInit } from '@nestjs/common';
import { RoleRegistry } from '../../../platform/auth/roles';
import { ScopedDb } from '../../../platform/scope/scoped-db';
import { registerScopedModel } from '../../../platform/scope/scoped-prisma';
import { UnitSubtreeRegistry } from '../../../platform/scope/unit-subtree.registry';
import { peopleDirectoryProvider } from './adapters/people-directory.adapter';
import { OrgUnitSubtreeAdapter } from './adapters/unit-subtree.adapter';
import { OrgController } from './org.controller';
import { OrgDataOwnerRole, OrgPermissions } from './org.permissions';
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
}

/** org (Module 1): the temporal structure and its read services. Owns the org_* tables. */
@Module({
  controllers: [OrgController],
  providers: [OrgService, peopleDirectoryProvider],
  exports: [OrgService],
})
export class OrgModule implements OnModuleInit {
  constructor(
    private readonly roles: RoleRegistry,
    private readonly db: ScopedDb,
    private readonly unitSubtree: UnitSubtreeRegistry,
  ) {}

  onModuleInit(): void {
    registerOrgScopedModels();
    this.roles.register(OrgDataOwnerRole);
    // Spec §2: auditors read everything, the structure included.
    this.roles.extend('auditor', [OrgPermissions.read]);
    this.unitSubtree.use(new OrgUnitSubtreeAdapter(this.db));
  }
}
