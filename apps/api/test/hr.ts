/**
 * Test wiring for the HR pack modules together (people + org), the same way the Nest modules wire
 * them: each module reaches the other only through its own port and adapter.
 */
import { createPeople } from '../src/packs/hr/people/tests/people.harness';
import { OrgTeamAdapter } from '../src/packs/hr/people/adapters/org-team.adapter';
import { PeopleDirectoryAdapter } from '../src/packs/hr/org/adapters/people-directory.adapter';
import { OrgUnitSubtreeAdapter } from '../src/packs/hr/org/adapters/unit-subtree.adapter';
import { registerOrgScopedModels } from '../src/packs/hr/org/org.module';
import { OrgDataOwnerRole, OrgPermissions } from '../src/packs/hr/org/org.permissions';
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
  if (!platform.roles.has(OrgDataOwnerRole.name)) platform.roles.register(OrgDataOwnerRole);
  platform.roles.extend('auditor', [OrgPermissions.read]);
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
  return { people, org, rules };
}

/** The real app's database client, for seeding fixtures in HTTP tests (packs cannot import it). */
export function appPrisma(app: INestApplicationContext): Pick<Platform, 'prisma'> {
  return { prisma: app.get(PrismaService) };
}
