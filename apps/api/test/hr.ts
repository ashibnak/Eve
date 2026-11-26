/**
 * Test wiring for the HR pack modules together (people + org), the same way the Nest modules wire
 * them: each module reaches the other only through its own port and adapter.
 */
import { createPeople } from '../src/packs/hr/people/tests/people.harness';
import { OrgTeamAdapter } from '../src/packs/hr/people/adapters/org-team.adapter';
import { PeopleDirectoryAdapter } from '../src/packs/hr/org/adapters/people-directory.adapter';
import { OrgUnitSubtreeAdapter } from '../src/packs/hr/org/adapters/unit-subtree.adapter';
import { registerOrgScopedModels } from '../src/packs/hr/org/org.module';
import { ApplyAssignment } from '../src/packs/hr/org/commands/apply-assignment';
import { ChangeRequests } from '../src/packs/hr/org/commands/change-requests';
import { OrgCorrections } from '../src/packs/hr/org/commands/corrections';
import { StructureWriter } from '../src/packs/hr/org/commands/structure-writer';
import { OrgEventSink } from '../src/packs/hr/org/events/org-event-sink';
import { ORG_EVENTS } from '../src/packs/hr/org/events/org.events';
import { StructureImport } from '../src/packs/hr/org/import/structure.import-target';
import {
  OrgChangeApproverRole,
  OrgDataOwnerRole,
  OrgPermissions,
} from '../src/packs/hr/org/org.permissions';
import { OrgProfileService } from '../src/packs/hr/org/profile/profile.service';
import { FindingsCommands } from '../src/packs/hr/org/findings/findings.commands';
import { FindingsService } from '../src/packs/hr/org/findings/findings.service';
import { OrgRuleRunner } from '../src/packs/hr/org/findings/rule-runner';
import { OrgRuleChecker } from '../src/packs/hr/org/rules/org-rule-checker';
import { ORG_RULE_TEMPLATES } from '../src/packs/hr/org/rules/index';
import { OrgService } from '../src/packs/hr/org/service/org.service';
import type { INestApplicationContext } from '@nestjs/common';
import { PrismaService } from '../src/platform/db/prisma.service';
import type { Platform } from './platform';

export function createHr(platform: Platform) {
  // Each side reaches the other lazily, as the Nest providers do (org is defined just below).
  const people = createPeople(platform, new OrgTeamAdapter(() => org));
  registerOrgScopedModels();
  if (!platform.roles.has(OrgDataOwnerRole.name)) {
    platform.roles.register(OrgDataOwnerRole, OrgChangeApproverRole);
  }
  platform.roles.extend('auditor', [OrgPermissions.read]);
  platform.roles.extend('system_admin', [OrgPermissions.manageCompany]);
  platform.eventRegistry.register(...ORG_EVENTS);
  platform.unitSubtree.use(new OrgUnitSubtreeAdapter(platform.scopedDb));
  const directory = new PeopleDirectoryAdapter(() => people.service);
  const org = new OrgService(
    platform.scopedDb,
    platform.access,
    platform.config,
    platform.clock,
    directory,
  );
  platform.rules.register(...ORG_RULE_TEMPLATES);
  const rules = {
    runner: new OrgRuleRunner(
      platform.scopedDb,
      platform.access,
      platform.txRunner,
      platform.audit,
      platform.ruleRuntime,
      platform.config,
      platform.clock,
      directory,
    ),
    checker: new OrgRuleChecker(platform.ruleRuntime),
    findings: new FindingsService(platform.scopedDb),
    commands: new FindingsCommands(
      platform.scopedDb,
      platform.access,
      platform.txRunner,
      platform.audit,
      platform.clock,
    ),
  };
  const eventSink = new OrgEventSink(
    platform.events,
    platform.eventRegistry,
    platform.scopedDb,
    platform.txRunner,
    platform.config,
    platform.clock,
  );
  const structureImport = new StructureImport(
    platform.scopedDb,
    platform.audit,
    platform.ruleRuntime,
    eventSink,
    platform.clock,
    directory,
  );
  platform.imports.registerTarget(structureImport.target());
  const profiles = new OrgProfileService(
    platform.scopedDb,
    platform.access,
    platform.txRunner,
    platform.audit,
    platform.jurisdictions,
    platform.clock,
  );
  const writer = new StructureWriter(platform.audit, eventSink, platform.clock);
  const changeRequests = new ChangeRequests(
    platform.scopedDb,
    platform.access,
    platform.txRunner,
    platform.audit,
    platform.approvals,
    platform.ruleRuntime,
    rules.checker,
    writer,
    eventSink,
    platform.clock,
    directory,
  );
  platform.approvalTypes.register(changeRequests.requestType());
  const corrections = new OrgCorrections(
    platform.scopedDb,
    platform.access,
    platform.txRunner,
    platform.audit,
    rules.checker,
    directory,
  );
  const applyAssignment = new ApplyAssignment(
    platform.scopedDb,
    platform.txRunner,
    platform.audit,
    platform.approvals,
    rules.checker,
    eventSink,
    platform.clock,
    directory,
  );
  return {
    people,
    org,
    rules,
    eventSink,
    profiles,
    changeRequests,
    corrections,
    applyAssignment,
  };
}

/** The real app's database client, for seeding fixtures in HTTP tests (packs cannot import it). */
export function appPrisma(app: INestApplicationContext): Pick<Platform, 'prisma'> {
  return { prisma: app.get(PrismaService) };
}
