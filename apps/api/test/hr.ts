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
  const org = new OrgService(
    platform.scopedDb,
    platform.access,
    platform.config,
    platform.clock,
    new PeopleDirectoryAdapter(() => people.service),
  );
  return { people, org };
}

/** The real app's database client, for seeding fixtures in HTTP tests (packs cannot import it). */
export function appPrisma(app: INestApplicationContext): Pick<Platform, 'prisma'> {
  return { prisma: app.get(PrismaService) };
}
